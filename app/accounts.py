"""Личный кабинет: регистрация, вход и сохранённые наборы билетов.

Данные хранятся в SQLite (путь задаётся переменной окружения DB_PATH,
по умолчанию data/creatortecets.db). Пароли хешируются scrypt, сессия —
случайный токен в cookie (HttpOnly, SameSite=Lax); в базе хранится только
хеш токена.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, ValidationError

from .common import BASE_DIR, DOCX_MIME, ExportPayload, disposition, load_template, read_upload, render

router = APIRouter(prefix="/api")

COOKIE = "ct_session"
SESSION_DAYS = 30
MAX_SET_JSON = 5 * 1024 * 1024
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_db_lock = threading.Lock()
_initialized: set[str] = set()


def db_path() -> Path:
    return Path(os.environ.get("DB_PATH") or BASE_DIR.parent / "data" / "creatortecets.db")


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    data TEXT NOT NULL,
    ticket_count INTEGER NOT NULL DEFAULT 0,
    template BLOB,
    template_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sets_user ON ticket_sets(user_id, updated_at);
"""


@contextmanager
def connect():
    path = db_path()
    key = str(path)
    if key not in _initialized:
        with _db_lock:
            if key not in _initialized:
                path.parent.mkdir(parents=True, exist_ok=True)
                with sqlite3.connect(path) as con:
                    con.execute("PRAGMA journal_mode=WAL")
                    con.executescript(SCHEMA)
                _initialized.add(key)
    con = sqlite3.connect(path, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# Пароли и сессии
# --------------------------------------------------------------------------- #


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), digest_hex)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(response: Response, request: Request, user_id: int) -> None:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    with connect() as con:
        con.execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
        con.execute(
            "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (_token_hash(token), user_id, expires.isoformat(timespec="seconds")),
        )
    response.set_cookie(
        COOKIE,
        token,
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


def current_user(request: Request) -> dict | None:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    with connect() as con:
        row = con.execute(
            "SELECT u.id, u.email, u.name, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND s.expires_at > ?",
            (_token_hash(token), now()),
        ).fetchone()
    return dict(row) if row else None


def require_user(request: Request) -> dict:
    user = current_user(request)
    if user is None:
        raise HTTPException(401, "Войдите в личный кабинет.")
    return user


# Простая защита от перебора паролей: не более 10 неудачных попыток за 15 минут.
_failures: dict[str, list[float]] = {}


def _check_throttle(key: str) -> None:
    window = time.time() - 900
    attempts = [t for t in _failures.get(key, []) if t > window]
    _failures[key] = attempts
    if len(attempts) >= 10:
        raise HTTPException(429, "Слишком много попыток входа. Попробуйте через 15 минут.")


# --------------------------------------------------------------------------- #
# Регистрация и вход
# --------------------------------------------------------------------------- #


class RegisterIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)
    name: str = Field(default="", max_length=100)


class LoginIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)


def _public(user: dict) -> dict:
    return {"id": user["id"], "email": user["email"], "name": user["name"], "createdAt": user["created_at"]}


@router.post("/auth/register")
def register(body: RegisterIn, request: Request, response: Response) -> dict:
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, "Укажите корректный адрес электронной почты.")
    if len(body.password) < 8:
        raise HTTPException(422, "Пароль должен быть не короче 8 символов.")
    created = now()
    try:
        with connect() as con:
            cur = con.execute(
                "INSERT INTO users(email, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (email, body.name.strip(), hash_password(body.password), created),
            )
            user_id = cur.lastrowid
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "Пользователь с такой почтой уже зарегистрирован.") from exc
    start_session(response, request, user_id)
    return {"user": _public({"id": user_id, "email": email, "name": body.name.strip(), "created_at": created})}


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response) -> dict:
    email = body.email.strip().lower()
    _check_throttle(email)
    with connect() as con:
        row = con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if row is None or not verify_password(body.password, row["password_hash"]):
        _failures.setdefault(email, []).append(time.time())
        raise HTTPException(401, "Неверная почта или пароль.")
    _failures.pop(email, None)
    start_session(response, request, row["id"])
    return {"user": _public(dict(row))}


@router.post("/auth/logout")
def logout(request: Request, response: Response) -> dict:
    token = request.cookies.get(COOKIE)
    if token:
        with connect() as con:
            con.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/auth/me")
def me(request: Request) -> dict:
    user = current_user(request)
    return {"user": _public(user) if user else None}


# --------------------------------------------------------------------------- #
# Сохранённые наборы билетов
# --------------------------------------------------------------------------- #


class SetIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    data: dict


class RenameIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)


def _parse_set(payload: str) -> tuple[SetIn, str, int]:
    if len(payload) > MAX_SET_JSON:
        raise HTTPException(413, "Слишком большой набор билетов.")
    try:
        body = SetIn.model_validate(json.loads(payload))
        tickets = ExportPayload.model_validate(
            {"tickets": body.data.get("tickets"), "fields": body.data.get("fields") or {}}
        ).tickets
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(422, f"Некорректные данные набора: {exc}") from exc
    return body, json.dumps(body.data, ensure_ascii=False), len(tickets)


def _summary(row: sqlite3.Row) -> dict:
    data = json.loads(row["data"])
    params = data.get("params") or {}
    return {
        "id": row["id"],
        "title": row["title"],
        "ticketCount": row["ticket_count"],
        "theoryPer": params.get("theory"),
        "practicePer": params.get("practice"),
        "fields": data.get("fields") or {},
        "templateName": row["template_name"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _get_set(con: sqlite3.Connection, set_id: int, user: dict) -> sqlite3.Row:
    row = con.execute("SELECT * FROM ticket_sets WHERE id = ? AND user_id = ?", (set_id, user["id"])).fetchone()
    if row is None:
        raise HTTPException(404, "Набор билетов не найден.")
    return row


@router.get("/sets")
def list_sets(user: dict = Depends(require_user)) -> dict:
    with connect() as con:
        rows = con.execute(
            "SELECT id, title, data, ticket_count, template_name, created_at, updated_at FROM ticket_sets "
            "WHERE user_id = ? ORDER BY updated_at DESC, id DESC",
            (user["id"],),
        ).fetchall()
    return {"sets": [_summary(r) for r in rows]}


@router.post("/sets")
async def create_set(
    payload: str = Form(...),
    template: UploadFile | None = File(None),
    user: dict = Depends(require_user),
) -> dict:
    body, data_json, count = _parse_set(payload)
    tpl = await read_upload(template)
    if tpl is not None:
        load_template(tpl)  # проверка шаблона
    ts = now()
    with connect() as con:
        cur = con.execute(
            "INSERT INTO ticket_sets(user_id, title, data, ticket_count, template, template_name, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user["id"], body.title.strip(), data_json, count, tpl, template.filename if tpl else None, ts, ts),
        )
        row = _get_set(con, cur.lastrowid, user)
    return {"set": _summary(row)}


@router.put("/sets/{set_id}")
async def update_set(
    set_id: int,
    payload: str = Form(...),
    template_mode: str = Form("keep"),
    template: UploadFile | None = File(None),
    user: dict = Depends(require_user),
) -> dict:
    """template_mode: keep — оставить шаблон, replace — заменить загруженным, default — стандартный."""
    body, data_json, count = _parse_set(payload)
    tpl = await read_upload(template)
    with connect() as con:
        _get_set(con, set_id, user)
        if template_mode == "replace" and tpl is not None:
            load_template(tpl)
            con.execute(
                "UPDATE ticket_sets SET template = ?, template_name = ? WHERE id = ?", (tpl, template.filename, set_id)
            )
        elif template_mode == "default":
            con.execute("UPDATE ticket_sets SET template = NULL, template_name = NULL WHERE id = ?", (set_id,))
        con.execute(
            "UPDATE ticket_sets SET title = ?, data = ?, ticket_count = ?, updated_at = ? WHERE id = ?",
            (body.title.strip(), data_json, count, now(), set_id),
        )
        row = _get_set(con, set_id, user)
    return {"set": _summary(row)}


@router.patch("/sets/{set_id}")
def rename_set(set_id: int, body: RenameIn, user: dict = Depends(require_user)) -> dict:
    with connect() as con:
        _get_set(con, set_id, user)
        con.execute("UPDATE ticket_sets SET title = ? WHERE id = ?", (body.title.strip(), set_id))
        row = _get_set(con, set_id, user)
    return {"set": _summary(row)}


@router.get("/sets/{set_id}")
def get_set(set_id: int, user: dict = Depends(require_user)) -> dict:
    with connect() as con:
        row = _get_set(con, set_id, user)
    return {"set": {**_summary(row), "data": json.loads(row["data"]), "hasTemplate": row["template"] is not None}}


@router.get("/sets/{set_id}/template")
def get_set_template(set_id: int, user: dict = Depends(require_user)) -> Response:
    with connect() as con:
        row = _get_set(con, set_id, user)
    if row["template"] is None:
        raise HTTPException(404, "Для набора используется стандартный шаблон.")
    return Response(
        row["template"], media_type=DOCX_MIME, headers={"Content-Disposition": disposition(row["template_name"] or "template.docx")}
    )


@router.delete("/sets/{set_id}")
def delete_set(set_id: int, user: dict = Depends(require_user)) -> dict:
    with connect() as con:
        _get_set(con, set_id, user)
        con.execute("DELETE FROM ticket_sets WHERE id = ?", (set_id,))
    return {"ok": True}


@router.get("/sets/{set_id}/export")
async def export_set(set_id: int, format: str = "docx", user: dict = Depends(require_user)) -> Response:
    with connect() as con:
        row = _get_set(con, set_id, user)
    data = json.loads(row["data"])
    payload = ExportPayload.model_validate(
        {
            "tickets": data.get("tickets"),
            "fields": data.get("fields") or {},
            "filename": (data.get("params") or {}).get("filename") or row["title"],
        }
    )
    return await render(row["template"], payload, format)

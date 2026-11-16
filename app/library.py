"""Отправка пользовательских шаблонов на сайт, модерация и библиотека шаблонов."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .accounts import connect, now, require_admin, require_user
from .common import DOCX_MIME, disposition, load_template, read_upload

router = APIRouter(prefix="/api")

MAX_PENDING_PER_USER = 20
STATUSES = ("pending", "approved", "rejected", "removed")
STATUS_RU = {"pending": "на проверке", "approved": "опубликован", "rejected": "отклонён", "removed": "снят с публикации"}


def _clean(text: str, limit: int) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:limit]


def _row(r, admin: bool = False) -> dict:
    d = {
        "id": r["id"],
        "title": r["title"],
        "institution": r["institution"],
        "description": r["description"],
        "filename": r["filename"],
        "status": r["status"],
        "statusText": STATUS_RU.get(r["status"], r["status"]),
        "note": r["admin_note"],
        "createdAt": r["created_at"],
        "reviewedAt": r["reviewed_at"],
    }
    if admin:
        d["author"] = r["author"] or "аккаунт удалён"
    return d


# ---------------------------------------------------------------- пользователь


@router.post("/templates/submissions")
async def submit_template(
    template: UploadFile = File(...),
    title: str = Form(...),
    institution: str = Form(""),
    description: str = Form(""),
    consent: bool = Form(False),
    user: dict = Depends(require_user),
) -> dict:
    if not consent:
        raise HTTPException(422, "Нужно согласие на публикацию шаблона на сайте.")
    title = _clean(title, 150)
    if not title:
        raise HTTPException(422, "Укажите название шаблона.")
    data = await read_upload(template)
    if data is None:
        raise HTTPException(422, "Выберите файл шаблона.")
    load_template(data)  # шаблон должен быть рабочим
    with connect() as con:
        pending = con.execute(
            "SELECT COUNT(*) FROM template_submissions WHERE user_id = ? AND status = 'pending'", (user["id"],)
        ).fetchone()[0]
        if pending >= MAX_PENDING_PER_USER:
            raise HTTPException(429, "Слишком много шаблонов ждут проверки. Дождитесь решения по ним.")
        cur = con.execute(
            "INSERT INTO template_submissions(user_id, title, institution, description, filename, file, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user["id"], title, _clean(institution, 200), _clean(description, 1000),
             (template.filename or "template.docx")[:200], data, now()),
        )
        row = con.execute("SELECT * FROM template_submissions WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"submission": _row(row)}


@router.get("/templates/submissions/mine")
def my_submissions(user: dict = Depends(require_user)) -> dict:
    with connect() as con:
        rows = con.execute(
            "SELECT * FROM template_submissions WHERE user_id = ? ORDER BY id DESC", (user["id"],)
        ).fetchall()
    return {"submissions": [_row(r) for r in rows]}


@router.delete("/templates/submissions/{sub_id}")
def withdraw_submission(sub_id: int, user: dict = Depends(require_user)) -> dict:
    with connect() as con:
        row = con.execute(
            "SELECT status FROM template_submissions WHERE id = ? AND user_id = ?", (sub_id, user["id"])
        ).fetchone()
        if row is None:
            raise HTTPException(404, "Шаблон не найден.")
        if row["status"] != "pending":
            raise HTTPException(409, "Отозвать можно только шаблон, который ещё на проверке.")
        con.execute("DELETE FROM template_submissions WHERE id = ?", (sub_id,))
    return {"ok": True}


# -------------------------------------------------------------- библиотека


@router.get("/templates/library")
def library() -> dict:
    with connect() as con:
        rows = con.execute(
            "SELECT * FROM template_submissions WHERE status = 'approved' ORDER BY title COLLATE NOCASE"
        ).fetchall()
    return {"templates": [_row(r) for r in rows]}


@router.get("/templates/library/{tpl_id}/file")
def library_file(tpl_id: int) -> Response:
    with connect() as con:
        row = con.execute(
            "SELECT filename, file FROM template_submissions WHERE id = ? AND status = 'approved'", (tpl_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(404, "Шаблон не найден.")
    return Response(row["file"], media_type=DOCX_MIME, headers={"Content-Disposition": disposition(row["filename"])})


# ------------------------------------------------------------------ модерация


class ReviewIn(BaseModel):
    action: str = Field(pattern="^(approve|reject|remove)$")
    title: str | None = Field(default=None, max_length=150)
    institution: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    note: str = Field(default="", max_length=500)


@router.get("/admin/submissions")
def admin_list(status: str = "pending", admin: dict = Depends(require_admin)) -> dict:
    where, args = ("", ()) if status == "all" else ("WHERE s.status = ?", (status,))
    if status != "all" and status not in STATUSES:
        raise HTTPException(400, "Неизвестный статус.")
    with connect() as con:
        rows = con.execute(
            "SELECT s.*, COALESCE(NULLIF(u.name, '') || ' · ' || u.email, u.email) AS author "
            f"FROM template_submissions s LEFT JOIN users u ON u.id = s.user_id {where} ORDER BY s.id DESC",
            args,
        ).fetchall()
        counts = dict(con.execute("SELECT status, COUNT(*) FROM template_submissions GROUP BY status").fetchall())
    return {"submissions": [_row(r, admin=True) for r in rows], "counts": counts}


@router.get("/admin/submissions/{sub_id}/file")
def admin_file(sub_id: int, admin: dict = Depends(require_admin)) -> Response:
    with connect() as con:
        row = con.execute("SELECT filename, file FROM template_submissions WHERE id = ?", (sub_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Шаблон не найден.")
    return Response(row["file"], media_type=DOCX_MIME, headers={"Content-Disposition": disposition(row["filename"])})


@router.post("/admin/submissions/{sub_id}/review")
def admin_review(sub_id: int, body: ReviewIn, admin: dict = Depends(require_admin)) -> dict:
    status = {"approve": "approved", "reject": "rejected", "remove": "removed"}[body.action]
    with connect() as con:
        row = con.execute("SELECT * FROM template_submissions WHERE id = ?", (sub_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Шаблон не найден.")
        title = _clean(body.title, 150) if body.title is not None else row["title"]
        con.execute(
            "UPDATE template_submissions SET status = ?, title = ?, institution = ?, description = ?, "
            "admin_note = ?, reviewed_at = ? WHERE id = ?",
            (
                status,
                title or row["title"],
                _clean(body.institution, 200) if body.institution is not None else row["institution"],
                _clean(body.description, 1000) if body.description is not None else row["description"],
                _clean(body.note, 500),
                now(),
                sub_id,
            ),
        )
        row = con.execute(
            "SELECT s.*, u.email AS author FROM template_submissions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?",
            (sub_id,),
        ).fetchone()
    return {"submission": _row(row, admin=True)}

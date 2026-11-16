"""CreatorTecets — веб-приложение для формирования экзаменационных билетов."""

from __future__ import annotations

import json
import os
import re

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from . import accounts, library
from . import questions as qparse
from .common import (
    DEFAULT_TEMPLATE,
    DOCX_MIME,
    STATIC_DIR,
    ExportPayload,
    disposition,
    load_template,
    read_upload,
    render,
)
from .pdf import soffice_path

app = FastAPI(title="CreatorTecets", version="1.1.0")


@app.middleware("http")
async def same_origin_guard(request: Request, call_next):
    """Защита от CSRF: изменяющие запросы принимаются только со своего сайта."""
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and origin != "null":
            host = request.headers.get("host", "")
            if origin.split("://", 1)[-1] != host:
                return JSONResponse({"detail": "Запрос с чужого сайта отклонён."}, status_code=403)
    return await call_next(request)


RTB_RE = re.compile(r"^R-A-\d+-\d+$")


def _env_block(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value if RTB_RE.match(value) else None


@app.get("/api/config")
def site_config() -> dict:
    """Настройки сайта для браузера: блоки Рекламной сети Яндекса и счётчик Метрики."""
    metrika = os.environ.get("YANDEX_METRIKA_ID", "").strip()
    return {
        "ads": {
            "sidebar": _env_block("YANDEX_RTB_SIDEBAR"),
            "bottom": _env_block("YANDEX_RTB_BOTTOM"),
        },
        "metrika": int(metrika) if metrika.isdigit() else None,
        "operator": {
            "name": os.environ.get("SITE_OPERATOR", "").strip()[:300] or None,
            "email": os.environ.get("SITE_CONTACT_EMAIL", "").strip()[:200] or None,
            "site": os.environ.get("DOMAIN", "").strip()[:200] or None,
        },
    }


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "pdf": soffice_path() is not None}


@app.post("/api/template/inspect")
async def inspect_template(template: UploadFile | None = File(None)) -> dict:
    data = await read_upload(template)
    info = load_template(data).describe()
    info["name"] = template.filename if data is not None else DEFAULT_TEMPLATE.name
    info["isDefault"] = data is None
    return info


@app.get("/api/template/default")
def default_template() -> FileResponse:
    return FileResponse(
        DEFAULT_TEMPLATE, media_type=DOCX_MIME, headers={"Content-Disposition": disposition("Шаблон билета.docx")}
    )


@app.post("/api/questions/parse")
async def parse_questions(file: UploadFile = File(...)) -> dict:
    data = await read_upload(file)
    if data is None:
        raise HTTPException(400, "Файл не выбран.")
    try:
        items = qparse.from_file(file.filename or "", data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"questions": items}


@app.post("/api/export")
async def export(
    payload: str = Form(...),
    format: str = Form("docx"),
    template: UploadFile | None = File(None),
) -> Response:
    try:
        data = ExportPayload.model_validate(json.loads(payload))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(422, f"Некорректные данные билетов: {exc}") from exc
    return await render(await read_upload(template), data, format)


app.include_router(accounts.router)
app.include_router(library.router)


@app.exception_handler(HTTPException)
async def http_error(_, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None))


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

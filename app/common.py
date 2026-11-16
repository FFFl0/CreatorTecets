"""Общие модели и помощники для маршрутов API."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .docx_template import Template, TemplateError
from .pdf import PdfError, docx_to_pdf

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR.parent / "static"
DEFAULT_TEMPLATE = BASE_DIR / "templates" / "default_template.docx"
MAX_UPLOAD = 15 * 1024 * 1024
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class Ticket(BaseModel):
    number: int = Field(ge=0, le=100000)
    theory: list[str] = Field(default_factory=list, max_length=50)
    practice: list[str] = Field(default_factory=list, max_length=50)


class ExportPayload(BaseModel):
    tickets: list[Ticket] = Field(min_length=1, max_length=1000)
    fields: dict[str, str] = Field(default_factory=dict)
    filename: str = "Экзаменационные билеты"


async def read_upload(upload: UploadFile | None) -> bytes | None:
    if upload is None or not upload.filename:
        return None
    data = await upload.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "Файл слишком большой (максимум 15 МБ).")
    return data


def load_template(data: bytes | None) -> Template:
    try:
        return Template.load(data if data is not None else DEFAULT_TEMPLATE.read_bytes())
    except TemplateError as exc:
        raise HTTPException(422, str(exc)) from exc


def safe_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", name).strip(" .") or "Экзаменационные билеты"
    return name[:120]


def disposition(filename: str, inline: bool = False) -> str:
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename).strip("_") or "tickets"
    kind = "inline" if inline else "attachment"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


async def render(template_bytes: bytes | None, payload: ExportPayload, fmt: str) -> Response:
    """Формирует билеты и отдаёт файл .docx или .pdf."""
    if fmt not in ("docx", "pdf"):
        raise HTTPException(400, "Неизвестный формат экспорта.")
    tpl = load_template(template_bytes)
    tickets = [t.model_dump() for t in payload.tickets]
    docx_bytes = await run_in_threadpool(tpl.build, tickets, payload.fields)
    name = safe_filename(payload.filename)
    if fmt == "docx":
        return Response(docx_bytes, media_type=DOCX_MIME, headers={"Content-Disposition": disposition(f"{name}.docx")})
    try:
        pdf_bytes = await run_in_threadpool(docx_to_pdf, docx_bytes)
    except PdfError as exc:
        raise HTTPException(503, str(exc)) from exc
    return Response(
        pdf_bytes, media_type="application/pdf", headers={"Content-Disposition": disposition(f"{name}.pdf", inline=True)}
    )

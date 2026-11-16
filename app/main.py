"""CreatorTecets — веб-приложение для формирования экзаменационных билетов."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import questions as qparse
from .docx_template import Template, TemplateError
from .pdf import PdfError, docx_to_pdf, soffice_path

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR.parent / "static"
DEFAULT_TEMPLATE = BASE_DIR / "templates" / "default_template.docx"
MAX_UPLOAD = 15 * 1024 * 1024

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

app = FastAPI(title="CreatorTecets", version="1.0.0")


class Ticket(BaseModel):
    number: int = Field(ge=0, le=100000)
    theory: list[str] = Field(default_factory=list, max_length=50)
    practice: list[str] = Field(default_factory=list, max_length=50)


class ExportPayload(BaseModel):
    tickets: list[Ticket] = Field(min_length=1, max_length=1000)
    fields: dict[str, str] = Field(default_factory=dict)
    filename: str = "Экзаменационные билеты"


async def _read_upload(upload: UploadFile | None) -> bytes | None:
    if upload is None or not upload.filename:
        return None
    data = await upload.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "Файл слишком большой (максимум 15 МБ).")
    return data


def _load_template(data: bytes | None) -> Template:
    try:
        return Template.load(data if data is not None else DEFAULT_TEMPLATE.read_bytes())
    except TemplateError as exc:
        raise HTTPException(422, str(exc)) from exc


def _safe_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", name).strip(" .") or "Экзаменационные билеты"
    return name[:120]


def _disposition(filename: str) -> str:
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename).strip("_") or "tickets"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "pdf": soffice_path() is not None}


@app.post("/api/template/inspect")
async def inspect_template(template: UploadFile | None = File(None)) -> dict:
    data = await _read_upload(template)
    tpl = _load_template(data)
    info = tpl.describe()
    info["name"] = template.filename if data is not None else DEFAULT_TEMPLATE.name
    info["isDefault"] = data is None
    return info


@app.get("/api/template/default")
def default_template() -> FileResponse:
    return FileResponse(
        DEFAULT_TEMPLATE,
        media_type=DOCX_MIME,
        headers={"Content-Disposition": _disposition("Шаблон билета.docx")},
    )


@app.post("/api/questions/parse")
async def parse_questions(file: UploadFile = File(...)) -> dict:
    data = await _read_upload(file)
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
    if format not in ("docx", "pdf"):
        raise HTTPException(400, "Неизвестный формат экспорта.")
    try:
        data = ExportPayload.model_validate(json.loads(payload))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(422, f"Некорректные данные билетов: {exc}") from exc

    tpl = _load_template(await _read_upload(template))
    tickets = [t.model_dump() for t in data.tickets]
    docx_bytes = await run_in_threadpool(tpl.build, tickets, data.fields)
    name = _safe_filename(data.filename)

    if format == "docx":
        return Response(
            docx_bytes,
            media_type=DOCX_MIME,
            headers={"Content-Disposition": _disposition(f"{name}.docx")},
        )
    try:
        pdf_bytes = await run_in_threadpool(docx_to_pdf, docx_bytes)
    except PdfError as exc:
        raise HTTPException(503, str(exc)) from exc
    return Response(
        pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _disposition(f"{name}.pdf").replace("attachment", "inline", 1)},
    )


@app.exception_handler(HTTPException)
async def http_error(_, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

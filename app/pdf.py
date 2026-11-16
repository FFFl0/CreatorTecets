"""Конвертация .docx в .pdf через LibreOffice в headless-режиме."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

_lock = threading.Semaphore(int(os.environ.get("PDF_CONCURRENCY", "2")))


class PdfError(RuntimeError):
    pass


_STANDARD_PATHS = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
]


def soffice_path() -> str | None:
    found = os.environ.get("SOFFICE_PATH") or shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found
    return next((p for p in _STANDARD_PATHS if os.path.isfile(p)), None)


def docx_to_pdf(data: bytes, timeout: int = 180) -> bytes:
    exe = soffice_path()
    if not exe:
        raise PdfError("LibreOffice не установлен на сервере — экспорт в PDF недоступен.")
    with _lock, tempfile.TemporaryDirectory(prefix="tickets_") as tmp:
        tmpdir = Path(tmp)
        src = tmpdir / "tickets.docx"
        src.write_bytes(data)
        # Отдельный профиль на каждый запуск: параллельные конвертации не мешают друг другу.
        profile = (tmpdir / "profile").as_uri()
        cmd = [
            exe,
            f"-env:UserInstallation={profile}",
            "--headless",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            str(tmpdir),
            str(src),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise PdfError("Превышено время конвертации в PDF.") from exc
        out = tmpdir / "tickets.pdf"
        if not out.exists():
            msg = (proc.stderr or proc.stdout or b"").decode(errors="replace")[-500:]
            raise PdfError(f"Не удалось сконвертировать документ в PDF. {msg}".strip())
        return out.read_bytes()

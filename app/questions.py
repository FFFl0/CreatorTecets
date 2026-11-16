"""Извлечение списков вопросов из загруженных файлов."""

from __future__ import annotations

import csv
import io
import re
import zipfile

from lxml import etree

from .docx_template import NS, para_text, w

# «1.», «1)», «12 -», «•», «-», «–», «*» в начале строки
NUMBERING_RE = re.compile(r"^\s*(?:(?:№\s*)?\d{1,4}\s*[.)\-:]\s*|[•\-–—*·▪●]\s+)")


def clean_line(line: str) -> str:
    line = line.replace(" ", " ").strip()
    line = NUMBERING_RE.sub("", line, count=1).strip()
    return re.sub(r"\s+", " ", line)


def split_text(text: str) -> list[str]:
    return [q for q in (clean_line(line) for line in text.splitlines()) if q]


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp1251", "utf-16"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def from_docx(data: bytes) -> list[str]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        xml = zf.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError("Не удалось прочитать документ Word.") from exc
    root = etree.fromstring(xml, etree.XMLParser(resolve_entities=False, no_network=True))
    body = root.find("w:body", NS)
    lines: list[str] = []
    for p in body.iter(w("p")):
        lines.append(para_text(p))
    return [q for q in (clean_line(x) for x in lines) if q]


def from_file(filename: str, data: bytes) -> list[str]:
    name = (filename or "").lower()
    if name.endswith(".docx"):
        return from_docx(data)
    if name.endswith(".doc"):
        raise ValueError("Старый формат .doc не поддерживается — сохраните файл как .docx.")
    text = _decode(data)
    if name.endswith(".csv"):
        rows = csv.reader(io.StringIO(text), delimiter=";" if text.count(";") > text.count(",") else ",")
        return [q for q in (clean_line(r[0]) for r in rows if r) if q]
    return split_text(text)

import io
import json
import zipfile
from pathlib import Path

import docx
import pytest
from fastapi.testclient import TestClient

from app.docx_template import Template, TemplateError
from app.main import DEFAULT_TEMPLATE, app
from app.questions import from_docx, split_text
from app.pdf import soffice_path

client = TestClient(app)


def tickets(n=3, t=2, p=2):
    return [
        {
            "number": i,
            "theory": [f"Теория {i}.{k}" for k in range(1, t + 1)],
            "practice": [f"Практика {i}.{k}" for k in range(1, p + 1)],
        }
        for i in range(1, n + 1)
    ]


def build(tks, fields=None) -> docx.Document:
    tpl = Template.load(DEFAULT_TEMPLATE.read_bytes())
    return docx.Document(io.BytesIO(tpl.build(tks, fields or {})))


def test_template_analysis():
    info = Template.load(DEFAULT_TEMPLATE.read_bytes()).describe()
    assert info["hasTheory"] and info["hasPractice"] and info["hasNumber"]
    labels = [f["label"] for f in info["fields"]]
    assert labels == ["Специальность", "Группа", "Дисциплина", "Семестр", "Разработчик"]


def test_build_numbers_questions_and_fields():
    d = build(tickets(3, 3, 1), {"Группа": "АТ-301", "Семестр": "6"})
    assert len(d.tables) == 3
    header = d.tables[2].cell(0, 1).text
    assert "Экзаменационный билет № 3" in header
    assert "Группа: АТ-301" in header and "Семестр: 6" in header
    texts = [p.text for p in d.paragraphs if p.text]
    assert texts[:4] == ["Вопрос1. Теория 1.1", "Вопрос2. Теория 1.2", "Вопрос3. Теория 1.3", "Практическое задание1. Практика 1.1"]
    assert sum(t.startswith("Вопрос") for t in texts) == 9


def test_build_keeps_package_parts_and_formatting():
    tpl_bytes = DEFAULT_TEMPLATE.read_bytes()
    out = Template.load(tpl_bytes).build(tickets(2))
    src, dst = zipfile.ZipFile(io.BytesIO(tpl_bytes)), zipfile.ZipFile(io.BytesIO(out))
    assert set(src.namelist()) == set(dst.namelist())
    for name in ("word/styles.xml", "word/header1.xml", "word/footer1.xml", "word/numbering.xml"):
        assert src.read(name) == dst.read(name)
    d = docx.Document(io.BytesIO(out))
    label = next(p for p in d.paragraphs if p.text.startswith("Вопрос1")).runs[0]
    assert label.bold and label.italic and label.underline
    # Второй билет начинается с новой страницы.
    assert b"pageBreakBefore" in dst.read("word/document.xml")


def test_template_without_markers_rejected():
    buf = io.BytesIO()
    doc = docx.Document()
    doc.add_paragraph("Просто текст")
    doc.save(buf)
    with pytest.raises(TemplateError):
        Template.load(buf.getvalue())


def test_question_parsing():
    assert split_text("1. Первый\n2) Второй\n\n- Третий\n  • Четвёртый ") == ["Первый", "Второй", "Третий", "Четвёртый"]
    buf = io.BytesIO()
    doc = docx.Document()
    for q in ("1. Альфа", "", "Бета"):
        doc.add_paragraph(q)
    doc.save(buf)
    assert from_docx(buf.getvalue()) == ["Альфа", "Бета"]


def test_api_inspect_and_export_docx():
    r = client.post("/api/template/inspect")
    assert r.status_code == 200 and r.json()["isDefault"]
    r = client.post("/api/export", data={"payload": json.dumps({"tickets": tickets(2)}), "format": "docx"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert len(docx.Document(io.BytesIO(r.content)).tables) == 2


def test_api_rejects_bad_payload():
    r = client.post("/api/export", data={"payload": json.dumps({"tickets": []}), "format": "docx"})
    assert r.status_code == 422


@pytest.mark.skipif(not soffice_path(), reason="LibreOffice не установлен")
def test_api_export_pdf():
    r = client.post("/api/export", data={"payload": json.dumps({"tickets": tickets(2)}), "format": "pdf"})
    assert r.status_code == 200 and r.content.startswith(b"%PDF")


def test_developer_in_footer_is_editable():
    tpl = Template.load(DEFAULT_TEMPLATE.read_bytes())
    fields = {f["label"]: f["value"] for f in tpl.fields()}
    assert fields["Разработчик"] == "Юмашева У.А."
    out = tpl.build(tickets(1), {"Разработчик": "Иванов И.И."})
    footer = docx.Document(io.BytesIO(out)).sections[0].footer
    text = "".join(c.text for t in footer.tables for r in t.rows for c in r.cells) + "".join(p.text for p in footer.paragraphs)
    assert "Разработчик: Иванов И.И./______________" in text
    assert "Юмашева" not in text

"""Работа с шаблоном экзаменационного билета (.docx).

Шаблон — обычный документ Word с одним билетом. Генератор находит в нём:

* абзац с номером билета («Экзаменационный билет № 1»);
* абзацы-образцы теоретических вопросов («Вопрос1.», «Вопрос2.» …);
* абзацы-образцы практических заданий («Практическое задание1.» …);
* поля вида «Группа: АТ-224» в шапке (их значения можно изменить).

Для каждого билета содержимое документа клонируется, образцы вопросов
заменяются нужным количеством абзацев с тем же оформлением, а между
билетами ставится разрыв страницы. Стили, колонтитулы, поля страницы,
шрифты и прочие части пакета .docx переносятся без изменений.
"""

from __future__ import annotations

import copy
import io
import re
import zipfile
from dataclasses import dataclass, field

from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
XML_NS = "http://www.w3.org/XML/1998/namespace"
NS = {"w": W_NS}


def w(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


THEORY_RE = re.compile(
    r"^\s*((?:теоретический\s+)?вопрос)(\s*)(?:№\s*)?(\d+)(\s*[.)]?)", re.IGNORECASE
)
PRACTICE_RE = re.compile(
    r"^\s*(практическ\w*\s+задани\w*|практическ\w*\s+вопрос\w*|задача|задание)(\s*)(?:№\s*)?(\d+)(\s*[.)]?)",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"(билет\w*\s*№\s*)(\d*)", re.IGNORECASE)
FIELD_RE = re.compile(r"^\s*([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё .\-]{1,40}?)\s*:\s*")

# Поля шапки, которые не имеет смысла редактировать (подписи и т. п.).
SKIP_FIELD_LABELS = {"разработчик"}


class TemplateError(ValueError):
    """Шаблон не подходит для формирования билетов."""


# --------------------------------------------------------------------------- #
# Низкоуровневые помощники
# --------------------------------------------------------------------------- #


def _texts(p: etree._Element) -> list[etree._Element]:
    return p.findall(".//w:t", NS)


def para_text(p: etree._Element) -> str:
    return "".join(t.text or "" for t in _texts(p))


def _set_text(t: etree._Element, text: str) -> None:
    t.text = text
    if text != text.strip() or "  " in text:
        t.set(f"{{{XML_NS}}}space", "preserve")


def replace_span(p: etree._Element, start: int, end: int, new: str) -> None:
    """Заменяет символы [start, end) текста абзаца на ``new``.

    Новый текст получает оформление того фрагмента (run), в котором
    находится позиция ``start``, — так сохраняется, например, подчёркивание
    значения поля.
    """
    ts = _texts(p)
    if not ts:
        return
    pos = 0
    placed = False
    for t in ts:
        txt = t.text or ""
        t_start, t_end = pos, pos + len(txt)
        pos = t_end
        if not placed:
            if t_start <= start < t_end or (start == t_end and t is ts[-1]):
                off = start - t_start
                tail = txt[end - t_start:] if end < t_end else ""
                _set_text(t, txt[:off] + new + tail)
                placed = True
            continue
        # Удаляем символы, попадающие в заменяемый диапазон, из следующих фрагментов.
        if t_start >= end:
            break
        cut = min(end, t_end) - t_start
        _set_text(t, txt[cut:])


def _strip_ids(el: etree._Element) -> None:
    """Убирает w14:paraId/textId, чтобы в документе не было дубликатов."""
    for node in el.iter():
        for attr in (f"{{{W14_NS}}}paraId", f"{{{W14_NS}}}textId"):
            if attr in node.attrib:
                del node.attrib[attr]


def _is_empty_para(el: etree._Element) -> bool:
    if el.tag != w("p"):
        return False
    if para_text(el).strip():
        return False
    for tag in ("drawing", "pict", "object", "br", "sectPr", "fldSimple", "fldChar"):
        if el.find(f".//w:{tag}", NS) is not None:
            return False
    return True


def _first_run_rpr(p: etree._Element) -> etree._Element | None:
    for r in p.findall("w:r", NS):
        t = r.find("w:t", NS)
        if t is not None and (t.text or "").strip():
            rpr = r.find("w:rPr", NS)
            return copy.deepcopy(rpr) if rpr is not None else None
    return None


def _plain_rpr(rpr: etree._Element | None) -> etree._Element | None:
    """Оформление текста вопроса: как у метки, но без жирного/курсива/подчёркивания."""
    if rpr is None:
        return None
    rpr = copy.deepcopy(rpr)
    for tag in ("b", "bCs", "i", "iCs", "u"):
        for el in rpr.findall(f"w:{tag}", NS):
            rpr.remove(el)
    return rpr


def _make_run(rpr: etree._Element | None, text: str) -> etree._Element:
    r = etree.Element(w("r"))
    if rpr is not None:
        r.append(copy.deepcopy(rpr))
    t = etree.SubElement(r, w("t"))
    t.text = text
    t.set(f"{{{XML_NS}}}space", "preserve")
    return r


# --------------------------------------------------------------------------- #
# Анализ шаблона
# --------------------------------------------------------------------------- #


@dataclass
class QuestionProto:
    """Образец абзаца с вопросом: оформление метки и текста."""

    ppr: etree._Element | None
    label_rpr: etree._Element | None
    text_rpr: etree._Element | None
    word: str
    sep: str
    suffix: str

    def label(self, n: int) -> str:
        return f"{self.word}{self.sep}{n}{self.suffix}"

    def make(self, n: int, text: str) -> etree._Element:
        p = etree.Element(w("p"))
        if self.ppr is not None:
            p.append(copy.deepcopy(self.ppr))
        p.append(_make_run(self.label_rpr, self.label(n)))
        if text:
            # Пробел после метки — в обычном начертании, чтобы не тянуть подчёркивание.
            p.append(_make_run(self.text_rpr, " " + text))
        return p


def _make_proto(p: etree._Element, m: re.Match) -> QuestionProto:
    ppr = p.find("w:pPr", NS)
    label_rpr = _first_run_rpr(p)
    suffix = m.group(4).strip() or "."
    return QuestionProto(
        ppr=copy.deepcopy(ppr) if ppr is not None else None,
        label_rpr=label_rpr,
        text_rpr=_plain_rpr(label_rpr),
        word=m.group(1).strip(),
        sep=m.group(2),
        suffix=suffix,
    )


@dataclass
class Template:
    files: dict[str, bytes]
    root: etree._Element  # w:document
    body_items: list[etree._Element]  # элементы тела без sectPr
    sect_pr: etree._Element | None
    theory_idx: list[int] = field(default_factory=list)
    practice_idx: list[int] = field(default_factory=list)
    theory: QuestionProto | None = None
    practice: QuestionProto | None = None

    # ------------------------------------------------------------------ #
    @classmethod
    def load(cls, data: bytes) -> "Template":
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise TemplateError("Файл не является документом Word (.docx).") from exc
        files = {name: zf.read(name) for name in zf.namelist()}
        if "word/document.xml" not in files:
            raise TemplateError("В файле нет word/document.xml — это не документ Word.")
        parser = etree.XMLParser(remove_blank_text=False, resolve_entities=False, no_network=True)
        root = etree.fromstring(files["word/document.xml"], parser)
        body = root.find("w:body", NS)
        items = list(body)
        sect = items[-1] if items and items[-1].tag == w("sectPr") else None
        if sect is not None:
            items = items[:-1]
        tpl = cls(files=files, root=root, body_items=items, sect_pr=sect)
        tpl._analyze()
        return tpl

    def _analyze(self) -> None:
        for i, el in enumerate(self.body_items):
            if el.tag != w("p"):
                continue
            text = para_text(el)
            m = THEORY_RE.match(text)
            if m:
                self.theory_idx.append(i)
                if self.theory is None:
                    self.theory = _make_proto(el, m)
                continue
            m = PRACTICE_RE.match(text)
            if m:
                self.practice_idx.append(i)
                if self.practice is None:
                    self.practice = _make_proto(el, m)
        if self.theory is None and self.practice is None:
            raise TemplateError(
                "В шаблоне не найдены места для вопросов. Добавьте абзацы "
                "«Вопрос1.» и/или «Практическое задание1.»."
            )

    # ------------------------------------------------------------------ #
    def iter_paragraphs(self):
        for el in self.body_items:
            if el.tag == w("p"):
                yield el
            else:
                yield from el.iter(w("p"))

    def fields(self) -> list[dict]:
        """Редактируемые поля «Название: значение» вне блоков вопросов."""
        result, seen = [], set()
        skip = {id(self.body_items[i]) for i in self.theory_idx + self.practice_idx}
        for p in self.iter_paragraphs():
            if id(p) in skip:
                continue
            text = para_text(p)
            m = FIELD_RE.match(text)
            if not m:
                continue
            label = m.group(1).strip()
            if label.lower() in SKIP_FIELD_LABELS or label.lower() in seen:
                continue
            seen.add(label.lower())
            result.append({"label": label, "value": text[m.end():].strip()})
        return result

    def has_number(self) -> bool:
        return any(NUMBER_RE.search(para_text(p)) for p in self.iter_paragraphs())

    # ------------------------------------------------------------------ #
    def _fill_ticket(
        self,
        number: int,
        theory: list[str],
        practice: list[str],
        fields: dict[str, str],
    ) -> list[etree._Element]:
        items = [copy.deepcopy(el) for el in self.body_items]
        th_start = self.theory_idx[0] if self.theory_idx else None
        pr_start = self.practice_idx[0] if self.practice_idx else None
        drop = set(self.theory_idx) | set(self.practice_idx)

        out: list[etree._Element] = []
        for i, el in enumerate(items):
            if i == th_start and self.theory is not None:
                out.extend(self.theory.make(n, q) for n, q in enumerate(theory, 1))
            if i == pr_start and self.practice is not None:
                out.extend(self.practice.make(n, q) for n, q in enumerate(practice, 1))
            if i in drop:
                continue
            out.append(el)

        lowered = {k.strip().lower(): v for k, v in fields.items()}
        for el in out:
            paras = [el] if el.tag == w("p") else list(el.iter(w("p")))
            for p in paras:
                text = para_text(p)
                m = NUMBER_RE.search(text)
                if m:
                    replace_span(p, m.start(2), m.end(2), str(number))
                    continue
                m = FIELD_RE.match(text)
                if m and m.group(1).strip().lower() in lowered:
                    value = lowered[m.group(1).strip().lower()]
                    replace_span(p, m.end(), len(text), value)

        # Хвостовые пустые абзацы могут вытолкнуть пустую страницу — убираем их.
        while out and _is_empty_para(out[-1]):
            out.pop()
        for el in out:
            _strip_ids(el)
        return out

    def build(self, tickets: list[dict], fields: dict[str, str] | None = None) -> bytes:
        """Собирает итоговый .docx со всеми билетами."""
        fields = fields or {}
        body = self.root.find("w:body", NS)
        for child in list(body):
            body.remove(child)

        for idx, ticket in enumerate(tickets):
            content = self._fill_ticket(
                int(ticket.get("number", idx + 1)),
                list(ticket.get("theory", [])),
                list(ticket.get("practice", [])),
                fields,
            )
            if idx > 0:
                first = content[0] if content else None
                if first is not None and first.tag == w("p"):
                    ppr = first.find("w:pPr", NS)
                    if ppr is None:
                        ppr = etree.Element(w("pPr"))
                        first.insert(0, ppr)
                    ppr.insert(0, etree.Element(w("pageBreakBefore")))
                else:
                    br_p = etree.Element(w("p"))
                    etree.SubElement(etree.SubElement(br_p, w("r")), w("br")).set(w("type"), "page")
                    body.append(br_p)
            for el in content:
                body.append(el)
        if self.sect_pr is not None:
            body.append(copy.deepcopy(self.sect_pr))

        doc_xml = etree.tostring(self.root, xml_declaration=True, encoding="UTF-8", standalone=True)
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            # [Content_Types].xml должен идти первым.
            names = sorted(self.files, key=lambda n: n != "[Content_Types].xml")
            for name in names:
                zf.writestr(name, doc_xml if name == "word/document.xml" else self.files[name])
        return out.getvalue()

    # ------------------------------------------------------------------ #
    # Описание шаблона для предпросмотра в браузере
    # ------------------------------------------------------------------ #

    def describe(self) -> dict:
        blocks: list[dict] = []
        th_start = self.theory_idx[0] if self.theory_idx else None
        pr_start = self.practice_idx[0] if self.practice_idx else None
        drop = set(self.theory_idx) | set(self.practice_idx)
        for i, el in enumerate(self.body_items):
            if i == th_start:
                blocks.append({"type": "theory", **_proto_info(self.theory)})
            if i == pr_start:
                blocks.append({"type": "practice", **_proto_info(self.practice)})
            if i in drop:
                continue
            if el.tag == w("p"):
                blocks.append(_describe_para(el))
            elif el.tag == w("tbl"):
                blocks.append(_describe_table(el))
        while blocks and blocks[-1]["type"] == "p" and not blocks[-1]["text"].strip():
            blocks.pop()

        page = {"width": 11906, "height": 16838, "top": 1134, "right": 850, "bottom": 1134, "left": 1701}
        if self.sect_pr is not None:
            sz = self.sect_pr.find("w:pgSz", NS)
            mar = self.sect_pr.find("w:pgMar", NS)
            if sz is not None:
                page["width"] = int(sz.get(w("w"), page["width"]))
                page["height"] = int(sz.get(w("h"), page["height"]))
            if mar is not None:
                for k in ("top", "right", "bottom", "left"):
                    v = mar.get(w(k))
                    if v is not None:
                        page[k] = abs(int(v))

        footer = []
        for name, data in sorted(self.files.items()):
            if re.fullmatch(r"word/footer\d*\.xml", name):
                froot = etree.fromstring(data)
                for p in froot.iter(w("p")):
                    d = _describe_para(p)
                    if d["text"].strip():
                        footer.append(d)
        return {
            "blocks": blocks,
            "page": page,
            "footer": footer,
            "fields": self.fields(),
            "hasNumber": self.has_number(),
            "hasTheory": self.theory is not None,
            "hasPractice": self.practice is not None,
            "theorySlots": len(self.theory_idx),
            "practiceSlots": len(self.practice_idx),
        }


def _proto_info(proto: QuestionProto | None) -> dict:
    if proto is None:
        return {}
    return {
        "word": proto.word,
        "sep": proto.sep,
        "suffix": proto.suffix,
        "label": _rpr_info(proto.label_rpr),
        "text": _rpr_info(proto.text_rpr),
        "indent": _indent(proto.ppr),
    }


def _rpr_info(rpr: etree._Element | None) -> dict:
    info = {"b": False, "i": False, "u": False, "sz": None}
    if rpr is None:
        return info

    def on(tag):
        el = rpr.find(f"w:{tag}", NS)
        return el is not None and el.get(w("val"), "true") not in ("0", "false", "none")

    info["b"], info["i"], info["u"] = on("b"), on("i"), on("u")
    sz = rpr.find("w:sz", NS)
    if sz is not None and sz.get(w("val")):
        info["sz"] = int(sz.get(w("val"))) / 2
    return info


def _indent(ppr: etree._Element | None) -> dict:
    res = {"left": 0, "firstLine": 0}
    if ppr is None:
        return res
    ind = ppr.find("w:ind", NS)
    if ind is not None:
        for k, attr in (("left", "left"), ("left", "start"), ("firstLine", "firstLine")):
            v = ind.get(w(attr))
            if v is not None:
                res[k] = int(v)
    style = ppr.find("w:pStyle", NS)
    if style is not None and res["left"] == 0:
        # Стиль абзаца (например, «Абзац списка») обычно задаёт отступ слева.
        res["styleIndent"] = True
    return res


def _describe_para(p: etree._Element) -> dict:
    ppr = p.find("w:pPr", NS)
    align = "left"
    if ppr is not None:
        jc = ppr.find("w:jc", NS)
        if jc is not None:
            align = {"center": "center", "right": "right", "end": "right", "both": "justify"}.get(
                jc.get(w("val")), "left"
            )
    runs = []
    for r in p.iter(w("r")):
        text = "".join(t.text or "" for t in r.findall("w:t", NS))
        if r.find("w:tab", NS) is not None:
            text = "\t" + text
        if not text:
            continue
        runs.append({"text": text, **_rpr_info(r.find("w:rPr", NS))})
    text = "".join(r["text"] for r in runs)
    d = {"type": "p", "align": align, "runs": runs, "text": text, "indent": _indent(ppr)}
    if NUMBER_RE.search(text):
        d["role"] = "number"
    else:
        m = FIELD_RE.match(text)
        if m and m.group(1).strip().lower() not in SKIP_FIELD_LABELS:
            d["role"] = "field"
            d["label"] = m.group(1).strip()
            d["prefixLen"] = m.end()
    return d


def _describe_table(tbl: etree._Element) -> dict:
    rows = []
    for tr in tbl.findall("w:tr", NS):
        cells = []
        for tc in tr.findall("w:tc", NS):
            tcw = tc.find("w:tcPr/w:tcW", NS)
            width = int(tcw.get(w("w"), 0)) if tcw is not None else 0
            span_el = tc.find("w:tcPr/w:gridSpan", NS)
            span = int(span_el.get(w("val"), 1)) if span_el is not None else 1
            cells.append(
                {
                    "width": width,
                    "span": span,
                    "paragraphs": [_describe_para(p) for p in tc.findall("w:p", NS)],
                }
            )
        h = tr.find("w:trPr/w:trHeight", NS)
        rows.append({"cells": cells, "height": int(h.get(w("val"), 0)) if h is not None else 0})
    borders = tbl.find("w:tblPr/w:tblBorders", NS) is not None
    return {"type": "table", "rows": rows, "borders": borders}

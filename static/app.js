/* CreatorTecets — клиентская часть: ввод данных, проверка, распределение, просмотр, экспорт. */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const KINDS = ["theory", "practice"];
  const KIND_NAME = { theory: "теоретических вопросов", practice: "практических заданий" };
  const KIND_SHORT = { theory: "Теория", practice: "Практика" };
  const STORE_KEY = "creatortecets:v1";
  const PX_PER_TWIP = 1 / 15; // 96 dpi

  const state = {
    templateFile: null, // File | null — null означает стандартный шаблон
    template: null, // описание шаблона с сервера
    fields: {},
    seed: Math.floor(Math.random() * 2 ** 31),
    tickets: [],
    edited: false,
    validation: null,
    view: "pages",
    pdfUrl: null,
    pdfStale: true,
  };

  const el = {
    count: $("#p-count"),
    theory: $("#p-theory"),
    practice: $("#p-practice"),
    repeat: $("#p-repeat"),
    filename: $("#p-filename"),
    q: { theory: $("#q-theory"), practice: $("#q-practice") },
    badge: { theory: $("#theory-count"), practice: $("#practice-count") },
    meter: { theory: $("#meter-theory"), practice: $("#meter-practice") },
    issues: $("#issues"),
    status: $("#check-status"),
    pages: $("#view-pages"),
    table: $("#view-table"),
    pdfView: $("#view-pdf"),
    pdfFrame: $("#pdf-frame"),
    pdfEmpty: $("#pdf-empty"),
    btnDocx: $("#btn-docx"),
    btnPdf: $("#btn-pdf"),
    previewMeta: $("#preview-meta"),
  };

  // ------------------------------------------------------------------ utils
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // Детерминированный генератор случайных чисел (mulberry32)
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("error", isError);
    // popover — чтобы уведомление было видно и поверх открытых окон
    if (t.showPopover) {
      try { t.hidePopover(); } catch { /* уже скрыт */ }
      t.showPopover();
    }
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => { if (!t.classList.contains("show") && t.hidePopover) try { t.hidePopover(); } catch { /* */ } }, 250);
    }, isError ? 5000 : 2600);
  }

  function busy(on, text = "Формирование…") {
    $("#busy").hidden = !on;
    $("#busy-text").textContent = text;
  }

  async function apiError(res) {
    try {
      const data = await res.json();
      return typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch {
      return `Ошибка сервера (${res.status})`;
    }
  }

  // ------------------------------------------------------------ questions
  const NUMBERING_RE = /^\s*(?:(?:№\s*)?\d{1,4}\s*[.)\-:]\s*|[•\-–—*·▪●]\s+)/;
  const cleanLine = (s) => s.replace(/ /g, " ").trim().replace(NUMBERING_RE, "").trim().replace(/\s+/g, " ");
  const normKey = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[\s.,;:!?«»"']+/g, " ").trim();

  function parseList(text) {
    return text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  }

  function getPools() {
    const pools = {};
    for (const k of KINDS) {
      const all = parseList(el.q[k].value);
      const seen = new Set();
      const unique = [];
      let dups = 0;
      for (const q of all) {
        const key = normKey(q);
        if (seen.has(key)) { dups++; continue; }
        seen.add(key);
        unique.push(q);
      }
      pools[k] = { all, unique, dups };
    }
    return pools;
  }

  function params() {
    const int = (input, min, max) => {
      const v = parseInt(input.value, 10);
      return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
    };
    return {
      count: int(el.count, 1, 500),
      per: { theory: int(el.theory, 0, 20), practice: int(el.practice, 0, 20) },
      mode: $("input[name=mode]:checked").value,
      repeat: el.repeat.checked,
    };
  }

  // ---------------------------------------------------------- distribution
  /**
   * Раскладывает вопросы по билетам.
   * Если вопросов достаточно — каждый используется не более одного раза.
   * Если не хватает и разрешены повторы — вопросы используются равномерно,
   * без повторов внутри одного билета.
   */
  function distribute(pool, n, k, { mode, repeat }, rand) {
    const tickets = Array.from({ length: n }, () => []);
    if (k === 0) return tickets;
    const order = mode === "random" ? shuffled(pool, rand) : pool.slice();

    if (order.length >= n * k || !repeat || order.length < k) {
      // Без повторов. Недостающие места помечаются null.
      let i = 0;
      for (const t of tickets) {
        for (let s = 0; s < k; s++) t.push(i < order.length ? { text: order[i++], repeat: false } : null);
      }
      return tickets;
    }

    // С повторами: равномерное использование.
    const uses = new Map(order.map((q) => [q, 0]));
    let cursor = 0;
    for (const t of tickets) {
      const inTicket = new Set();
      for (let s = 0; s < k; s++) {
        let best = null, bestUses = Infinity;
        for (let j = 0; j < order.length; j++) {
          const q = order[(cursor + j) % order.length];
          if (inTicket.has(q)) continue;
          const u = uses.get(q);
          if (u < bestUses) { best = q; bestUses = u; if (u === 0) break; }
        }
        cursor = (order.indexOf(best) + 1) % order.length;
        inTicket.add(best);
        uses.set(best, bestUses + 1);
        t.push({ text: best, repeat: bestUses > 0 });
      }
    }
    // Помечаем все вхождения повторяющихся вопросов.
    for (const t of tickets) for (const q of t) q.repeat = uses.get(q.text) > 1;
    return tickets;
  }

  function generate() {
    const p = params();
    const pools = getPools();
    const result = [];
    const rTheory = rng(state.seed);
    const rPractice = rng(state.seed ^ 0x5bd1e995);
    const th = distribute(pools.theory.unique, p.count, p.per.theory, p, rTheory);
    const pr = distribute(pools.practice.unique, p.count, p.per.practice, p, rPractice);
    for (let i = 0; i < p.count; i++) result.push({ number: i + 1, theory: th[i], practice: pr[i] });
    state.tickets = result;
    state.edited = false;
    markPdfStale();
  }

  function markRepeats() {
    for (const k of KINDS) {
      const counts = new Map();
      for (const t of state.tickets) for (const q of t[k]) if (q) counts.set(q.text, (counts.get(q.text) || 0) + 1);
      for (const t of state.tickets) for (const q of t[k]) if (q) q.repeat = counts.get(q.text) > 1;
    }
  }

  // ------------------------------------------------------------ validation
  function validate() {
    const p = params();
    const pools = getPools();
    const issues = [];
    const tpl = state.template;
    let errors = 0, warns = 0;
    const add = (level, text, action) => {
      issues.push({ level, text, action });
      if (level === "err") errors++;
      if (level === "warn") warns++;
    };

    if (!tpl) add("err", "Шаблон билета ещё не загружен.");
    if (p.per.theory + p.per.practice === 0) add("err", "В билете должен быть хотя бы один вопрос или задание.");

    for (const k of KINDS) {
      const need = p.count * p.per[k];
      const have = pools[k].unique.length;
      const m = el.meter[k];
      const ratio = need ? Math.min(1, have / need) : 1;
      m.classList.remove("err", "warn", "off");
      $("strong", m).textContent = p.per[k] ? `${have} / ${need}` : "не используется";
      $(".bar i", m).style.width = `${need ? ratio * 100 : 0}%`;
      let note = "";

      if (!p.per[k]) {
        m.classList.add("off");
      } else if (tpl && !tpl[k === "theory" ? "hasTheory" : "hasPractice"]) {
        m.classList.add("err");
        add("err", `В шаблоне нет места для ${KIND_NAME[k]} (абзаца «${k === "theory" ? "Вопрос1." : "Практическое задание1."}»).`);
      } else if (have < p.per[k]) {
        m.classList.add("err");
        note = `Нужно минимум ${p.per[k]} для одного билета`;
        add("err", `${KIND_SHORT[k]}: в одном билете ${p.per[k]} ${plural(p.per[k], "вопрос", "вопроса", "вопросов")}, а в списке всего ${have}. Добавьте вопросы или уменьшите их число в билете.`);
      } else if (have < need) {
        const lack = need - have;
        const maxTickets = Math.floor(have / p.per[k]);
        if (p.repeat) {
          m.classList.add("warn");
          const avg = (need / have).toFixed(1).replace(".", ",");
          note = `Повторы: каждый вопрос ≈ ${avg} раза`;
          add("warn", `${KIND_SHORT[k]}: не хватает ${lack}, вопросы будут повторяться в разных билетах (в среднем ${avg} раза). Внутри одного билета повторов нет.`);
        } else {
          m.classList.add("err");
          note = `Не хватает ${lack}`;
          add(
            "err",
            `${KIND_SHORT[k]}: не хватает ${lack} ${plural(lack, "вопроса", "вопросов", "вопросов")} (нужно ${need}, есть ${have}). Без повторов можно сформировать максимум ${maxTickets} ${plural(maxTickets, "билет", "билета", "билетов")}.`,
            maxTickets > 0 ? { label: `Сделать ${maxTickets}`, run: () => setCount(maxTickets) } : null,
          );
          if (!issues.some((x) => x.repeatHint)) {
            add("info", "Либо включите «Разрешить повторы», тогда вопросы будут использованы равномерно.", {
              label: "Разрешить",
              run: () => { el.repeat.checked = true; onParamsChange(); },
            });
            issues[issues.length - 1].repeatHint = true;
          }
        }
      } else {
        note = have > need ? `${have - need} не войдут в билеты` : "Все вопросы будут использованы";
        if (have > need && need > 0) add("info", `${KIND_SHORT[k]}: ${have - need} из ${have} не войдут в билеты${p.mode === "random" ? " (выбираются случайно)" : " (берутся первые по списку)"}.`);
      }
      if (pools[k].dups) {
        add("warn", `${KIND_SHORT[k]}: найдено дубликатов: ${pools[k].dups}. Они не учитываются при распределении.`, {
          label: "Удалить",
          run: () => dedupe(k),
        });
      }
      $("small", m).textContent = note;

      const badge = el.badge[k];
      badge.textContent = have;
      badge.classList.toggle("ok", p.per[k] > 0 && have >= need);
      badge.classList.toggle("err", p.per[k] > 0 && have < need && !(p.repeat && have >= p.per[k]));
      $(`[data-dedupe=${k}]`).hidden = !pools[k].dups;
    }

    if (state.edited) add("info", "Билеты отредактированы вручную. Изменение параметров или «Перемешать» сбросит ручные правки.");

    el.issues.innerHTML = "";
    for (const it of issues) {
      const li = document.createElement("li");
      li.className = it.level;
      const span = document.createElement("span");
      span.textContent = it.text;
      li.append(span);
      if (it.action) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = it.action.label;
        b.addEventListener("click", it.action.run);
        li.append(b);
      }
      el.issues.append(li);
    }

    const ok = errors === 0;
    el.status.className = "status " + (ok ? (warns ? "warn" : "ok") : "err");
    el.status.textContent = ok
      ? warns ? "Можно формировать, есть замечания" : "Всё готово к экспорту"
      : `Есть ${errors} ${plural(errors, "ошибка", "ошибки", "ошибок")}`;
    el.btnDocx.disabled = el.btnPdf.disabled = !ok;
    $("#m-docx").disabled = $("#m-pdf").disabled = !ok;
    $("#mobile-dot").className = "mdot " + (ok ? (warns ? "warn" : "") : "err");
    $("#btn-pdf-preview").disabled = !ok;
    state.validation = { ok };
    return ok;
  }

  function setCount(n) {
    el.count.value = n;
    onParamsChange();
  }

  function dedupe(kind) {
    const seen = new Set();
    const lines = parseList(el.q[kind].value).filter((q) => {
      const key = normKey(q);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    el.q[kind].value = lines.join("\n");
    onQuestionsChange();
    toast("Дубликаты удалены");
  }

  // ------------------------------------------------------------- template
  async function loadTemplate(file, source = file ? "custom" : "default") {
    const fd = new FormData();
    if (file) fd.append("template", file);
    const res = await fetch("/api/template/inspect", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await apiError(res));
    const info = await res.json();
    state.template = info;
    state.templateFile = file || null;

    state.templateSource = source;
    const lib = source.startsWith?.("lib:") ? libraryTemplates.find((t) => `lib:${t.id}` === source) : null;
    $("#tpl-name").textContent = info.isDefault ? "Стандартный шаблон (ГБПОУ КМП)" : lib ? lib.title : info.name;
    const parts = [];
    if (info.hasTheory) parts.push("теория");
    if (info.hasPractice) parts.push("практика");
    $("#tpl-meta").textContent = `Найдены места для: ${parts.join(", ")}${info.hasNumber ? " и номер билета" : ""}`;
    $("#tpl-reset").hidden = info.isDefault;

    // Поля шапки: сохраняем значения, введённые пользователем ранее.
    const prev = state.fields;
    state.fields = {};
    for (const f of info.fields) state.fields[f.label] = prev[f.label] ?? f.value;
    renderFields();
    markPdfStale();
    syncTemplateUi();
  }

  function renderFields() {
    const box = $("#fields");
    box.innerHTML = "";
    const fields = state.template?.fields || [];
    $("#fields-box").hidden = fields.length === 0;
    for (const f of fields) {
      const label = document.createElement("label");
      label.className = "text-field";
      label.innerHTML = `<span>${escapeHtml(f.label)}</span>`;
      const input = document.createElement("input");
      input.type = "text";
      input.value = state.fields[f.label] ?? "";
      input.placeholder = f.value;
      input.addEventListener("input", () => {
        state.fields[f.label] = input.value;
        renderPreview();
        markPdfStale();
        save();
      });
      label.append(input);
      box.append(label);
    }
  }

  // -------------------------------------------------------------- preview
  function runStyle(r) {
    const css = [];
    if (r.b) css.push("font-weight:700");
    if (r.i) css.push("font-style:italic");
    if (r.u) css.push("text-decoration:underline");
    if (r.sz) css.push(`font-size:${(r.sz * 4) / 3}px`);
    return css.join(";");
  }

  // Повторяет серверную логику replace_span: новый текст получает стиль фрагмента в позиции start.
  function replaceRuns(runs, start, end, text) {
    const out = [];
    let pos = 0, placed = false;
    runs.forEach((r, idx) => {
      const s = pos, e = pos + r.text.length;
      pos = e;
      if (!placed) {
        if ((s <= start && start < e) || (start === e && idx === runs.length - 1)) {
          const off = start - s;
          const tail = end < e ? r.text.slice(end - s) : "";
          out.push({ ...r, text: r.text.slice(0, off) + text + tail });
          placed = true;
        } else out.push(r);
        return;
      }
      if (s >= end) { out.push(r); return; }
      const cut = Math.min(end, e) - s;
      out.push({ ...r, text: r.text.slice(cut) });
    });
    return out;
  }

  function indentCss(ind) {
    if (!ind) return "";
    const left = ind.left || (ind.styleIndent ? 720 : 0);
    const css = [];
    if (left) css.push(`padding-left:${left * PX_PER_TWIP}px`);
    if (ind.firstLine) css.push(`text-indent:${ind.firstLine * PX_PER_TWIP}px`);
    return css.join(";");
  }

  function renderPara(p, number) {
    let runs = p.runs;
    if (p.role === "number") {
      const m = /(билет\S*\s*№\s*)(\d*)/i.exec(p.text);
      if (m) runs = replaceRuns(runs, m.index + m[1].length, m.index + m[0].length, String(number));
    } else if (p.role === "field" && p.label in state.fields) {
      runs = replaceRuns(runs, p.prefixLen, p.valueEnd ?? p.text.length, state.fields[p.label]);
    }
    const html = runs.map((r) => `<span style="${runStyle(r)}">${escapeHtml(r.text)}</span>`).join("");
    return `<p style="text-align:${p.align};${indentCss(p.indent)}">${html || "&nbsp;"}</p>`;
  }

  function renderTable(t, number) {
    const rows = t.rows
      .map((row) => {
        const cells = row.cells
          .map((c) => {
            const w = c.width ? `width:${c.width * PX_PER_TWIP}px;` : "";
            return `<td colspan="${c.span}" style="${w}">${c.paragraphs.map((p) => renderPara(p, number)).join("")}</td>`;
          })
          .join("");
        return `<tr style="height:${row.height * PX_PER_TWIP}px">${cells}</tr>`;
      })
      .join("");
    return `<table class="${t.borders ? "bordered" : ""}">${rows}</table>`;
  }

  function renderQuestions(block, items, ticketIdx, kind) {
    return items
      .map((q, i) => {
        const label = `${block.word}${block.sep}${i + 1}${block.suffix}`;
        const cls = ["q", q ? "" : "missing", q?.repeat ? "repeat" : ""].join(" ");
        const text = q ? escapeHtml(q.text) : "не хватает вопроса";
        const title = q?.repeat ? "Вопрос встречается в нескольких билетах" : "Нажмите, чтобы заменить";
        return `<p class="qline" style="${indentCss(block.indent)}"><span style="${runStyle(block.label)}">${escapeHtml(label)}</span> <span class="${cls}" style="${runStyle(block.text)}" data-t="${ticketIdx}" data-k="${kind}" data-i="${i}" title="${title}" tabindex="0">${text}</span></p>`;
      })
      .join("");
  }

  // Ширина области просмотра без внутренних отступов.
  function pagesInnerWidth() {
    const cs = getComputedStyle(el.pages);
    return el.pages.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 4;
  }

  function renderPreview() {
    const tpl = state.template;
    const tickets = state.tickets;
    el.previewMeta.textContent = tickets.length
      ? `${tickets.length} ${plural(tickets.length, "билет", "билета", "билетов")}`
      : "";

    if (!tpl) {
      el.pages.innerHTML = `<div class="empty"><div><strong>Загрузка шаблона…</strong></div></div>`;
      return;
    }
    const pools = getPools();
    const p = params();
    const used = KINDS.filter((k) => p.per[k] > 0);
    if (!used.length || used.every((k) => !pools[k].unique.length)) {
      el.pages.innerHTML = `<div class="empty"><div><strong>Добавьте вопросы</strong>Вставьте списки теоретических вопросов и практических заданий в настройках, и билеты появятся здесь.</div></div>`;
      el.table.innerHTML = "";
      return;
    }

    const pg = tpl.page;
    const pageW = pg.width * PX_PER_TWIP;
    const avail = pagesInnerWidth();
    if (avail <= 0) { renderSummary(); return; } // область скрыта — отрисуем листы, когда её покажут
    const fit = Math.min(2, avail / pageW);
    const zoom = state.zoom === "fit" ? fit : state.zoom;
    $("#zoom-value").textContent = `${Math.round(zoom * 100)}%`;
    $("#zoom-fit").classList.toggle("active", state.zoom === "fit");
    const pageStyle = [
      `width:${pageW}px`,
      `min-height:${pg.height * PX_PER_TWIP}px`,
      `padding:${pg.top * PX_PER_TWIP}px ${pg.right * PX_PER_TWIP}px ${pg.bottom * PX_PER_TWIP + 40}px ${pg.left * PX_PER_TWIP}px`,
    ].join(";");
    const footer = tpl.footer.length
      ? `<div class="page-footer" style="bottom:${Math.max(24, pg.bottom * PX_PER_TWIP * 0.6)}px;padding:0 ${pg.right * PX_PER_TWIP}px 0 ${pg.left * PX_PER_TWIP}px">${tpl.footer.map((f) => renderPara(f, 0)).join("")}</div>`
      : "";

    const html = tickets
      .map((t, ti) => {
        const body = tpl.blocks
          .map((b) => {
            if (b.type === "p") return renderPara(b, t.number);
            if (b.type === "table") return renderTable(b, t.number);
            if (b.type === "theory") return renderQuestions(b, t.theory, ti, "theory");
            if (b.type === "practice") return renderQuestions(b, t.practice, ti, "practice");
            return "";
          })
          .join("");
        return `<div class="page-wrap" style="zoom:${zoom}"><div class="page-label"><span>Билет № ${t.number}</span><span>A4</span></div><div class="page" style="${pageStyle}">${body}${footer}</div></div>`;
      })
      .join("");
    el.pages.innerHTML = html;
    renderSummary();
  }

  function renderSummary() {
    const p = params();
    const cols = KINDS.filter((k) => p.per[k] > 0);
    const head = `<tr><th>№</th>${cols.map((k) => `<th>${k === "theory" ? "Теоретические вопросы" : "Практические задания"}</th>`).join("")}</tr>`;
    const rows = state.tickets
      .map(
        (t) =>
          `<tr><td data-label="Билет №">${t.number}</td>${cols
            .map(
              (k) =>
                `<td data-label="${k === "theory" ? "Теоретические вопросы" : "Практические задания"}"><ol>${t[k]
                  .map((q) => (q ? `<li>${escapeHtml(q.text)}${q.repeat ? " <span title='Повтор'>↻</span>" : ""}</li>` : `<li style="color:var(--err)">не хватает вопроса</li>`))
                  .join("")}</ol></td>`,
            )
            .join("")}</tr>`,
      )
      .join("");
    el.table.innerHTML = `<table class="summary"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  // ------------------------------------------------------- manual editing
  let editing = null;
  function openReplace(ti, kind, i) {
    const pools = getPools();
    const ticket = state.tickets[ti];
    const current = ticket[kind][i];
    editing = { ti, kind, i };
    $("#replace-title").textContent = `Билет № ${ticket.number}: ${kind === "theory" ? "вопрос" : "задание"} ${i + 1}`;
    $("#replace-current").textContent = current ? `Сейчас: ${current.text}` : "Место пока не заполнено";
    const search = $("#replace-search");
    search.value = "";

    const uses = new Map();
    for (const t of state.tickets) for (const q of t[kind]) if (q) uses.set(q.text, (uses.get(q.text) || 0) + 1);
    const inTicket = new Set(ticket[kind].filter(Boolean).map((q) => q.text));

    const list = $("#replace-list");
    const draw = () => {
      const needle = normKey(search.value);
      const items = pools[kind].unique
        .filter((q) => !needle || normKey(q).includes(needle))
        .sort((a, b) => (uses.get(a) || 0) - (uses.get(b) || 0));
      list.innerHTML = items.length
        ? items
            .map((q) => {
              const u = uses.get(q) || 0;
              const cur = current && q === current.text;
              const blocked = !cur && inTicket.has(q);
              return `<li tabindex="${cur || blocked ? -1 : 0}" class="${cur || blocked ? "current" : ""}" data-q="${escapeHtml(q)}"><span>${escapeHtml(q)}</span><span class="uses ${u ? "" : "zero"}">${cur ? "текущий" : blocked ? "уже в билете" : u ? `в ${u} ${plural(u, "билете", "билетах", "билетах")}` : "не используется"}</span></li>`;
            })
            .join("")
        : `<li class="current">Ничего не найдено</li>`;
    };
    search.oninput = draw;
    draw();
    $("#replace-dialog").showModal();
    search.focus();
  }

  function applyReplace(text) {
    if (!editing) return;
    const { ti, kind, i } = editing;
    state.tickets[ti][kind][i] = { text, repeat: false };
    markRepeats();
    state.edited = true;
    $("#replace-dialog").close();
    markPdfStale();
    renderPreview();
    validate();
    toast("Вопрос заменён");
  }

  $("#replace-list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-q]");
    if (li && !li.classList.contains("current")) applyReplace(li.dataset.q);
  });
  $("#replace-list").addEventListener("keydown", (e) => {
    const li = e.target.closest("li[data-q]");
    if (e.key === "Enter" && li && !li.classList.contains("current")) { e.preventDefault(); applyReplace(li.dataset.q); }
  });
  el.pages.addEventListener("click", (e) => {
    const q = e.target.closest(".q[data-t]");
    if (q) openReplace(+q.dataset.t, q.dataset.k, +q.dataset.i);
  });
  el.pages.addEventListener("keydown", (e) => {
    const q = e.target.closest(".q[data-t]");
    if (q && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openReplace(+q.dataset.t, q.dataset.k, +q.dataset.i); }
  });

  // --------------------------------------------------------------- export
  function exportPayload() {
    return {
      filename: el.filename.value.trim() || "Экзаменационные билеты",
      fields: state.fields,
      tickets: state.tickets.map((t) => ({
        number: t.number,
        theory: t.theory.map((q) => q?.text ?? ""),
        practice: t.practice.map((q) => q?.text ?? ""),
      })),
    };
  }

  async function requestExport(format) {
    const fd = new FormData();
    fd.append("payload", JSON.stringify(exportPayload()));
    fd.append("format", format);
    if (state.templateFile) fd.append("template", state.templateFile);
    const res = await fetch("/api/export", { method: "POST", body: fd, credentials: "same-origin" });
    if (!res.ok) throw new Error(await apiError(res));
    return res.blob();
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function doExport(format) {
    if (!validate()) return toast("Исправьте ошибки в проверке перед экспортом", true);
    busy(true, format === "pdf" ? "Формирование PDF… это может занять несколько секунд" : "Формирование документа Word…");
    try {
      const blob = await requestExport(format);
      download(blob, `${exportPayload().filename}.${format}`);
      toast(`Файл ${format.toUpperCase()} сформирован`);
      if (state.user) autoSave();
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(false);
    }
  }

  function markPdfStale() {
    state.pdfStale = true;
    if (state.view === "pdf" && state.pdfUrl) {
      el.pdfEmpty.hidden = false;
      $("p", el.pdfEmpty).textContent = "Данные изменились. Обновите PDF-просмотр.";
      $("#btn-pdf-preview").textContent = "Обновить PDF-просмотр";
      el.pdfFrame.hidden = true;
    }
  }

  async function pdfPreview() {
    if (!validate()) return toast("Исправьте ошибки в проверке, чтобы построить PDF", true);
    busy(true, "Формирование PDF-просмотра…");
    try {
      const blob = await requestExport("pdf");
      if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
      state.pdfUrl = URL.createObjectURL(blob);
      el.pdfFrame.src = state.pdfUrl;
      el.pdfFrame.hidden = false;
      el.pdfEmpty.hidden = true;
      state.pdfStale = false;
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(false);
    }
  }

  function setView(view) {
    state.view = view;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    el.pages.hidden = view !== "pages";
    el.table.hidden = view !== "table";
    el.pdfView.hidden = view !== "pdf";
    $("#zoom").hidden = view !== "pages";
    $("#edit-hint").hidden = view !== "pages";
    if (view === "pages") renderPreview();
    if (view === "pdf") {
      const showFrame = state.pdfUrl && !state.pdfStale;
      el.pdfFrame.hidden = !showFrame;
      el.pdfEmpty.hidden = !!showFrame;
    }
  }

  // ---------------------------------------------------------- persistence
  const save = debounce(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          count: el.count.value,
          theory: el.theory.value,
          practice: el.practice.value,
          mode: $("input[name=mode]:checked").value,
          repeat: el.repeat.checked,
          filename: el.filename.value,
          qTheory: el.q.theory.value,
          qPractice: el.q.practice.value,
          fields: state.fields,
          seed: state.seed,
          currentSet: state.currentSet,
        }),
      );
    } catch { /* хранилище недоступно — не критично */ }
  }, 400);

  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!s) return;
      el.count.value = s.count ?? el.count.value;
      el.theory.value = s.theory ?? el.theory.value;
      el.practice.value = s.practice ?? el.practice.value;
      const mode = $(`input[name=mode][value=${s.mode}]`);
      if (mode) mode.checked = true;
      el.repeat.checked = !!s.repeat;
      el.filename.value = s.filename || el.filename.value;
      el.q.theory.value = s.qTheory || "";
      el.q.practice.value = s.qPractice || "";
      state.fields = s.fields || {};
      if (Number.isFinite(s.seed)) state.seed = s.seed;
      if (s.currentSet && Number.isFinite(s.currentSet.id)) state.currentSet = s.currentSet;
    } catch { /* игнорируем повреждённые данные */ }
  }

  // --------------------------------------------------------------- events
  function refresh() {
    generate();
    validate();
    renderPreview();
    if (state.view === "table") renderSummary();
    save();
  }
  const onParamsChange = refresh;
  const onQuestionsChange = debounce(refresh, 250);

  for (const input of [el.count, el.theory, el.practice]) {
    input.addEventListener("input", onQuestionsChange);
    input.addEventListener("change", () => {
      input.value = Math.min(+input.max, Math.max(+input.min, parseInt(input.value, 10) || +input.min));
      onParamsChange();
    });
  }
  $$(".stepper button").forEach((b) =>
    b.addEventListener("click", () => {
      const input = b.parentElement.querySelector("input");
      const v = (parseInt(input.value, 10) || 0) + Number(b.dataset.step);
      input.value = Math.min(+input.max, Math.max(+input.min, v));
      onParamsChange();
    }),
  );
  $$("input[name=mode]").forEach((r) => r.addEventListener("change", onParamsChange));
  el.repeat.addEventListener("change", onParamsChange);
  el.filename.addEventListener("input", save);
  for (const k of KINDS) el.q[k].addEventListener("input", onQuestionsChange);

  async function loadQuestionsFile(kind, file) {
    if (!file) return;
    try {
      let items;
      if (/\.(txt|csv)$/i.test(file.name) && file.size < 2e6) {
        const buf = await file.arrayBuffer();
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("windows-1251").decode(buf); }
        items = file.name.toLowerCase().endsWith(".csv") ? text.split(/\r?\n/).map((l) => l.split(/[;,](?=(?:[^"]*"[^"]*")*[^"]*$)/)[0].replace(/^"|"$/g, "")) : text.split(/\r?\n/);
        items = items.map(cleanLine).filter(Boolean);
      } else {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/questions/parse", { method: "POST", body: fd });
        if (!res.ok) throw new Error(await apiError(res));
        items = (await res.json()).questions;
      }
      if (!items.length) return toast("В файле не найдено ни одного вопроса", true);
      el.q[kind].value = items.join("\n");
      onQuestionsChange();
      toast(`Загружено: ${items.length} из «${file.name}»`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  $$("[data-upload]").forEach((input) =>
    input.addEventListener("change", () => {
      loadQuestionsFile(input.dataset.upload, input.files[0]);
      input.value = "";
    }),
  );
  $$("[data-clear]").forEach((b) =>
    b.addEventListener("click", () => {
      el.q[b.dataset.clear].value = "";
      onQuestionsChange();
    }),
  );
  $$("[data-dedupe]").forEach((b) => b.addEventListener("click", () => dedupe(b.dataset.dedupe)));
  $$(".qcard").forEach((card) => {
    const zone = $(".dropzone", card);
    const kind = card.dataset.kind;
    zone.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); zone.classList.add("drag"); } });
    zone.addEventListener("dragleave", (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove("drag"); });
    zone.addEventListener("drop", (e) => {
      zone.classList.remove("drag");
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      loadQuestionsFile(kind, e.dataTransfer.files[0]);
    });
  });

  $("#tpl-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    busy(true, "Анализ шаблона…");
    try {
      await loadTemplate(file);
      state.templateDirty = true;
      refresh();
      toast("Шаблон загружен");
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(false);
    }
  });
  $("#tpl-reset").addEventListener("click", async () => {
    state.fields = {};
    await loadTemplate(null);
    state.templateDirty = true;
    refresh();
  });

  $("#btn-shuffle").addEventListener("click", () => {
    state.seed = Math.floor(Math.random() * 2 ** 31);
    if ($("input[name=mode]:checked").value !== "random") {
      $("input[name=mode][value=random]").checked = true;
    }
    refresh();
    toast("Вопросы перераспределены");
  });
  el.btnDocx.addEventListener("click", () => doExport("docx"));
  el.btnPdf.addEventListener("click", () => doExport("pdf"));
  $("#btn-pdf-preview").addEventListener("click", pdfPreview);
  $$(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
  window.addEventListener("resize", debounce(() => state.view === "pages" && renderPreview(), 150));

  $("#btn-reset").addEventListener("click", () => {
    if (!confirm("Очистить все вопросы и параметры?")) return;
    el.q.theory.value = el.q.practice.value = "";
    el.count.value = 10;
    el.theory.value = el.practice.value = 2;
    el.repeat.checked = false;
    $("input[name=mode][value=random]").checked = true;
    state.fields = {};
    for (const f of state.template?.fields || []) state.fields[f.label] = f.value;
    renderFields();
    refresh();
  });

  $("#btn-demo").addEventListener("click", () => {
    if ((el.q.theory.value.trim() || el.q.practice.value.trim()) && !confirm("Заменить текущие вопросы примером?")) return;
    el.q.theory.value = [
      "Классификация аддитивных технологий по ГОСТ Р 57558",
      "Устройство и принцип работы FDM-принтера",
      "Технология селективного лазерного спекания (SLS): оборудование и материалы",
      "Стереолитография (SLA): принцип работы и особенности обслуживания",
      "Виды технического обслуживания аддитивных установок",
      "Регламент ежедневного обслуживания 3D-принтера",
      "Типовые неисправности экструдера и способы их устранения",
      "Калибровка рабочего стола: назначение и методы",
      "Требования охраны труда при работе с аддитивными установками",
      "Хранение и подготовка расходных материалов",
      "Системы подачи порошка в установках SLM",
      "Диагностика электронных компонентов аддитивных установок",
      "Обслуживание лазерной оптической системы",
      "Программное обеспечение для подготовки моделей к печати",
      "Контроль качества изделий, полученных аддитивными методами",
      "Документация по техническому обслуживанию оборудования",
      "Системы охлаждения и вентиляции аддитивных установок",
      "Замена и настройка нагревательных элементов",
      "Постобработка изделий после 3D-печати",
      "Утилизация отходов аддитивного производства",
    ].join("\n");
    el.q.practice.value = [
      "Выполните калибровку стола FDM-принтера и проверьте результат тестовой печатью",
      "Замените сопло экструдера и выполните настройку первого слоя",
      "Проведите очистку ванны фотополимерного принтера",
      "Составьте график планово-предупредительного обслуживания установки",
      "Определите причину недоэкструзии по образцу и устраните её",
      "Подготовьте модель к печати в слайсере с заданными параметрами",
      "Выполните замену ремня привода оси X и натяжку ремней",
      "Проверьте и откалибруйте датчик автоуровня стола",
      "Заполните журнал технического обслуживания по результатам осмотра",
      "Проведите диагностику температурного датчика хотэнда",
      "Выполните смазку направляющих и ходовых винтов",
      "Проведите визуальный контроль качества напечатанной детали и составьте заключение",
      "Замените тефлоновую трубку подачи филамента",
      "Подготовьте рабочее место и установку к запуску печати",
      "Выполните сушку филамента и проверку его влажности",
      "Настройте ретракт для устранения паутины на тестовой модели",
      "Проведите очистку вентиляторов и проверку системы охлаждения",
      "Подберите режим печати для нового материала по тестовой башне",
      "Проверьте натяжение и выравнивание портала принтера",
      "Выполните обновление прошивки контроллера установки",
    ].join("\n");
    refresh();
    toast("Добавлены примеры вопросов");
  });

  // ------------------------------------------------------------ zoom/focus
  const ZOOM_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const ZOOM_KEY = "creatortecets:zoom";
  try {
    const z = localStorage.getItem(ZOOM_KEY);
    state.zoom = z && z !== "fit" && Number.isFinite(+z) ? +z : "fit";
  } catch { state.zoom = "fit"; }

  function currentZoom() {
    const pageW = (state.template?.page.width || 11906) * PX_PER_TWIP;
    return state.zoom === "fit" ? Math.min(2, pagesInnerWidth() / pageW) : state.zoom;
  }

  function setZoom(z) {
    // Сохраняем относительную позицию прокрутки, чтобы не терять текущий билет.
    const ratio = el.pages.scrollHeight ? el.pages.scrollTop / el.pages.scrollHeight : 0;
    state.zoom = z;
    try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* не критично */ }
    renderPreview();
    el.pages.scrollTop = ratio * el.pages.scrollHeight;
  }

  function stepZoom(dir) {
    const cur = currentZoom();
    const next = dir > 0 ? ZOOM_STEPS.find((v) => v > cur + 0.001) : [...ZOOM_STEPS].reverse().find((v) => v < cur - 0.001);
    setZoom(next ?? (dir > 0 ? ZOOM_STEPS.at(-1) : ZOOM_STEPS[0]));
  }

  $("#zoom-in").addEventListener("click", () => stepZoom(1));
  $("#zoom-out").addEventListener("click", () => stepZoom(-1));
  $("#zoom-fit").addEventListener("click", () => setZoom("fit"));
  el.pages.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  function setFocus(on) {
    document.body.classList.toggle("focus", on);
    const b = $("#btn-focus");
    $("span", b).textContent = on ? "Свернуть" : "Развернуть";
    b.title = on ? "Вернуть панель настроек (Esc)" : "Развернуть просмотр на весь экран (Esc, чтобы свернуть)";
    $("path", b).setAttribute("d", on ? "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5");
    if (state.view === "pages") renderPreview();
  }
  $("#btn-focus").addEventListener("click", () => setFocus(!document.body.classList.contains("focus")));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("focus") && !$("#replace-dialog").open) setFocus(false);
  });

  // ---------------------------------------------------------------- theme
  const THEME_KEY = "creatortecets:theme";
  const THEMES = ["auto", "light", "dark"];
  const THEME_LABEL = { auto: "Тема: как в системе", light: "Тема: светлая", dark: "Тема: тёмная" };
  const THEME_ICON = {
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };
  function applyTheme(theme) {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    const b = $("#btn-theme");
    b.innerHTML = THEME_ICON[theme];
    b.title = THEME_LABEL[theme] + " (нажмите, чтобы сменить)";
    b.setAttribute("aria-label", THEME_LABEL[theme]);
  }
  let theme = "auto";
  try { theme = THEMES.includes(localStorage.getItem(THEME_KEY)) ? localStorage.getItem(THEME_KEY) : "auto"; } catch { /* */ }
  applyTheme(theme);
  $("#btn-theme").addEventListener("click", () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* */ }
    toast(THEME_LABEL[theme]);
  });

  // ------------------------------------------------------- личный кабинет
  state.user = null;
  state.currentSet = null; // { id, title }
  state.templateDirty = false;

  async function api(url, options = {}) {
    const res = await fetch(url, { credentials: "same-origin", ...options });
    if (res.status === 401 && !url.startsWith("/api/auth/")) {
      setUser(null);
      openAuth("Сессия истекла, войдите снова.");
      throw new Error("Требуется вход в личный кабинет");
    }
    if (!res.ok) throw new Error(await apiError(res));
    return res;
  }

  const fmtDate = (iso) => {
    try {
      return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch { return iso; }
  };

  function setUser(user) {
    state.user = user;
    const b = $("#btn-account");
    if (user) {
      const label = user.name || user.email;
      b.innerHTML = `<span class="avatar">${escapeHtml(label.trim()[0]?.toUpperCase() || "?")}</span><span>${escapeHtml(label)}</span>`;
      b.title = "Личный кабинет";
      $(".cab-tabs [data-cab=moderation]").hidden = !user.isAdmin;
      if (user.isAdmin) {
        fetch("/api/admin/submissions?status=pending", { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => d && updateModBadge(d.counts.pending || 0))
          .catch(() => {});
      }
    } else {
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span>Войти</span>`;
      b.title = "Вход и регистрация";
      $(".cab-tabs [data-cab=moderation]").hidden = true;
      setCurrentSet(null);
    }
  }

  function setCurrentSet(set) {
    state.currentSet = set ? { id: set.id, title: set.title } : null;
    const chip = $("#current-set");
    chip.hidden = !set;
    if (set) chip.innerHTML = `Набор: <b>${escapeHtml(set.title)}</b>`;
    save();
  }

  // ---- вход / регистрация
  let afterAuth = null;
  let authReason = "";
  const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const authMode = () => $("input[name=auth-mode]:checked").value;
  const isReg = () => authMode() === "register";
  const touched = new Set();

  function fieldMsg(id, msg, ok = false) {
    const f = $(`#${id}`).closest(".field");
    f.classList.toggle("invalid", !!msg);
    f.classList.toggle("valid", !msg && ok);
    $(".field-error", f).textContent = msg || "";
  }

  function passwordChecks(pw, email) {
    const local = (email || "").split("@")[0].toLowerCase();
    return {
      len: pw.length >= 8,
      mix: /[A-Za-zА-Яа-яЁё]/.test(pw) && /\d/.test(pw),
      email: !pw || !email || (pw.toLowerCase() !== email.toLowerCase() && pw.toLowerCase() !== local),
    };
  }

  function passwordScore(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-zа-яё]/.test(pw) && /[A-ZА-ЯЁ]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-zА-Яа-яЁё0-9]/.test(pw)) score++;
    if (new Set(pw).size < 4 || /^(.)\1+$/.test(pw) || /^(12345|qwerty|йцукен|password|пароль)/i.test(pw)) score = Math.min(score, 1);
    return Math.min(4, score);
  }

  function passwordProblem(pw, email) {
    const c = passwordChecks(pw, email);
    if (!c.len) return "Не короче 8 символов";
    if (!c.mix) return "Нужны и буквы, и цифры";
    if (!c.email) return "Пароль не должен совпадать с почтой";
    if (new Set(pw).size < 4) return "Слишком простой пароль";
    return "";
  }

  function updateStrength() {
    const pw = $("#auth-password").value;
    const email = $("#auth-email").value.trim();
    const box = $("#pw-strength");
    box.hidden = $("#pw-rules").hidden = !isReg();
    if (!isReg()) return;
    const score = passwordScore(pw);
    const levels = [
      ["", "var(--border)"],
      ["Слабый", "var(--err)"],
      ["Средний", "var(--warn)"],
      ["Хороший", "var(--good)"],
      ["Надёжный", "var(--ok)"],
    ];
    const [label, color] = levels[score];
    $(".strength-bar i", box).style.width = `${(score / 4) * 100}%`;
    $(".strength-bar i", box).style.background = color;
    $(".strength-label", box).textContent = pw ? label : "";
    $(".strength-label", box).style.color = color;
    const checks = passwordChecks(pw, email);
    $$("#pw-rules li").forEach((li) => li.classList.toggle("ok", !!pw && checks[li.dataset.rule]));
  }

  // Проверка полей; show — показывать ли ошибки у нетронутых полей.
  function validateAuth(show = false) {
    const reg = isReg();
    const email = $("#auth-email").value.trim();
    const pw = $("#auth-password").value;
    const pw2 = $("#auth-password2").value;
    const errs = {
      "auth-email": !email ? "Укажите почту" : !EMAIL_OK.test(email) ? "Похоже, в адресе ошибка" : "",
      "auth-password": !pw ? "Введите пароль" : reg ? passwordProblem(pw, email) : "",
      "auth-password2": reg ? (!pw2 ? "Повторите пароль" : pw2 !== pw ? "Пароли не совпадают" : "") : "",
      "auth-name": reg && $("#auth-name").value.trim().length > 100 ? "Слишком длинное имя" : "",
      "auth-consent": reg && !$("#auth-consent").checked ? "Без согласия регистрация невозможна" : "",
    };
    for (const [id, msg] of Object.entries(errs)) {
      const visible = show || touched.has(id);
      const filled = $(`#${id}`).type === "checkbox" ? $(`#${id}`).checked : !!$(`#${id}`).value;
      fieldMsg(id, visible ? msg : "", visible && !msg && filled && reg && id !== "auth-consent");
    }
    updateStrength();
    return Object.values(errs).every((m) => !m);
  }

  function syncAuthMode() {
    const reg = isReg();
    $$("#auth-form [data-reg]").forEach((n) => (n.hidden = !reg));
    $$("#auth-form [data-login]").forEach((n) => (n.hidden = reg));
    $("#auth-title").textContent = reg ? "Регистрация" : "Вход в личный кабинет";
    $("#auth-reason").textContent =
      authReason ||
      (reg
        ? "Создайте аккаунт, и сформированные билеты будут сохраняться в личном кабинете."
        : "Войдите, чтобы сохранять билеты и возвращаться к ним в любой момент.");
    $("#auth-submit").textContent = reg ? "Создать аккаунт" : "Войти";
    $("#auth-password").autocomplete = reg ? "new-password" : "current-password";
    $("#auth-switch").innerHTML = reg
      ? 'Уже есть аккаунт? <button type="button" class="link-btn" data-switch="login">Войти</button>'
      : 'Нет аккаунта? <button type="button" class="link-btn" data-switch="register">Зарегистрироваться</button>';
    $("#auth-error").hidden = true;
    touched.clear();
    validateAuth(false);
  }

  function openAuth(reason, then, mode) {
    afterAuth = then || null;
    authReason = reason || "";
    $(`input[name=auth-mode][value=${mode === "register" ? "register" : "login"}]`).checked = true;
    syncAuthMode();
    const d = $("#auth-dialog");
    if (!d.open) d.showModal();
    (isReg() ? $("#auth-name") : $("#auth-email")).focus();
  }

  $$("input[name=auth-mode]").forEach((r) => r.addEventListener("change", syncAuthMode));
  $("#auth-switch").addEventListener("click", (e) => {
    const b = e.target.closest("[data-switch]");
    if (!b) return;
    $(`input[name=auth-mode][value=${b.dataset.switch}]`).checked = true;
    syncAuthMode();
  });
  $("#auth-consent").addEventListener("change", () => { touched.add("auth-consent"); validateAuth(false); });
  for (const id of ["auth-name", "auth-email", "auth-password", "auth-password2"]) {
    const input = $(`#${id}`);
    input.addEventListener("input", () => { $("#auth-error").hidden = true; validateAuth(false); });
    input.addEventListener("blur", () => { if (input.value) touched.add(id); validateAuth(false); });
  }

  // Показ/скрытие пароля
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".pw-eye");
    if (!b) return;
    const input = $(`#${b.dataset.eye}`);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    b.classList.toggle("on", show);
    b.title = show ? "Скрыть пароль" : "Показать пароль";
    b.setAttribute("aria-label", b.title);
    input.focus();
  });

  // Предупреждение о Caps Lock
  document.addEventListener("keyup", (e) => {
    if (!e.getModifierState || !e.target.matches?.("#auth-form input[type=password], #auth-form input.pw")) return;
    $("#caps-warn").hidden = !e.getModifierState("CapsLock");
  });

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const reg = isReg();
    ["auth-email", "auth-password", "auth-password2", "auth-consent"].forEach((id) => touched.add(id));
    if (!validateAuth(true)) {
      $("#auth-form .field.invalid input")?.focus();
      return;
    }
    const body = { email: $("#auth-email").value.trim(), password: $("#auth-password").value };
    if (reg) {
      body.name = $("#auth-name").value.trim();
      body.consent = $("#auth-consent").checked;
    } else body.remember = $("#auth-remember").checked;
    const err = $("#auth-error");
    const btn = $("#auth-submit");
    btn.disabled = true;
    btn.textContent = reg ? "Создаём аккаунт…" : "Входим…";
    try {
      const res = await api(`/api/auth/${reg ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const { user } = await res.json();
      setUser(user);
      for (const id of ["auth-password", "auth-password2"]) $(`#${id}`).value = "";
      $("#auth-dialog").close();
      toast(reg ? `Аккаунт создан. Добро пожаловать${user.name ? ", " + user.name : ""}!` : `С возвращением, ${user.name || user.email}`);
      const next = afterAuth;
      afterAuth = null;
      if (next) next();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      if (/уже зарегистрирован/i.test(ex.message)) {
        err.innerHTML = `${escapeHtml(ex.message)} <button type="button" class="link-btn" id="goto-login">Войти</button>`;
        $("#goto-login").onclick = () => {
          $("input[name=auth-mode][value=login]").checked = true;
          syncAuthMode();
          $("#auth-password").focus();
        };
      }
    } finally {
      btn.disabled = false;
      btn.textContent = isReg() ? "Создать аккаунт" : "Войти";
    }
  });

  // ---- профиль
  function showCabTab(tab) {
    $$(".cab-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.cab === tab));
    $$(".cab-pane").forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (tab === "profile") fillProfile();
    if (tab === "templates") loadMyTemplates();
    if (tab === "moderation") loadModeration();
  }
  $$(".cab-tabs .tab").forEach((t) => t.addEventListener("click", () => showCabTab(t.dataset.cab)));

  function fillProfile() {
    const u = state.user;
    if (!u) return;
    $("#profile-name").value = u.name || "";
    $("#profile-email").value = u.email;
    $("#profile-since").textContent = u.createdAt ? `Аккаунт создан ${fmtDate(u.createdAt)}` : "";
    for (const id of ["pw-current", "pw-new", "pw-new2", "del-password"]) {
      $(`#${id}`).value = "";
      fieldMsg(id, "");
    }
    $("#password-error").hidden = $("#delete-error").hidden = true;
  }

  $("#profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const { user } = await (await api("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: $("#profile-name").value.trim() }),
      })).json();
      setUser({ ...state.user, ...user });
      $("#cab-user").textContent = user.name ? `${user.name}, ${user.email}` : user.email;
      toast("Имя сохранено");
    } catch (err) { toast(err.message, true); }
  });

  $("#password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cur = $("#pw-current").value, pw = $("#pw-new").value, pw2 = $("#pw-new2").value;
    const problem = passwordProblem(pw, state.user.email);
    fieldMsg("pw-current", cur ? "" : "Введите текущий пароль");
    fieldMsg("pw-new", !pw ? "Введите новый пароль" : problem);
    fieldMsg("pw-new2", pw2 !== pw ? "Пароли не совпадают" : "");
    if (!cur || !pw || problem || pw !== pw2) return;
    const errBox = $("#password-error");
    try {
      await api("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current: cur, new: pw }),
      });
      fillProfile();
      toast("Пароль изменён");
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  });

  $("#delete-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#del-password").value;
    fieldMsg("del-password", pw ? "" : "Введите пароль");
    if (!pw) return;
    if (!confirm("Удалить аккаунт и все сохранённые наборы билетов? Отменить это действие нельзя.")) return;
    try {
      await api("/api/auth/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      setUser(null);
      $("#cabinet-dialog").close();
      toast("Аккаунт удалён");
    } catch (err) {
      const box = $("#delete-error");
      box.textContent = err.message;
      box.hidden = false;
    }
  });

  // ---- данные набора
  function collectSet() {
    const p = params();
    return {
      params: {
        count: p.count,
        theory: p.per.theory,
        practice: p.per.practice,
        mode: p.mode,
        repeat: p.repeat,
        filename: el.filename.value.trim() || "Экзаменационные билеты",
      },
      questions: { theory: el.q.theory.value, practice: el.q.practice.value },
      fields: state.fields,
      seed: state.seed,
      edited: state.edited,
      tickets: exportPayload().tickets,
    };
  }

  function defaultTitle() {
    const f = state.fields;
    const parts = [f["Дисциплина"], f["Группа"]].filter((x) => x && x.trim());
    return (parts.join(", ") || el.filename.value.trim() || "Экзаменационные билеты").slice(0, 200);
  }

  async function saveSet({ asNew = false, title } = {}) {
    const fd = new FormData();
    const t = (title || state.currentSet?.title || defaultTitle()).trim();
    fd.append("payload", JSON.stringify({ title: t, data: collectSet() }));
    const update = state.currentSet && !asNew;
    if (update) {
      if (state.templateDirty) fd.append("template_mode", state.templateFile ? "replace" : "default");
    }
    if (state.templateFile && (!update || state.templateDirty)) fd.append("template", state.templateFile);
    const res = await api(update ? `/api/sets/${state.currentSet.id}` : "/api/sets", { method: update ? "PUT" : "POST", body: fd });
    const { set } = await res.json();
    state.templateDirty = false;
    setCurrentSet(set);
    return set;
  }

  async function autoSave() {
    if (!validate()) return;
    try {
      const set = await saveSet();
      toast(`Сохранено в личном кабинете: «${set.title}»`);
    } catch (err) {
      toast(`Не удалось сохранить: ${err.message}`, true);
    }
  }

  function openSaveDialog() {
    if (!state.user) return openAuth("Войдите или зарегистрируйтесь, чтобы сохранить билеты.", openSaveDialog);
    if (!validate()) return toast("Исправьте ошибки в проверке перед сохранением", true);
    $("#save-title").value = state.currentSet?.title || defaultTitle();
    $("#save-as-new").hidden = !state.currentSet;
    $("#save-submit").textContent = state.currentSet ? "Обновить набор" : "Сохранить";
    $("#save-note").textContent = state.currentSet
      ? "Набор уже есть в кабинете, изменения будут записаны в него. Можно сохранить и как отдельный новый набор."
      : "Сохранятся параметры, списки вопросов и сами билеты вместе с ручными заменами.";
    $("#save-dialog").showModal();
    $("#save-title").select();
  }

  async function submitSave(asNew) {
    const title = $("#save-title").value.trim();
    if (!title) return $("#save-title").focus();
    try {
      const set = await saveSet({ asNew, title });
      $("#save-dialog").close();
      toast(`Набор «${set.title}» сохранён`);
    } catch (err) {
      toast(err.message, true);
    }
  }
  $("#save-form").addEventListener("submit", (e) => { e.preventDefault(); submitSave(false); });
  $("#save-as-new").addEventListener("click", () => submitSave(true));
  $("#btn-save").addEventListener("click", openSaveDialog);

  // ---- кабинет
  let cabinetSets = [];
  async function openCabinet() {
    if (!state.user) return openAuth(null, openCabinet);
    $("#cab-user").textContent = state.user.name ? `${state.user.name}, ${state.user.email}` : state.user.email;
    showCabTab("sets");
    $("#cab-search").value = "";
    $("#cab-list").innerHTML = `<li class="empty">Загрузка…</li>`;
    $("#cabinet-dialog").showModal();
    try {
      cabinetSets = (await (await api("/api/sets")).json()).sets;
      drawCabinet();
    } catch (err) {
      $("#cab-list").innerHTML = `<li class="empty">${escapeHtml(err.message)}</li>`;
    }
  }

  function drawCabinet() {
    const needle = normKey($("#cab-search").value);
    const items = cabinetSets.filter((s) => !needle || normKey([s.title, ...Object.values(s.fields)].join(" ")).includes(needle));
    $("#cab-count").textContent = cabinetSets.length
      ? `Сохранено наборов: ${cabinetSets.length}${needle ? `, найдено: ${items.length}` : ""}`
      : "";
    const list = $("#cab-list");
    if (!cabinetSets.length) {
      list.innerHTML = `<li class="empty"><div><strong>Здесь пока пусто</strong>Сформируйте билеты и нажмите «Сохранить» или просто скачайте их: после входа каждый экспорт сохраняется сюда автоматически.</div></li>`;
      return;
    }
    if (!items.length) {
      list.innerHTML = `<li class="empty">Ничего не найдено</li>`;
      return;
    }
    list.innerHTML = items
      .map((s) => {
        const cur = state.currentSet?.id === s.id;
        const per = [s.theoryPer ? `${s.theoryPer} теор.` : "", s.practicePer ? `${s.practicePer} практ.` : ""].filter(Boolean).join(" + ");
        const info = [s.fields["Группа"] && `Группа ${s.fields["Группа"]}`, s.fields["Дисциплина"]].filter(Boolean).map(escapeHtml);
        return `<li class="set ${cur ? "current" : ""}" data-id="${s.id}">
          <h4><span>${escapeHtml(s.title)}</span>${cur ? '<em class="tag">открыт</em>' : ""}</h4>
          <div class="meta">
            <span>${s.ticketCount} ${plural(s.ticketCount, "билет", "билета", "билетов")}${per ? `, ${per}` : ""}</span>
            ${info.map((x) => `<span>${x}</span>`).join("")}
            <span>${s.templateName ? `Шаблон: ${escapeHtml(s.templateName)}` : "Стандартный шаблон"}</span>
            <span>Изменён ${fmtDate(s.updatedAt)}</span>
          </div>
          <div class="actions">
            <button class="btn small primary" data-act="open" type="button">Открыть</button>
            <button class="btn small secondary" data-act="docx" type="button" title="Скачать Word">.docx</button>
            <button class="btn small secondary" data-act="pdf" type="button" title="Скачать PDF">PDF</button>
            <button class="btn small ghost" data-act="rename" type="button" title="Переименовать">✎</button>
            <button class="btn small ghost danger" data-act="delete" type="button" title="Удалить">🗑</button>
          </div>
        </li>`;
      })
      .join("");
  }

  async function openSet(id) {
    busy(true, "Открытие набора…");
    try {
      const { set } = await (await api(`/api/sets/${id}`)).json();
      const d = set.data;
      const p = d.params || {};
      el.count.value = p.count ?? set.ticketCount;
      el.theory.value = p.theory ?? 0;
      el.practice.value = p.practice ?? 0;
      const mode = $(`input[name=mode][value=${p.mode === "sequential" ? "sequential" : "random"}]`);
      mode.checked = true;
      el.repeat.checked = !!p.repeat;
      el.filename.value = p.filename || set.title;
      el.q.theory.value = d.questions?.theory || "";
      el.q.practice.value = d.questions?.practice || "";
      if (Number.isFinite(d.seed)) state.seed = d.seed;
      state.fields = { ...(d.fields || {}) };
      let file = null;
      if (set.hasTemplate) {
        const blob = await (await api(`/api/sets/${id}/template`)).blob();
        file = new File([blob], set.templateName || "template.docx", { type: blob.type });
      }
      await loadTemplate(file, file ? "saved" : "default");
      state.templateDirty = false;
      // Восстанавливаем сохранённые билеты как есть, без перераспределения.
      state.tickets = (d.tickets || []).map((t) => ({
        number: t.number,
        theory: (t.theory || []).map((q) => (q ? { text: q, repeat: false } : null)),
        practice: (t.practice || []).map((q) => (q ? { text: q, repeat: false } : null)),
      }));
      markRepeats();
      state.edited = !!d.edited;
      markPdfStale();
      validate();
      renderPreview();
      setCurrentSet(set);
      $("#cabinet-dialog").close();
      toast(`Открыт набор «${set.title}»`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(false);
    }
  }

  async function downloadSet(id, format) {
    const s = cabinetSets.find((x) => x.id === id);
    busy(true, format === "pdf" ? "Формирование PDF…" : "Формирование документа Word…");
    try {
      const blob = await (await api(`/api/sets/${id}/export?format=${format}`)).blob();
      download(blob, `${s?.title || "Экзаменационные билеты"}.${format}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy(false);
    }
  }

  $("#cab-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = +btn.closest(".set").dataset.id;
    const s = cabinetSets.find((x) => x.id === id);
    const act = btn.dataset.act;
    if (act === "open") openSet(id);
    else if (act === "docx" || act === "pdf") downloadSet(id, act);
    else if (act === "rename") {
      const title = prompt("Новое название набора", s.title);
      if (!title || !title.trim() || title.trim() === s.title) return;
      try {
        const { set } = await (await api(`/api/sets/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim() }),
        })).json();
        Object.assign(s, set);
        if (state.currentSet?.id === id) setCurrentSet(set);
        drawCabinet();
      } catch (err) { toast(err.message, true); }
    } else if (act === "delete") {
      if (!confirm(`Удалить набор «${s.title}»? Это действие нельзя отменить.`)) return;
      try {
        await api(`/api/sets/${id}`, { method: "DELETE" });
        cabinetSets = cabinetSets.filter((x) => x.id !== id);
        if (state.currentSet?.id === id) setCurrentSet(null);
        drawCabinet();
        toast("Набор удалён");
      } catch (err) { toast(err.message, true); }
    }
  });
  $("#cab-search").addEventListener("input", drawCabinet);
  $("#cab-new").addEventListener("click", () => {
    if ((el.q.theory.value.trim() || el.q.practice.value.trim()) && !confirm("Начать новый набор? Текущие вопросы будут очищены (сохранённые наборы не пострадают).")) return;
    setCurrentSet(null);
    el.q.theory.value = el.q.practice.value = "";
    state.seed = Math.floor(Math.random() * 2 ** 31);
    $("#cabinet-dialog").close();
    refresh();
    toast("Новый набор");
  });
  $("#cab-logout").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* всё равно выходим */ }
    setUser(null);
    $("#cabinet-dialog").close();
    toast("Вы вышли из личного кабинета");
  });
  // После перезагрузки страницы: проверяем, что набор ещё существует, и подтягиваем его шаблон.
  async function reattachSet(remembered) {
    try {
      const res = await fetch(`/api/sets/${remembered.id}`, { credentials: "same-origin" });
      if (!res.ok) return setCurrentSet(null);
      const { set } = await res.json();
      setCurrentSet(set);
      if (set.hasTemplate && !state.templateFile) {
        const blob = await (await api(`/api/sets/${set.id}/template`)).blob();
        await loadTemplate(new File([blob], set.templateName || "template.docx", { type: blob.type }), "saved");
        refresh();
      }
    } catch { setCurrentSet(null); }
  }

  $("#btn-account").addEventListener("click", () => (state.user ? openCabinet() : openAuth()));
  $$("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

  // ------------------------------------------------- библиотека шаблонов
  var libraryTemplates = [];

  async function loadLibrary() {
    try {
      libraryTemplates = (await (await fetch("/api/templates/library")).json()).templates || [];
    } catch { libraryTemplates = []; }
    syncTemplateUi();
  }

  function syncTemplateUi() {
    const sel = $("#tpl-select");
    const src = state.templateSource || "default";
    const opts = [`<option value="default">Стандартный (ГБПОУ КМП)</option>`];
    if (libraryTemplates.length) {
      opts.push(`<optgroup label="Библиотека шаблонов">${libraryTemplates
        .map((t) => `<option value="lib:${t.id}">${escapeHtml(t.title)}${t.institution ? `, ${escapeHtml(t.institution)}` : ""}</option>`)
        .join("")}</optgroup>`);
    }
    if (src === "custom" || src === "saved") {
      opts.push(`<option value="${src}">${src === "saved" ? "Шаблон сохранённого набора" : "Свой"}: ${escapeHtml(state.templateFile?.name || "")}</option>`);
    }
    sel.innerHTML = opts.join("");
    sel.value = src;
    $("#tpl-lib-row").hidden = libraryTemplates.length === 0;
    $("#tpl-submit").hidden = src !== "custom";
  }

  $("#tpl-select").addEventListener("change", async (e) => {
    const v = e.target.value;
    if (v === state.templateSource) return;
    busy(true, "Загрузка шаблона…");
    try {
      if (v === "default") {
        state.fields = {};
        await loadTemplate(null);
      } else if (v.startsWith("lib:")) {
        const t = libraryTemplates.find((x) => `lib:${x.id}` === v);
        const res = await fetch(`/api/templates/library/${t.id}/file`);
        if (!res.ok) throw new Error(await apiError(res));
        const blob = await res.blob();
        state.fields = {};
        await loadTemplate(new File([blob], t.filename || `${t.title}.docx`, { type: blob.type }), v);
      }
      state.templateDirty = true;
      refresh();
      toast("Шаблон выбран");
    } catch (err) {
      toast(err.message, true);
      syncTemplateUi();
    } finally {
      busy(false);
    }
  });

  // ---- отправка шаблона на сайт
  let submitFile = null;
  function setSubmitFile(file) {
    submitFile = file;
    $("#submit-file-name").textContent = file ? file.name : "Файл не выбран";
    $("#submit-file-meta").textContent = file ? `${Math.max(1, Math.round(file.size / 1024))} КБ` : "Выберите шаблон .docx";
    if (file && !$("#submit-title").value) $("#submit-title").value = file.name.replace(/\.docx$/i, "");
  }

  function openSubmit(file) {
    if (!state.user) {
      return openAuth("Войдите или зарегистрируйтесь, чтобы отправить шаблон на сайт.", () => openSubmit(file));
    }
    $("#submit-form").reset();
    $("#submit-error").hidden = true;
    setSubmitFile(file || null);
    $("#submit-dialog").showModal();
    $("#submit-title").focus();
  }

  $("#tpl-submit").addEventListener("click", () => openSubmit(state.templateFile));
  $("#submit-consent").addEventListener("change", () => ($("#submit-error").hidden = true));
  $("#tpl-submit-new").addEventListener("click", () => openSubmit(null));
  $("#submit-file").addEventListener("change", (e) => {
    if (e.target.files[0]) setSubmitFile(e.target.files[0]);
    e.target.value = "";
  });
  $("#submit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#submit-error");
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    if (!submitFile) return fail("Выберите файл шаблона.");
    if (!$("#submit-title").value.trim()) return fail("Укажите название шаблона.");
    if (!$("#submit-consent").checked) return fail("Отметьте согласие на публикацию, без него шаблон не будет отправлен.");
    const fd = new FormData();
    fd.append("template", submitFile);
    fd.append("title", $("#submit-title").value.trim());
    fd.append("institution", $("#submit-institution").value.trim());
    fd.append("description", $("#submit-description").value.trim());
    fd.append("consent", "true");
    const btn = $("#submit-send");
    btn.disabled = true;
    try {
      await api("/api/templates/submissions", { method: "POST", body: fd });
      $("#submit-dialog").close();
      toast("Шаблон отправлен на проверку. Статус смотрите в личном кабинете, вкладка «Мои шаблоны»");
      if ($("#cabinet-dialog").open) loadMyTemplates();
    } catch (ex) {
      fail(ex.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- мои шаблоны
  async function loadMyTemplates() {
    const list = $("#my-templates");
    list.innerHTML = `<li class="empty">Загрузка…</li>`;
    try {
      const items = (await (await api("/api/templates/submissions/mine")).json()).submissions;
      list.innerHTML = items.length
        ? items
            .map(
              (t) => `<li class="set" data-id="${t.id}">
          <h4><span>${escapeHtml(t.title)}</span><em class="status ${t.status}">${t.statusText}</em></h4>
          <div class="meta">
            ${t.institution ? `<span>${escapeHtml(t.institution)}</span>` : ""}
            <span>${escapeHtml(t.filename)}</span>
            <span>Отправлен ${fmtDate(t.createdAt)}</span>
          </div>
          <div class="actions">${t.status === "pending" ? '<button class="btn small ghost danger" data-act="withdraw" type="button">Отозвать</button>' : ""}</div>
          ${t.note ? `<p class="note">Комментарий администратора: ${escapeHtml(t.note)}</p>` : ""}
        </li>`,
            )
            .join("")
        : `<li class="empty"><div><strong>Вы ещё не отправляли шаблоны</strong>Загрузите свой шаблон в блоке «Шаблон билета» и нажмите «Отправить на сайт» или кнопку выше.</div></li>`;
    } catch (err) {
      list.innerHTML = `<li class="empty">${escapeHtml(err.message)}</li>`;
    }
  }
  $("#my-templates").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act=withdraw]");
    if (!b || !confirm("Отозвать шаблон с проверки?")) return;
    try {
      await api(`/api/templates/submissions/${b.closest(".set").dataset.id}`, { method: "DELETE" });
      loadMyTemplates();
      toast("Шаблон отозван");
    } catch (err) { toast(err.message, true); }
  });

  // ---- модерация (только для администратора)
  let modItems = [];
  async function loadModeration() {
    const list = $("#mod-list");
    const status = $("input[name=mod-status]:checked").value;
    list.innerHTML = `<li class="empty">Загрузка…</li>`;
    try {
      const data = await (await api(`/api/admin/submissions?status=${status}`)).json();
      modItems = data.submissions;
      updateModBadge(data.counts.pending || 0);
      list.innerHTML = modItems.length
        ? modItems
            .map(
              (t) => `<li class="set" data-id="${t.id}">
          <h4><span>${escapeHtml(t.title)}</span><em class="status ${t.status}">${t.statusText}</em></h4>
          <div class="meta">
            <span>От: ${escapeHtml(t.author)}</span>
            <span>${escapeHtml(t.filename)}</span>
            <span>Отправлен ${fmtDate(t.createdAt)}</span>
          </div>
          <div class="actions">
            <button class="btn small secondary" data-act="try" type="button" title="Загрузить шаблон в редактор, чтобы посмотреть билеты">Проверить</button>
            <button class="btn small ghost" data-act="download" type="button">.docx</button>
          </div>
          <div class="mod-edit">
            <label class="text-field"><span>Название</span><input type="text" data-f="title" maxlength="150" value="${escapeHtml(t.title)}" /></label>
            <label class="text-field"><span>Учебное заведение</span><input type="text" data-f="institution" maxlength="200" value="${escapeHtml(t.institution)}" /></label>
            <label class="text-field wide"><span>Описание</span><input type="text" data-f="description" maxlength="1000" value="${escapeHtml(t.description)}" /></label>
            <label class="text-field wide"><span>Комментарий автору</span><input type="text" data-f="note" maxlength="500" value="${escapeHtml(t.note)}" placeholder="Например, причина отклонения" /></label>
            <div class="row gap-s wrap wide">
              ${t.status !== "approved" ? '<button class="btn small primary" data-act="approve" type="button">Опубликовать</button>' : '<button class="btn small secondary" data-act="approve" type="button">Сохранить изменения</button>'}
              ${t.status === "pending" ? '<button class="btn small ghost danger" data-act="reject" type="button">Отклонить</button>' : ""}
              ${t.status === "approved" ? '<button class="btn small ghost danger" data-act="remove" type="button">Снять с публикации</button>' : ""}
            </div>
          </div>
        </li>`,
            )
            .join("")
        : `<li class="empty">Нет шаблонов в этом разделе</li>`;
    } catch (err) {
      list.innerHTML = `<li class="empty">${escapeHtml(err.message)}</li>`;
    }
  }

  function updateModBadge(n) {
    const badge = $("#mod-count");
    badge.textContent = n;
    badge.hidden = !n;
  }

  $$("input[name=mod-status]").forEach((r) => r.addEventListener("change", loadModeration));
  $("#mod-list").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const li = b.closest(".set");
    const id = +li.dataset.id;
    const item = modItems.find((x) => x.id === id);
    const act = b.dataset.act;
    try {
      if (act === "download" || act === "try") {
        const blob = await (await api(`/api/admin/submissions/${id}/file`)).blob();
        if (act === "download") return download(blob, item.filename);
        state.fields = {};
        await loadTemplate(new File([blob], item.filename, { type: blob.type }), "custom");
        state.templateDirty = true;
        refresh();
        $("#cabinet-dialog").close();
        toast(`Шаблон «${item.title}» загружен в редактор для проверки`);
        return;
      }
      if (act === "reject" && !confirm("Отклонить шаблон?")) return;
      if (act === "remove" && !confirm("Снять шаблон с публикации? Он пропадёт из библиотеки.")) return;
      const body = { action: act };
      $$("[data-f]", li).forEach((inp) => (body[inp.dataset.f] = inp.value));
      await api(`/api/admin/submissions/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast({ approve: "Шаблон опубликован в библиотеке", reject: "Шаблон отклонён", remove: "Шаблон снят с публикации" }[act]);
      loadModeration();
      loadLibrary();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // --------------------------------------- реклама и Яндекс Метрика
  function loadScriptOnce(src) {
    if ([...document.scripts].some((sc) => sc.src === src)) return;
    const sc = document.createElement("script");
    sc.src = src;
    sc.async = true;
    document.head.append(sc);
  }

  function setupAds(ads) {
    const slots = [
      ["sidebar", "#ad-sidebar", "yandex_rtb_sidebar"],
      ["bottom", "#ad-bottom", "yandex_rtb_bottom"],
    ].filter(([key]) => ads?.[key]);
    if (!slots.length) return;
    window.yaContextCb = window.yaContextCb || [];
    loadScriptOnce("https://yandex.ru/ads/system/context.js");
    for (const [key, wrap, renderTo] of slots) {
      $(wrap).hidden = false;
      window.yaContextCb.push(() => {
        window.Ya.Context.AdvManager.render({ blockId: ads[key], renderTo });
      });
    }
  }

  function setupMetrika(id) {
    if (!id) return;
    window.ym = window.ym || function () { (window.ym.a = window.ym.a || []).push(arguments); };
    window.ym.l = Date.now();
    loadScriptOnce("https://mc.yandex.ru/metrika/tag.js");
    window.ym(id, "init", { clickmap: true, trackLinks: true, accurateTrackBounce: true });
  }

  // ---- согласие на cookie
  const CONSENT_KEY = "creatortecets:cookie-consent";
  let siteConfig = null;
  let thirdPartyLoaded = false;

  function getConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
  }

  // Сторонние cookie (Метрика, реклама) — только после согласия «Принять все».
  function applyConsent() {
    const consent = getConsent();
    const hasThirdParty = !!(siteConfig && (siteConfig.metrika || siteConfig.ads?.sidebar || siteConfig.ads?.bottom));
    $("#cookie-banner").hidden = !!consent;
    if (consent === "all" && hasThirdParty && !thirdPartyLoaded) {
      thirdPartyLoaded = true;
      setupMetrika(siteConfig.metrika);
      setupAds(siteConfig.ads);
    }
  }

  function setConsent(value) {
    const before = getConsent();
    try { localStorage.setItem(CONSENT_KEY, value); } catch { /* */ }
    // Отзыв согласия: перезагружаем страницу, чтобы выгрузить сторонние скрипты.
    if (before === "all" && value !== "all" && thirdPartyLoaded) return location.reload();
    applyConsent();
  }

  $("#cookie-all").addEventListener("click", () => setConsent("all"));
  $("#cookie-necessary").addEventListener("click", () => setConsent("necessary"));
  $("#cookie-settings").addEventListener("click", () => ($("#cookie-banner").hidden = false));
  $("#footer-year").textContent = new Date().getFullYear();

  fetch("/api/config")
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => { siteConfig = cfg; applyConsent(); })
    .catch(() => applyConsent());

  // ------------------------------------------------- мобильная раскладка
  // Кнопки нижней панели и мобильного блока повторяют действия основных кнопок.
  $$("[data-proxy]").forEach((b) => b.addEventListener("click", () => $(b.dataset.proxy).click()));

  function setMobileView(view) {
    document.body.classList.toggle("m-preview", view === "preview");
    $$(".mobile-tabs [data-mview]").forEach((t) => {
      t.classList.toggle("active", t.dataset.mview === view);
      t.setAttribute("aria-selected", t.dataset.mview === view);
    });
    window.scrollTo({ top: 0 });
    if (view === "preview") renderPreview();
  }
  $$(".mobile-tabs [data-mview]").forEach((t) => t.addEventListener("click", () => setMobileView(t.dataset.mview)));

  // ------------------------------------------------------------------ init
  (async () => {
    restore();
    await loadLibrary();
    try {
      await loadTemplate(null);
    } catch (err) {
      toast(`Не удалось загрузить шаблон: ${err.message}`, true);
    }
    refresh();
    try {
      const { user } = await (await fetch("/api/auth/me", { credentials: "same-origin" })).json();
      const remembered = state.currentSet;
      setUser(user);
      if (user && remembered) await reattachSet(remembered);
    } catch { /* сервер недоступен */ }
    try {
      const h = await (await fetch("/api/health")).json();
      if (!h.pdf) {
        el.btnPdf.title = "На сервере не установлен LibreOffice";
        toast("PDF-экспорт недоступен: на сервере нет LibreOffice", true);
      }
    } catch { /* сервер недоступен */ }
  })();
})();

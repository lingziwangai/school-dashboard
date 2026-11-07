// 屏幕端：日历 + 公告字幕 + 小狼 AI
import { api } from "./api.js";
import {
  store, emit, setLang as setStoreLang,
  subjectName, subjectById, groupByDate, todayStr, parseISO, daysBetween,
} from "./store.js";
import { t, getLang, setLang as persistLang, applyI18n } from "./i18n.js";
import { bindThemeButton, refreshThemeButtons } from "./theme.js";
import { createWolf } from "./wolf.js";
import { renderTagBar, renderTagBarLegend } from "./tagbar.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  viewDate: new Date(),
  mode: "month",           // day | week | month | academic
  selected: null,
  streaming: false,
  chat: [],
  lastAnnouncementCount: -1,
  banner: null,        // 最近一次 /api/banner 的结果，resize 时重画用
  sideCollapsed: false,
  renderToken: 0,      // 异步渲染时用来判断是不是已经切到别的视图了
};

const wolf = createWolf($("#wolf"));

// ---------------------------------------------------------------- 工具

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** 学年起始日（月-日），默认 8 月 1 日 */
function academicStart() {
  const [m, d] = (store.meta?.academic_year_start || "08-01").split("-").map(Number);
  return { month: m || 8, day: d || 1 };
}

/** 某个日期所属的学年（起始年） */
function academicYearOf(date) {
  const { month, day } = academicStart();
  const y = date.getFullYear();
  const startThis = new Date(y, month - 1, day);
  return date >= startThis ? y : y - 1;
}

// ---------------------------------------------------------------- 日历渲染

/** 按当前视图翻页：日 ±1 天，周 ±7 天，月 ±1 月，学年 ±1 年。 */
function step(dir) {
  const d = state.viewDate;
  if (state.mode === "day") {
    state.viewDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dir);
  } else if (state.mode === "week") {
    state.viewDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dir * 7);
  } else if (state.mode === "month") {
    state.viewDate = addMonths(d, dir);
  } else {
    state.viewDate = new Date(d.getFullYear() + dir, d.getMonth(), 1);
  }
  state.selected = null;
}

/** 「上一月」「下一月」这些按钮的文字要跟着视图变。 */
function updateNavLabels() {
  const [prevKey, nextKey] = {
    day: ["prev_day", "next_day"],
    week: ["prev_week", "next_week"],
    month: ["prev", "next"],
    academic: ["prev_year", "next_year"],
  }[state.mode] || ["prev", "next"];
  $("#prevBtn").textContent = t(prevKey);
  $("#nextBtn").textContent = t(nextKey);
}

/** 侧栏显隐。日/周视图整屏，用户手动收起也算。 */
function applySideState() {
  document.body.classList.toggle("side-collapsed", state.sideCollapsed);
}

function renderWeekdays() {
  const names = t("weekday_names");
  $("#weekdays").innerHTML = names.map((n) => `<div>${n}</div>`).join("");
}

function renderLegend() {
  $("#calLegend").innerHTML = store.subjects
    .map((s) => `<span><i class="dot" style="background:${s.color}"></i>${
      store.lang === "en" ? s.name_en : s.name_zh
    }</span>`)
    .join("");
}

function chipHtml(chip) {
  const cls = chip.is_stage ? "chip stage" : "chip";
  const label = chip.is_stage && chip.stage_name
    ? `${chip.stage_name} · ${chip.title}`
    : chip.title;
  return `<div class="${cls}${chip.past ? " past" : ""}" style="border-left-color:${chip.color}" title="${escapeHtml(label)}">
            <span>${escapeHtml(label)}</span>
          </div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * 把小狼的回答排版成能看的段落。
 * 先转义再替换标签，所以模型说什么都插不进 HTML。
 * 只认三样：换行分段、- 开头的列表、**加粗**。
 */
function renderAnswer(text, suffix = "") {
  const inline = (s) => s
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const lines = escapeHtml(text).split("\n");
  let html = "";
  let openList = false;
  for (const raw of lines) {
    const item = raw.match(/^\s*[-*•]\s+(.*)$/);
    if (item) {
      if (!openList) { html += "<ul>"; openList = true; }
      html += `<li>${inline(item[1])}</li>`;
      continue;
    }
    if (openList) { html += "</ul>"; openList = false; }
    const head = raw.match(/^\s*#{1,6}\s+(.*)$/);
    const line = head ? head[1] : raw;
    if (!line.trim()) { html += "<div class='md-gap'></div>"; continue; }
    html += `<div class="md-line">${inline(line)}</div>`;
  }
  if (openList) {
    // 光标要落在最后一个列表项里，不能跑到列表外面
    return html.replace(/<\/li>$/, "</li>" + suffix) + "</ul>";
  }
  return html + suffix;
}

/** 距离今天还有几天 → 倒计时文案。days 为负数表示已经过去。 */
function countdownText(days) {
  if (days === 0) return t("today_in");
  if (days > 0) return t("days_left", { n: days });
  return t("passed");
}

/** 倒计时的紧急程度样式：已过 / 7 天内 / 还早 */
function countdownClass(days) {
  if (days < 0) return "past";
  if (days === 0) return "soon";
  return days <= 7 ? "soon" : "";
}

function renderMonth() {
  const y = state.viewDate.getFullYear();
  const m = state.viewDate.getMonth();
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;   // 周一为一周之始
  const gridStart = new Date(y, m, 1 - offset);
  const grouped = groupByDate();
  const today = todayStr();

  $("#calTitle").textContent = store.lang === "en"
    ? `${m + 1}/${y}`
    : `${y} 年 ${m + 1} 月`;
  $("#calGrid").innerHTML = "";
  $("#calGrid").classList.remove("hidden");
  $("#weekdays").classList.remove("hidden");
  clearExtraViews();

  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const key = fmtDate(d);
    const cell = document.createElement("div");
    cell.className = "day-cell";
    if (d.getMonth() !== m) cell.classList.add("other");
    if (key === today) cell.classList.add("today");
    if (key === state.selected) cell.classList.add("selected");

    const chips = grouped.get(key) || [];
    const shown = chips.slice(0, 3);
    cell.innerHTML = `<div class="day-num">${d.getDate()}</div>
      <div class="day-chips">${shown.map(chipHtml).join("")}${
        chips.length > shown.length
          ? `<div class="chip more">+${chips.length - shown.length}</div>`
          : ""
      }</div>`;

    cell.addEventListener("click", () => openDay(key));
    $("#calGrid").appendChild(cell);
  }
}

function renderAcademic() {
  const ayStart = academicYearOf(state.viewDate);
  const { month } = academicStart();
  $("#calTitle").textContent = `${ayStart}–${ayStart + 1} ${store.lang === "en" ? "Academic Year" : "学年"}`;
  $("#calGrid").classList.add("hidden");
  $("#weekdays").classList.add("hidden");
  clearExtraViews();

  let wrap = document.querySelector(".academic-grid");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "academic-grid";
    $("#calGrid").after(wrap);
  }

  const grouped = groupByDate();
  const today = todayStr();
  const wd = t("weekday_names");
  let html = "";
  for (let i = 0; i < 12; i++) {
    const d = new Date(ayStart, month - 1 + i, 1);
    const y = d.getFullYear();
    const mo = d.getMonth();
    const offset = (d.getDay() + 6) % 7;
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    let days = "";
    for (let k = 0; k < offset; k++) days += `<div class="mini-day"></div>`;
    for (let day = 1; day <= daysInMonth; day++) {
      const key = fmtDate(new Date(y, mo, day));
      const chips = grouped.get(key) || [];
      const dots = chips.slice(0, 3)
        .map((c) => `<i style="background:${c.color}"></i>`)
        .join("");
      days += `<div class="mini-day ${chips.length ? "has" : ""} ${key === today ? "today" : ""}"
                   data-date="${key}">${day}${
        dots ? `<span class="mini-dots">${dots}</span>` : ""
      }</div>`;
    }
    html += `<div class="mini-month">
              <h4>${y}.${String(mo + 1).padStart(2, "0")}</h4>
              <div class="mini-grid">${wd.map((n) => `<div class="mini-wd">${n[0] ?? n}</div>`).join("")}${days}</div>
            </div>`;
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll(".mini-day[data-date]").forEach((el) => {
    el.addEventListener("click", () => openDay(el.dataset.date));
  });
}

/** 换视图时把上一种视图留下的临时容器删掉。 */
function clearExtraViews() {
  document.querySelector(".week-grid")?.remove();
  document.querySelector(".day-view")?.remove();
  document.querySelector(".academic-grid")?.remove();
}

/** 一周里周一的日期。 */
function weekStartOf(d) {
  const dow = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
}

function shortDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 周视图：七列，一列一天。 */
function renderWeek() {
  const start = weekStartOf(state.viewDate);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const grouped = groupByDate();
  const today = todayStr();
  const wd = t("weekday_names");

  $("#calGrid").classList.add("hidden");
  $("#weekdays").classList.add("hidden");
  clearExtraViews();

  let wrap = document.querySelector(".week-grid");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "week-grid";
    $("#calGrid").after(wrap);
  }

  $("#calTitle").textContent = store.lang === "en"
    ? `${shortDate(start)} – ${shortDate(end)}`
    : `${start.getFullYear()} 年 ${shortDate(start)} – ${shortDate(end)}`;

  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = fmtDate(d);
    const chips = grouped.get(key) || [];
    const items = chips.map(chipHtml).join("");
    html += `<div class="week-col ${key === today ? "today" : ""}" data-date="${key}">
        <div class="week-col-head">
          <span class="wd">${escapeHtml(wd[i] ?? "")}</span>
          <span class="dd">${shortDate(d)}</span>
        </div>
        <div class="week-col-body">${items || `<div class="week-empty">—</div>`}</div>
      </div>`;
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll(".week-col").forEach((col) => {
    col.addEventListener("click", () => openDay(col.dataset.date));
  });
}

/** 日视图：一天占满整屏。 */
async function renderDay() {
  const dateStr = fmtDate(state.viewDate);
  const token = ++state.renderToken;

  $("#calGrid").classList.add("hidden");
  $("#weekdays").classList.add("hidden");
  clearExtraViews();

  let wrap = document.querySelector(".day-view");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "day-view";
    $("#calGrid").after(wrap);
  }

  const d = parseISO(dateStr);
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  $("#calTitle").textContent = store.lang === "en"
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;

  wrap.innerHTML = `<div class="day-view-head">
      <span class="dv-weekday">${weekday}</span>
      <span class="dv-date">${store.lang === "en"
        ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
        : `${d.getMonth() + 1} 月 ${d.getDate()} 日`}</span>
      <span class="dv-count" id="dayViewCount"></span>
    </div>
    <div class="day-view-body" id="dayViewBody"></div>`;

  const { html, cards, empty } = await buildDayContent(dateStr);
  if (token !== state.renderToken) return;   // 已经切到别的视图了

  const body = $("#dayViewBody");
  if (empty) {
    body.innerHTML = `<div class="muted" style="padding:30px 0;text-align:center">${t("no_events")}</div>`;
    $("#dayViewCount").textContent = "";
    return;
  }
  body.innerHTML = html;
  $("#dayViewCount").textContent = `${cards.length} ${t("arrangements")}`;
  attachTagBars(body, cards);
}

function renderCalendar() {
  document.body.classList.toggle("view-full", state.mode === "day" || state.mode === "week");
  if (state.mode === "day") renderDay();
  else if (state.mode === "week") renderWeek();
  else if (state.mode === "month") renderMonth();
  else renderAcademic();
}

// ---------------------------------------------------------------- 日详情

/** 某一天的活动卡片。详情要问后台，所以是异步的。日视图和侧栏共用它。 */
async function buildDayContent(dateStr) {
  const grouped = groupByDate();
  const chips = grouped.get(dateStr) || [];

  // 同一个活动的多个 chip 合并成一张卡片
  const byEvent = new Map();
  for (const chip of chips) {
    const key = chip.event_id ?? `ann-${chip.announcement_id}`;
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(chip);
  }

  if (!byEvent.size) return { html: "", cards: [], empty: true };

  const today = todayStr();
  const parts = [];
  const tagCards = [];   // 只有带标签比例条的卡片才进来，顺序和 [data-tags] 对得上

  for (const [, group] of byEvent) {
    const main = group.find((c) => !c.is_stage) || group[0];

    if (main.announcement_id) {
      const ann = store.announcements.find((a) => a.id === main.announcement_id);
      parts.push(`<div class="ev-card${main.past ? " past" : ""}" style="border-left-color:${main.color}">
          <h4>${escapeHtml(main.title)}</h4>
          ${ann?.body ? `<div class="ev-body">${escapeHtml(ann.body)}</div>` : ""}
          ${main.photo_id ? `<img class="ev-cover" src="/api/uploads/${main.photo_id}" alt="">` : ""}
        </div>`);
      continue;
    }

    let detail = null;
    try {
      detail = await api.event(main.event_id, store.lang);
    } catch (_) { /* 详情拿不到也要把列表显示出来 */ }

    const tags = detail?.tags || [];
    const tagsHtml = tags.length
      ? `<div class="ev-tagbar"><div class="ev-taglabel">${t("suitable_for")}</div>
         <div class="tagbar" data-tags></div></div>
         <div class="ev-taglegend tag-legend" data-legend></div>`
      : "";

    // 阶段日期由后端算好（循环规则 + 偏移量都在后端展开），前端不再自己推算
    const stageDates = main.stage_dates || [];
    const stageHtml = stageDates.length
      ? `<div class="ev-stages"><div class="ev-taglabel">${t("stage_preview")}</div>${stageDates.map((s) => {
          const days = daysBetween(today, s.date);
          const past = days < 0;
          return `<div class="ev-stage ${past ? "past" : ""}">
              <i class="ev-stage-dot" style="background:${s.color || main.color}"></i>
              <span>${escapeHtml(s.name)}</span>
              <span class="ev-days">${countdownText(days)}</span>
              <span class="ev-stage-date">${s.date}</span>
            </div>`;
        }).join("")}</div>`
      : "";

    const occDate = main.occurrence_date || main.date;
    const occDays = daysBetween(today, occDate);
    const countdown = `<span class="ev-countdown ${countdownClass(occDays)}">${
      countdownText(occDays)
    }</span>`;

    parts.push(`<div class="ev-card${occDays < 0 ? " past" : ""}" style="border-left-color:${main.color}">
        <div class="ev-head">
          <h4>${escapeHtml(main.title)}</h4>
          ${countdown}
        </div>
        <div class="ev-meta">
          <span class="pill"><i class="dot" style="background:${main.color}"></i>${
            escapeHtml(subjectName(main.subject))
          }</span>
          ${detail?.location ? `<span>📍 ${escapeHtml(detail.location)}</span>` : ""}
        </div>
        ${detail?.body ? `<div class="ev-body">${escapeHtml(detail.body)}</div>` : ""}
        ${stageHtml}
        ${tagsHtml}
        ${detail?.photo_id ? `<img class="ev-cover" src="/api/uploads/${detail.photo_id}" alt="">` : ""}
      </div>`);
    if (tags.length) tagCards.push({ tags });
  }

  return { html: parts.join(""), cards: tagCards, empty: false };
}

/** 把卡片里的标签比例条画出来。 */
function attachTagBars(root, tagCards) {
  root.querySelectorAll("[data-tags]").forEach((el, idx) => {
    const card = el.closest(".ev-card");
    const { tags } = tagCards[idx] || { tags: [] };
    renderTagBar(el, tags, store.lang);
    renderTagBarLegend(card.querySelector("[data-legend]"), tags, store.lang);
  });
}

async function openDay(dateStr) {
  state.selected = dateStr;
  renderCalendar();

  const d = parseISO(dateStr);
  const isToday = dateStr === todayStr();
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  $("#dayPanelTitle").textContent =
    `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${weekday}${
      isToday ? ` · ${t("today")}` : ""
    }`;

  const body = $("#dayPanelBody");
  body.innerHTML = '<div class="muted small">加载中…</div>';

  const { html, cards, empty } = await buildDayContent(dateStr);
  if (empty) {
    body.innerHTML = `<div class="muted" style="padding:24px 0;text-align:center">${
      t("no_events")
    }</div>`;
  } else {
    body.innerHTML = html;
    attachTagBars(body, cards);
  }

  $("#dayPanel").classList.add("open");
  $("#dayScrim").classList.add("show");
}

// ---------------------------------------------------------------- 公告字幕

function renderBanner(payload) {
  const track = $("#marqueeTrack");
  const anns = payload.announcements || [];
  const deadlines = payload.deadlines || [];

  $("#bannerHint").textContent = deadlines.length
    ? t("banner_due", { n: deadlines.length })
    : "";

  const items = [
    ...deadlines.map((d) => ({
      html: `<span class="marquee-item" data-date="${d.date}">
               <span class="tag">⏳</span>
               <span>${escapeHtml(d.text)}</span>
             </span>`,
    })),
    ...anns.map((a) => ({
      html: `<span class="marquee-item${a.expired ? " past" : ""}" data-id="${a.id}">
               ${a.photo_id ? `<span class="tag">📷</span>` : ""}
               <span>${escapeHtml(a.title)}</span>
             </span>`,
    })),
  ];

  if (!items.length) {
    track.classList.add("static");
    track.innerHTML = `<span class="marquee-empty">${t("announcement_empty")}</span>`;
    return;
  }

  const inner = items.map((i) => i.html).join("");
  track.classList.remove("static");
  track.innerHTML = `<span class="marquee-copy">${inner}</span>`;

  // 一份内容的宽度就是一个滚动周期，复制到足够长，屏幕任何时候都不会露出空白
  const period = track.firstElementChild.getBoundingClientRect().width;
  const visible = track.parentElement.getBoundingClientRect().width;
  const copies = Math.max(2, Math.ceil((visible + period) / period));
  if (copies > 1) {
    const html = track.firstElementChild.outerHTML;
    track.innerHTML = new Array(copies).fill(html).join("");
  }
  track.style.setProperty("--marquee-shift", `-${period}px`);
  track.style.setProperty("--marquee-dur", `${Math.max(15, period / 38)}s`);

  track.querySelectorAll(".marquee-item").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (el.dataset.date) jumpToDate(el.dataset.date);
      else if (el.dataset.id) openPost(Number(el.dataset.id));
    });
  });
}

/** 跳到某一天：先翻到那个月，再打开详情 */
async function jumpToDate(dateStr) {
  state.viewDate = parseISO(dateStr);
  state.selected = null;
  await loadRange();
  renderCalendar();
  // 日/周视图本身就是那一天/那一周，不用再弹侧栏
  if (state.mode === "month" || state.mode === "academic") openDay(dateStr);
}

/** 即将到来：日历上方一条，列出最近要到期的东西 */
function renderUpcoming(deadlines) {
  const host = $("#upcoming");
  const track = $("#upcomingTrack");
  const list = deadlines || [];

  if (!list.length) {
    host.classList.add("hidden");
    track.innerHTML = `<span class="upcoming-empty">${t("no_more")}</span>`;
    return;
  }
  host.classList.remove("hidden");

  const today = todayStr();
  track.innerHTML = list.slice(0, 14).map((d) => {
    const days = daysBetween(today, d.date);
    const cls = days < 0 ? "soon" : days <= 7 ? "soon" : "";
    return `<div class="upcoming-item ${cls}" data-date="${d.date}">
        <span class="up-title">${escapeHtml(d.text)}</span>
        <span class="up-days">${countdownText(days)}</span>
      </div>`;
  }).join("");

  track.querySelectorAll("[data-date]").forEach((el) =>
    el.addEventListener("click", () => jumpToDate(el.dataset.date)));
}

function openPost(id) {
  const a = store.announcements.find((x) => x.id === id);
  if (!a) return;
  $("#postTitle").textContent = a.title;
  $("#postBody").innerHTML = `
    ${a.photo_id ? `<img src="/api/uploads/${a.photo_id}" alt=""
        style="width:100%;border-radius:10px;margin-bottom:14px">` : ""}
    <div style="white-space:pre-wrap;line-height:1.75;color:var(--text-2)">${escapeHtml(a.body)}</div>`;
  $("#postOverlay").classList.remove("hidden");
}

// ---------------------------------------------------------------- 公告大图（底部抽屉）

let annIndex = 0;

/** 把公告做成一张张卡片，横着滑。顶栏喇叭按钮可以开/收。 */
function renderAnnGallery() {
  const track = $("#annTrack");
  const list = store.announcements || [];

  $("#annCount").textContent = t("ann_count", { n: list.length });
  const badge = $("#annBadge");
  badge.textContent = String(list.length);
  badge.classList.toggle("hidden", !list.length);

  if (!list.length) {
    track.innerHTML = `<div class="ann-empty">${t("announcement_empty")}</div>`;
    $("#annDots").innerHTML = "";
    return;
  }

  track.innerHTML = list.map((a) => `
    <article class="ann-card${a.expired ? " past" : ""}" data-id="${a.id}">
      ${a.photo_id
        ? `<div class="ann-photo"><img src="/api/uploads/${a.photo_id}" alt="" loading="lazy"></div>`
        : `<div class="ann-photo ann-photo-none">📢</div>`}
      <div class="ann-body">
        <div class="ann-card-head">
          <h4>${escapeHtml(a.title)}</h4>
          ${a.starts_on ? `<span class="ann-date">${escapeHtml(a.starts_on)}</span>` : ""}
        </div>
        <div class="ann-text">${escapeHtml(a.body)}</div>
        <div class="ann-foot">
          ${a.expired ? `<span class="ann-flag">${t("ann_expired")}</span>` : ""}
          <button type="button" class="ghost ann-detail">${t("ann_detail")}</button>
        </div>
      </div>
    </article>`).join("");

  $("#annDots").innerHTML = list.map((a, i) =>
    `<i class="ann-dot${i === 0 ? " active" : ""}" data-index="${i}"></i>`).join("");

  const keep = annIndex;
  annIndex = 0;
  track.scrollLeft = 0;
  track.querySelectorAll(".ann-card").forEach((el) =>
    el.addEventListener("click", () => openPost(Number(el.dataset.id))));
  // 正在看第几条就还停在第几条，别因为来了新公告跳回第一条
  if (keep) requestAnimationFrame(() => annGoTo(keep));
}

function setAnnIndex(i) {
  const dots = $("#annDots").children;
  if (!dots.length) return;
  annIndex = Math.max(0, Math.min(dots.length - 1, i));
  [...dots].forEach((d, k) => d.classList.toggle("active", k === annIndex));
}

/** 把第 i 条滚到中间 */
function annGoTo(i) {
  const track = $("#annTrack");
  const cards = track.querySelectorAll(".ann-card");
  if (!cards.length) return;
  i = Math.max(0, Math.min(cards.length - 1, i));
  const trackRect = track.getBoundingClientRect();
  const cardRect = cards[i].getBoundingClientRect();
  const left = track.scrollLeft + (cardRect.left - trackRect.left) - (track.clientWidth - cardRect.width) / 2;
  track.scrollTo({ left, behavior: "smooth" });
  setAnnIndex(i);
}

/** 滑完之后数一下现在正对着的是第几条，把小圆点对上 */
function trackAnnScroll() {
  clearTimeout(trackAnnScroll._timer);
  trackAnnScroll._timer = setTimeout(() => {
    const track = $("#annTrack");
    const cards = track.querySelectorAll(".ann-card");
    if (!cards.length) return;
    const mid = track.getBoundingClientRect().left + track.clientWidth / 2;
    let best = 0;
    let bestDist = Infinity;
    cards.forEach((c, i) => {
      const r = c.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - mid);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    setAnnIndex(best);
  }, 90);
}

function setAnnDrawer(open) {
  $("#annDrawer").classList.toggle("open", open);
  $("#annToggle").classList.toggle("active", open);
  if (open) requestAnimationFrame(() => annGoTo(annIndex));
}

// ---------------------------------------------------------------- AI 对话

function aiLog(message, role = "bot") {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = message;
  $("#aiLog").appendChild(el);
  $("#aiLog").scrollTop = $("#aiLog").scrollHeight;
  return el;
}

function renderQuick() {
  const prompts = [t("ask_upcoming"), t("ask_ap"), t("ask_category")];
  $("#aiQuick").innerHTML = prompts.map((p) => `<button type="button">${escapeHtml(p)}</button>`).join("");
  $("#aiQuick").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      $("#aiInput").value = b.textContent;
      $("#aiForm").requestSubmit();
    });
  });
}

async function sendChat(text) {
  const question = (text || "").trim();
  if (!question || state.streaming) return;
  // 折叠着也能提问，一提问就把对话框展开
  $("#aiBox").classList.remove("collapsed");
  localStorage.setItem("rb_ai", "open");
  $("#aiInput").value = "";
  aiLog(escapeHtml(question), "user");
  state.chat.push({ role: "user", content: question });

  const bubble = aiLog(`${t("ai_thinking")}<span class='caret'></span>`, "bot");
  state.streaming = true;
  setFace("thinking");

  let answer = "";
  try {
    const res = await fetch("/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.chat }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data);
          if (obj.token) {
            answer += obj.token;
            bubble.innerHTML = renderAnswer(answer, '<span class="caret"></span>');
            $("#aiLog").scrollTop = $("#aiLog").scrollHeight;
          }
          if (obj.error) throw new Error(obj.error);
        } catch (err) {
          if (err instanceof SyntaxError) continue;
          throw err;
        }
      }
    }
  } catch (err) {
    answer += `\n[${t("ai_unavailable")}]`;
    setFace("alert");
  }

  bubble.innerHTML = renderAnswer(answer.trim());
  state.chat.push({ role: "assistant", content: answer.trim() });
  if (state.chat.length > 12) state.chat = state.chat.slice(-12);
  state.streaming = false;
  setFace("idle");
}

// ---------------------------------------------------------------- 表情状态

async function setFace(expression) {
  wolf.setExpression(expression);
  try {
    await api.setFace(expression);
  } catch (_) { /* 未登录时会失败，屏幕端不登录，忽略 */ }
}

// ---------------------------------------------------------------- 数据加载

async function loadCalendar(start, end) {
  const res = await api.calendarRange(start, end, todayStr(), store.lang);
  store.chips = res.chips;
  emit();
}

async function loadFeed() {
  const [annRes, bannerRes] = await Promise.all([
    // 过期的公告也要留着，只是显示成灰色，所以这里取全部
    api.announcements(store.lang, "all").catch(() => ({ announcements: [] })),
    api.banner(store.lang).catch(() => ({ announcements: [], deadlines: [], upcoming: [] })),
  ]);

  store.announcements = annRes.announcements || [];
  if (state.lastAnnouncementCount === -1) {
    state.lastAnnouncementCount = store.announcements.length;
  } else if (store.announcements.length > state.lastAnnouncementCount) {
    setFace("happy");
    setTimeout(() => { if (!state.streaming) setFace("idle"); }, 4000);
    state.lastAnnouncementCount = store.announcements.length;
  }

  renderBanner(bannerRes);
  renderUpcoming(bannerRes.upcoming || []);
  renderAnnGallery();
  state.banner = bannerRes;
}

async function loadRange() {
  if (state.mode === "day") {
    const k = fmtDate(state.viewDate);
    await loadCalendar(k, k);
  } else if (state.mode === "week") {
    const start = weekStartOf(state.viewDate);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    await loadCalendar(fmtDate(start), fmtDate(end));
  } else if (state.mode === "month") {
    const y = state.viewDate.getFullYear();
    const m = state.viewDate.getMonth();
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(y, m, 1 - offset);
    const end = new Date(y, m, 1 - offset + 41);
    await loadCalendar(fmtDate(start), fmtDate(end));
  } else {
    const ayStart = academicYearOf(state.viewDate);
    const { month, day } = academicStart();
    await loadCalendar(fmtDate(new Date(ayStart, month - 1, day)),
                       fmtDate(new Date(ayStart + 1, month - 2, day + 1)));
  }
}

// ---------------------------------------------------------------- 同步轮询

let lastRevision = -1;

async function pollSync() {
  if (document.hidden) return;
  try {
    const { revision } = await api.version();
    if (revision === lastRevision) return;
    lastRevision = revision;
    await loadRange();
    await loadFeed();
    if (state.selected) openDay(state.selected);
  } catch (_) { /* 断网就等下一轮 */ }
}

async function pollFace() {
  if (state.streaming) return;
  try {
    const f = await api.faceState();
    wolf.setExpression(f.expression);
  } catch (_) { /* noop */ }
}

// ---------------------------------------------------------------- 时钟

function applySchoolName() {
  if (!store.meta) return;
  const name = store.lang === "en"
    ? store.meta.school_name_en : store.meta.school_name_zh;
  $("#schoolName").textContent = name;
  document.title = name || t("app_title");
}

function tickClock() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const wd = (store.lang === "en"
    ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    : ["周日", "周一", "周二", "周三", "周四", "周五", "周六"])[now.getDay()];
  $("#clockDate").textContent = store.lang === "en"
    ? `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${wd}`
    : `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${wd}`;
  $("#clockTime").textContent = `${p(now.getHours())}:${p(now.getMinutes())}`;
}

// ---------------------------------------------------------------- 启动

function bindUI() {
  $("#prevBtn").addEventListener("click", async () => {
    step(-1);
    await loadRange();
    renderCalendar();
  });
  $("#nextBtn").addEventListener("click", async () => {
    step(1);
    await loadRange();
    renderCalendar();
  });
  $("#todayBtn").addEventListener("click", async () => {
    state.viewDate = new Date();
    state.selected = null;
    await loadRange();
    renderCalendar();
  });

  $("#viewSwitch").addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".seg-btn");
    if (!btn) return;
    state.mode = btn.dataset.mode;
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    updateNavLabels();
    await loadRange();
    renderCalendar();
  });

  // 侧栏收起 / 展开
  $("#sideToggle").addEventListener("click", () => {
    state.sideCollapsed = !state.sideCollapsed;
    localStorage.setItem("rb_side", state.sideCollapsed ? "collapsed" : "open");
    applySideState();
  });

  // AI 对话框折叠
  $("#aiToggle").addEventListener("click", () => {
    const box = $("#aiBox");
    const collapsed = box.classList.toggle("collapsed");
    localStorage.setItem("rb_ai", collapsed ? "collapsed" : "open");
  });

  $("#langBtn").addEventListener("click", async () => {
    const next = store.lang === "zh" ? "en" : "zh";
    persistLang(next);
    setStoreLang(next);
    applyI18n();
    renderWeekdays();
    renderLegend();
    renderQuick();
    tickClock();
    $("#langBtn").textContent = next === "zh" ? "EN" : "中文";
    refreshThemeButtons();
    updateNavLabels();
    applySchoolName();
    await loadRange();
    await loadFeed();
    renderCalendar();
  });

  bindThemeButton($("#themeBtn"));

  $("#dayClose").addEventListener("click", closeDay);
  $("#dayScrim").addEventListener("click", closeDay);
  $("#postClose").addEventListener("click", () => $("#postOverlay").classList.add("hidden"));
  $("#postOverlay").addEventListener("click", (ev) => {
    if (ev.target === $("#postOverlay")) $("#postOverlay").classList.add("hidden");
  });

  $("#askAboutDay").addEventListener("click", () => {
    const q = store.lang === "en"
      ? `What is scheduled on ${state.selected}?`
      : `${state.selected} 这一天有什么安排？`;
    $("#aiInput").value = q;
    sendChat(q);
  });

  $("#aiForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    sendChat($("#aiInput").value);
  });

  // 点一下字幕就暂停滚动
  $("#marquee").addEventListener("click", (ev) => {
    if (ev.target.closest(".marquee-item")) return;
    $("#marquee").classList.toggle("paused");
  });

  // 公告大图抽屉：开 / 关 / 左右翻
  $("#annToggle").addEventListener("click", () =>
    setAnnDrawer(!$("#annDrawer").classList.contains("open")));
  $("#annClose").addEventListener("click", () => setAnnDrawer(false));
  $("#annPrev").addEventListener("click", () => annGoTo(annIndex - 1));
  $("#annNext").addEventListener("click", () => annGoTo(annIndex + 1));
  $("#annTrack").addEventListener("scroll", trackAnnScroll, { passive: true });
  $("#annDots").addEventListener("click", (ev) => {
    const dot = ev.target.closest(".ann-dot");
    if (dot) annGoTo(Number(dot.dataset.index));
  });

  // 屏幕尺寸变了，滚动周期要重新算
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.banner) renderBanner(state.banner); }, 200);
  });
}

function closeDay() {
  $("#dayPanel").classList.remove("open");
  $("#dayScrim").classList.remove("show");
  state.selected = null;
  renderCalendar();
}

async function init() {
  applyI18n();
  renderWeekdays();
  renderQuick();
  updateNavLabels();
  state.sideCollapsed = localStorage.getItem("rb_side") === "collapsed";
  applySideState();
  if (localStorage.getItem("rb_ai") === "collapsed") $("#aiBox").classList.add("collapsed");
  bindUI();
  tickClock();
  setInterval(tickClock, 10000);

  try {
    store.meta = await api.meta();
    store.subjects = store.meta.subjects;
    store.aiAvailable = store.meta.ai_available;
    applySchoolName();
    $("#aiStatus").textContent = store.aiAvailable
      ? `${t("ai_online")}` : t("ai_offline");
    $("#aiStatus").className = `ai-status ${store.aiAvailable ? "online" : "offline"}`;
    $("#langBtn").textContent = store.lang === "zh" ? "EN" : "中文";
  } catch (_) {
    toast(t("network_error"), true);
  }

  renderLegend();
  await loadRange();
  await loadFeed();
  renderCalendar();

  if (!store.aiAvailable) {
    aiLog(`${t("ai_unavailable")}<br><span class="muted">${t("ai_hint")}</span>`, "system");
  } else {
    aiLog(`${t("ai_hint")}`, "system");
  }

  lastRevision = store.meta?.revision ?? -1;
  setInterval(pollSync, 8000);
  setInterval(pollFace, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pollSync();
  });
}

init();

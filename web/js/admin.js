// 老师端：登录、活动管理、公告管理、设置
import { api } from "./api.js";
import { store, subjectById, subjectName } from "./store.js";
import { t, getLang, setLang as persistLang, applyI18n } from "./i18n.js";
import { bindThemeButton, refreshThemeButtons } from "./theme.js";
import { createTagBarEditor } from "./tagbar.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const FREQS = [
  ["none", "repeat_none", "repeat_hint_none"],
  ["daily", "repeat_daily", "repeat_hint_daily"],
  ["weekly", "repeat_weekly", "repeat_hint_weekly"],
  ["monthly", "repeat_monthly", "repeat_hint_monthly"],
  ["monthly_last", "repeat_monthly_last", "repeat_hint_monthly_last"],
  ["yearly", "repeat_yearly", "repeat_hint_yearly"],
  ["yearly_nth", "repeat_yearly_nth", "repeat_hint_yearly_nth"],
];

const WEEKDAYS = [
  ["0", "周一", "Mon"], ["1", "周二", "Tue"], ["2", "周三", "Wed"], ["3", "周四", "Thu"],
  ["4", "周五", "Fri"], ["5", "周六", "Sat"], ["6", "周日", "Sun"],
];

const NTHS = [
  ["1", "第一个", "1st"], ["2", "第二个", "2nd"], ["3", "第三个", "3rd"],
  ["4", "第四个", "4th"], ["5", "第五个", "5th"], ["-1", "最后一个", "last"],
];

const state = {
  events: [],
  posts: [],
  editing: null,        // 正在编辑的活动（null = 新建）
  editingPost: null,    // 正在编辑的公告
  photoId: null,
  postPhotoId: null,
  stages: [],
  tagEditor: null,
  previewTimer: null,
};

// ---------------------------------------------------------------- 工具

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isZh() {
  return getLang() === "zh";
}

// ---------------------------------------------------------------- 登录

async function boot() {
  const me = await api.me().catch(() => ({ authenticated: false }));
  if (me.authenticated) {
    await enterApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  $("#loginScreen").classList.remove("hidden");
  $("#adminShell").classList.add("hidden");
  applyI18n();
  $("#loginPass").focus();
}

async function enterApp() {
  $("#loginScreen").classList.add("hidden");
  $("#adminShell").classList.remove("hidden");
  const meta = await api.meta();
  store.meta = meta;
  store.subjects = meta.subjects;
  store.aiAvailable = meta.ai_available;
  renderSubjectSelect();
  renderAiBadge();
  applyI18n();
  await Promise.all([loadEvents(), loadPosts()]);
}

$("#loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const pwd = $("#loginPass").value;
  try {
    await api.login(pwd);
    $("#loginPass").value = "";
    $("#loginError").classList.add("hidden");
    await enterApp();
  } catch (err) {
    $("#loginError").classList.remove("hidden");
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await api.logout().catch(() => {});
  showLogin();
});

// ---------------------------------------------------------------- 标签页

$$(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    const tab = btn.dataset.tab;
    $("#paneEvents").classList.toggle("hidden", tab !== "events");
    $("#panePosts").classList.toggle("hidden", tab !== "posts");
    $("#paneSettings").classList.toggle("hidden", tab !== "settings");
    if (tab === "settings") loadSettings();
  });
});

$("#langBtn").addEventListener("click", async () => {
  const next = getLang() === "zh" ? "en" : "zh";
  persistLang(next);
  store.lang = next;
  applyI18n();
  renderEventList();
  renderPostList();
  renderSubjectSelect();
  renderAiBadge();
  refreshThemeButtons();
  if (state.editing) openEventForm(state.editing);
  if (state.editingPost) openPostForm(state.editingPost);
  refreshOpenFormLocale();
});

bindThemeButton($("#themeBtn"));
bindThemeButton($("#loginThemeBtn"));

/** 表单开着的时候切语言：把动态生成的词条重画一遍，但不动用户填的值 */
function refreshOpenFormLocale() {
  if (!$("#eventOverlay").classList.contains("hidden")) {
    const rec = collectRecurrence();     // 先把用户填的循环参数收上来
    $("#evFreq").innerHTML = FREQS.map(([v, label]) =>
      `<option value="${v}" ${v === rec.freq ? "selected" : ""}>${t(label)}</option>`).join("");
    renderFreqExtras(rec);
    renderStages();
    state.tagEditor?.render();
  }
  if (!$("#postOverlay").classList.contains("hidden")) {
    $("#postFormTitle").textContent = state.editingPost ? t("edit") : t("new_post");
  }
}

// ---------------------------------------------------------------- 科目 / AI 状态

function renderSubjectSelect() {
  const sel = $("#evSubject");
  const prev = sel.value;
  sel.innerHTML = store.subjects
    .map((s) => `<option value="${s.id}">${s.name_zh} · ${s.name_en}</option>`)
    .join("");
  if (prev) sel.value = prev;
}

function renderAiBadge() {
  const el = $("#aiBadge");
  const on = store.aiAvailable;
  el.textContent = `${t("ai_status")}：${on ? t("ai_online") : t("ai_offline")}`;
  el.className = `ai-badge ${on ? "online" : "offline"}`;
}

// ---------------------------------------------------------------- 活动列表

async function loadEvents() {
  const data = await api.listEvents(getLang()).catch((e) => {
    toast(e.message, true);
    return { events: [] };
  });
  state.events = data.events || [];
  renderEventList();
}

function freqLabel(freq) {
  const found = FREQS.find((f) => f[0] === freq);
  return found ? t(found[1]) : freq;
}

function renderEventList() {
  const host = $("#eventList");
  if (!state.events.length) {
    host.innerHTML = `<div class="empty-note">${t("no_events_admin")}</div>`;
    return;
  }
  host.innerHTML = state.events.map((ev) => {
    const s = subjectById(ev.subject);
    const title = ev.title || "(无标题)";
    const langMark = ev.title_src === "en" ? "EN" : ev.title_src === "zh" ? "中" : "";
    const tags = (ev.tags || []).filter((tg) => tg.weight > 0);
    const total = tags.reduce((acc, tg) => acc + tg.weight, 0) || 1;
    const bar = tags.length
      ? `<div class="tagbar tagbar-mini">${tags.map((tg) => {
          const c = subjectById(tg.tag_id).color;
          return `<span style="width:${(tg.weight / total) * 100}%;background:${c}"></span>`;
        }).join("")}</div>`
      : "";
    const stageCount = (ev.stages || []).length;
    return `
      <div class="event-row">
        <div class="color-bar" style="background:${s.color}"></div>
        <div class="ev-main">
          <div class="ev-title">${esc(title)}
            ${langMark ? `<span class="lang-mark">${langMark}</span>` : ""}
          </div>
          <div class="ev-meta">
            <span>${s.name_zh} · ${s.name_en}</span>
            <span>${freqLabel(ev.recurrence.freq)}</span>
            <span>${esc(ev.recurrence.starts_on)}</span>
            ${stageCount ? `<span>${stageCount} ${t("stage")}</span>` : ""}
          </div>
        </div>
        ${bar}
        <div class="ev-actions">
          <button class="ghost" data-edit="${ev.id}">${t("edit")}</button>
          <button class="danger" data-del="${ev.id}">${t("delete")}</button>
        </div>
      </div>`;
  }).join("");

  host.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const ev = state.events.find((x) => String(x.id) === b.dataset.edit);
      if (ev) openEventForm(ev);
    }));
  host.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ev = state.events.find((x) => String(x.id) === b.dataset.del);
      if (!ev) return;
      if (!confirm(`${t("confirm_delete")}\n\n${ev.title || ""}`)) return;
      try {
        await api.deleteEvent(ev.id);
        toast(t("saved"));
        await loadEvents();
      } catch (err) {
        toast(err.status === 409 ? t("updated_by_other") : err.message, true);
      }
    }));
}

// ---------------------------------------------------------------- 活动表单

$("#newEventBtn").addEventListener("click", () => openEventForm(null));
$("#eventFormClose").addEventListener("click", closeEventForm);
$("#eventCancel").addEventListener("click", closeEventForm);

function closeEventForm() {
  $("#eventOverlay").classList.add("hidden");
  state.editing = null;
  state.stages = [];
}

function openEventForm(ev) {
  state.editing = ev;
  state.photoId = ev ? ev.photo_id : null;
  state.stages = ev
    ? (ev.stages || []).map((s) => ({
        name_zh: s.name_zh || "",
        name_en: s.name_en || "",
        date_mode: s.date_mode || "offset",
        offset_days: s.offset_days || 0,
        fixed_md: s.fixed_md || "",
        fixed_date: s.fixed_date || "",
        show_on_calendar: s.show_on_calendar !== false,
        show_in_banner: s.show_in_banner !== false,
      }))
    : [];

  $("#eventFormTitle").textContent = ev ? t("edit") : t("new_event");
  $("#evTitleZh").value = ev ? ev.title_zh || "" : "";
  $("#evTitleEn").value = ev ? ev.title_en || "" : "";
  $("#evBodyZh").value = ev ? ev.body_zh || "" : "";
  $("#evBodyEn").value = ev ? ev.body_en || "" : "";
  $("#evLocationZh").value = ev ? ev.location_zh || "" : "";
  $("#evLocationEn").value = ev ? ev.location_en || "" : "";
  $("#evSubject").value = ev ? ev.subject : "activity";

  const rec = ev ? ev.recurrence : { freq: "none", starts_on: todayISO(), until_on: "", interval: 1 };
  $("#evFreq").innerHTML = FREQS.map(([v, label]) =>
    `<option value="${v}" ${v === rec.freq ? "selected" : ""}>${t(label)}</option>`).join("");
  $("#evStartsOn").value = rec.starts_on || todayISO();
  $("#evUntilOn").value = rec.until_on || "";
  renderFreqExtras(rec);

  renderPhotoPreview("#evPhotoPreview", "#evPhotoClear", state.photoId);
  renderStages();

  state.tagEditor = createTagBarEditor($("#evTagBar"), {
    subjects: store.subjects,
    onChange: () => {},
  });
  state.tagEditor.setValue(ev ? ev.tags || [] : []);

  $("#eventOverlay").classList.remove("hidden");
  schedulePreview();
}

$("#evFreq").addEventListener("change", () => {
  renderFreqExtras({ freq: $("#evFreq").value });
  schedulePreview();
});
$("#evStartsOn").addEventListener("change", schedulePreview);
$("#evUntilOn").addEventListener("change", schedulePreview);
$("#evFreqExtras").addEventListener("change", schedulePreview);

/** 按当前循环方式显示对应的额外字段 */
function renderFreqExtras(rec) {
  const freq = rec.freq || "none";
  const hintKey = FREQS.find((f) => f[0] === freq)?.[2];
  $("#evFreqHint").textContent = hintKey ? t(hintKey) : "";

  const host = $("#evFreqExtras");
  const num = (id, label, value, extra = "") =>
    `<div class="field"><label>${label}</label>
       <input type="number" id="${id}" value="${value ?? ""}" ${extra}></div>`;
  const sel = (id, label, value, options) =>
    `<div class="field"><label>${label}</label>
       <select id="${id}">${options.map(([v, l]) =>
         `<option value="${v}" ${String(v) === String(value) ? "selected" : ""}>${l}</option>`).join("")}</select></div>`;

  let html = "";
  if (["daily", "weekly", "monthly", "monthly_last"].includes(freq)) {
    html += num("evInterval", t("every_n"), rec.interval ?? 1, 'min="1"');
  }
  if (freq === "weekly") {
    html += sel("evByweekday", t("weekday"), rec.byweekday ?? 0,
      WEEKDAYS.map(([v, zh, en]) => [v, isZh() ? zh : en]));
  }
  if (freq === "monthly") {
    html += num("evBymonthday", t("date"), rec.bymonthday ?? 1, 'min="1" max="31"');
  }
  if (freq === "yearly" || freq === "yearly_nth") {
    html += num("evBymonth", isZh() ? "几月" : "Month", rec.bymonth ?? new Date().getMonth() + 1, 'min="1" max="12"');
  }
  if (freq === "yearly_nth") {
    html += sel("evBynth", t("nth"), rec.bynth ?? 1,
      NTHS.map(([v, zh, en]) => [v, isZh() ? zh : en]));
    html += sel("evByweekday2", t("weekday"), rec.byweekday ?? 0,
      WEEKDAYS.map(([v, zh, en]) => [v, isZh() ? zh : en]));
  }
  html += num("evMaxCount", isZh() ? "最多几次" : "Max times", rec.max_count ?? "", 'min="1"');
  host.innerHTML = html;
}

/** 从表单收集循环规则 */
function collectRecurrence() {
  const freq = $("#evFreq").value;
  const rec = {
    freq,
    interval: Number($("#evInterval")?.value || 1),
    starts_on: $("#evStartsOn").value || todayISO(),
    until_on: $("#evUntilOn").value || null,
    max_count: Number($("#evMaxCount")?.value) || null,
    byweekday: null,
    bynth: null,
    bymonth: null,
    bymonthday: null,
  };
  if (freq === "weekly") rec.byweekday = Number($("#evByweekday")?.value || 0);
  if (freq === "monthly") rec.bymonthday = Number($("#evBymonthday")?.value || 1);
  if (freq === "yearly" || freq === "yearly_nth") rec.bymonth = Number($("#evBymonth")?.value || 1);
  if (freq === "yearly_nth") {
    rec.bynth = Number($("#evBynth")?.value || 1);
    rec.byweekday = Number($("#evByweekday2")?.value || 0);
  }
  if (freq === "yearly") {
    // 每年几月几号：用开始日期的日，若老师没单独填就取开始日期那天
    const d = new Date(rec.starts_on);
    rec.bymonthday = d.getDate();
  }
  return rec;
}

// ---------------------------------------------------------------- 阶段编辑器

$("#evAddStage").addEventListener("click", () => {
  state.stages.push({
    name_zh: "", name_en: "", date_mode: "offset", offset_days: 0,
    fixed_md: "", fixed_date: "", show_on_calendar: true, show_in_banner: true,
  });
  renderStages();
  schedulePreview();
});

function renderStages() {
  const host = $("#evStages");
  if (!state.stages.length) {
    host.innerHTML = `<div class="empty-note">${t("stage_list")}：—</div>`;
    return;
  }
  host.innerHTML = "";
  state.stages.forEach((st, i) => {
    const card = document.createElement("div");
    card.className = "stage-card";
    card.dataset.index = String(i);
    card.innerHTML = `
      <div class="stage-head">
        <span class="stage-index">${t("stage")} ${i + 1}</span>
        <input class="st-name-zh" placeholder="${t("stage_name")}">
        <button type="button" class="danger st-remove">${t("delete")}</button>
      </div>
      <div class="stage-row">
        <input class="st-name-en" placeholder="${t("stage_name")} (EN)">
        <select class="st-mode">
          <option value="offset">${t("mode_offset")}</option>
          <option value="fixed_md">${t("mode_fixed_md")}</option>
          <option value="fixed_date">${t("mode_fixed_date")}</option>
        </select>
      </div>
      <div class="st-daterow"></div>
      <div class="stage-flags">
        <label><input type="checkbox" class="st-cal">${t("show_on_calendar")}</label>
        <label><input type="checkbox" class="st-banner">${t("show_in_banner")}</label>
      </div>
      <div class="stage-preview"></div>`;
    host.appendChild(card);

    const q = (sel) => card.querySelector(sel);
    q(".st-name-zh").value = st.name_zh;
    q(".st-name-en").value = st.name_en;
    q(".st-mode").value = st.date_mode;
    q(".st-cal").checked = st.show_on_calendar;
    q(".st-banner").checked = st.show_in_banner;

    q(".st-name-zh").addEventListener("input", (e) => {
      state.stages[i].name_zh = e.target.value;
      schedulePreview();
    });
    q(".st-name-en").addEventListener("input", (e) => {
      state.stages[i].name_en = e.target.value;
    });
    q(".st-mode").addEventListener("change", (e) => {
      state.stages[i].date_mode = e.target.value;
      renderStageDateRow(i);
      schedulePreview();
    });
    q(".st-cal").addEventListener("change", (e) => {
      state.stages[i].show_on_calendar = e.target.checked;
    });
    q(".st-banner").addEventListener("change", (e) => {
      state.stages[i].show_in_banner = e.target.checked;
    });
    q(".st-remove").addEventListener("click", () => {
      state.stages.splice(i, 1);
      renderStages();
      schedulePreview();
    });

    renderStageDateRow(i);
  });
}

function renderStageDateRow(i) {
  const card = $(`#evStages .stage-card[data-index="${i}"]`);
  if (!card) return;
  const st = state.stages[i];
  const row = card.querySelector(".st-daterow");
  if (st.date_mode === "fixed_md") {
    row.innerHTML = `<div class="field" style="margin:0">
      <label>${t("fixed_md")}</label>
      <input class="st-fixed-md" value="${esc(st.fixed_md || "")}" placeholder="03-01"></div>`;
    row.querySelector(".st-fixed-md").addEventListener("input", (e) => {
      st.fixed_md = e.target.value;
      schedulePreview();
    });
  } else if (st.date_mode === "fixed_date") {
    row.innerHTML = `<div class="field" style="margin:0">
      <label>${t("fixed_date")}</label>
      <input type="date" class="st-fixed-date" value="${esc(st.fixed_date || "")}"></div>`;
    row.querySelector(".st-fixed-date").addEventListener("change", (e) => {
      st.fixed_date = e.target.value;
      schedulePreview();
    });
  } else {
    row.innerHTML = `<div class="field" style="margin:0">
      <label>${t("offset_days")}</label>
      <input type="number" class="st-offset" value="${st.offset_days}">
      <div class="hint">${t("offset_hint")}</div></div>`;
    row.querySelector(".st-offset").addEventListener("input", (e) => {
      st.offset_days = Number(e.target.value || 0);
      schedulePreview();
    });
  }
}

/** 让后端算一次真实日期，把结果贴到每个阶段卡片上 */
function schedulePreview() {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(runPreview, 250);
}

async function runPreview() {
  const rec = collectRecurrence();
  const payload = {
    recurrence: rec,
    stages: state.stages.map((s) => ({
      name_zh: s.name_zh, name_en: s.name_en, date_mode: s.date_mode,
      offset_days: s.offset_days, fixed_md: s.fixed_md || null,
      fixed_date: s.fixed_date || null,
    })),
  };
  let data;
  try {
    data = await api.preview(payload);
  } catch (_) {
    return;
  }
  const occ = data.occurrences || [];
  $$("#evStages .stage-card").forEach((card) => {
    const i = Number(card.dataset.index);
    const st = state.stages[i];
    const lines = occ.slice(0, 3).map((o) => {
      const hit = o.stages.find((x) => x.idx === i);
      const label = st.name_zh || st.name_en || t("stage");
      return `${o.date} → ${label} ${hit ? hit.date : "—"}`;
    });
    card.querySelector(".stage-preview").textContent = lines.join("   |   ");
  });
}

// ---------------------------------------------------------------- 封面图

function renderPhotoPreview(previewSel, clearSel, photoId) {
  const img = $(previewSel);
  const clear = $(clearSel);
  if (photoId) {
    img.src = `/api/uploads/${photoId}`;
    img.classList.remove("hidden");
    clear.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
    clear.classList.add("hidden");
  }
}

async function uploadPhoto(file, previewSel, clearSel, btnSel, setter) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toast(t("image_too_large"), true);
    return;
  }
  const btn = $(btnSel);
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("uploading");
  try {
    const res = await api.upload(file);
    setter(res.id);
    renderPhotoPreview(previewSel, clearSel, res.id);
    toast(t("saved"));
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

$("#evPhotoBtn").addEventListener("click", () => $("#evPhotoFile").click());
$("#evPhotoFile").addEventListener("change", (e) =>
  uploadPhoto(e.target.files[0], "#evPhotoPreview", "#evPhotoClear", "#evPhotoBtn",
    (id) => { state.photoId = id; }));
$("#evPhotoClear").addEventListener("click", () => {
  state.photoId = null;
  renderPhotoPreview("#evPhotoPreview", "#evPhotoClear", null);
});

// ---------------------------------------------------------------- 保存活动

$("#eventSave").addEventListener("click", async () => {
  const titleZh = $("#evTitleZh").value.trim();
  const titleEn = $("#evTitleEn").value.trim();
  if (!titleZh && !titleEn) {
    toast(t("title"), true);
    $("#evTitleZh").focus();
    return;
  }
  const payload = {
    title_zh: titleZh,
    title_en: titleEn,
    body_zh: $("#evBodyZh").value,
    body_en: $("#evBodyEn").value,
    location_zh: $("#evLocationZh").value.trim(),
    location_en: $("#evLocationEn").value.trim(),
    subject_id: $("#evSubject").value,
    photo_id: state.photoId,
    recurrence: collectRecurrence(),
    stages: state.stages.map((s) => ({
      name_zh: s.name_zh, name_en: s.name_en, date_mode: s.date_mode,
      offset_days: s.offset_days,
      fixed_md: s.fixed_md || null,
      fixed_date: s.fixed_date || null,
      show_on_calendar: s.show_on_calendar,
      show_in_banner: s.show_in_banner,
    })),
    tags: state.tagEditor ? state.tagEditor.value : [],
  };
  try {
    if (state.editing) {
      await api.updateEvent(state.editing.id, payload, state.editing.version);
    } else {
      await api.createEvent(payload);
    }
    toast(t("saved"));
    closeEventForm();
    await loadEvents();
  } catch (err) {
    toast(err.status === 409 ? t("updated_by_other") : err.message, true);
  }
});

// ---------------------------------------------------------------- 公告

async function loadPosts() {
  const data = await api.announcements(getLang()).catch(() => ({ announcements: [] }));
  state.posts = data.announcements || [];
  renderPostList();
}

function renderPostList() {
  const host = $("#postList");
  if (!state.posts.length) {
    host.innerHTML = `<div class="empty-note">${t("posts_empty")}</div>`;
    return;
  }
  host.innerHTML = state.posts.map((p) => `
    <div class="post-row">
      ${p.photo_id ? `<img src="/api/uploads/${p.photo_id}" alt="">` : ""}
      <div class="po-main">
        <div class="po-title">${esc(p.title || "(无标题)")}</div>
        <div class="po-body">${esc(p.body || "")}</div>
        <div class="ev-meta">
          <span>${esc(p.starts_on || "")}</span>
          ${p.show_on_calendar ? `<span>${t("post_show_calendar")}</span>` : ""}
        </div>
      </div>
      <div class="ev-actions">
        <button class="ghost" data-pedit="${p.id}">${t("edit")}</button>
        <button class="danger" data-pdel="${p.id}">${t("delete")}</button>
      </div>
    </div>`).join("");

  host.querySelectorAll("[data-pedit]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = state.posts.find((x) => String(x.id) === b.dataset.pedit);
      if (p) openPostForm(p);
    }));
  host.querySelectorAll("[data-pdel]").forEach((b) =>
    b.addEventListener("click", async () => {
      const p = state.posts.find((x) => String(x.id) === b.dataset.pdel);
      if (!p) return;
      if (!confirm(`${t("confirm_delete")}\n\n${p.title || ""}`)) return;
      try {
        await api.deleteAnnouncement(p.id);
        toast(t("saved"));
        await loadPosts();
      } catch (err) {
        toast(err.message, true);
      }
    }));
}

$("#newPostBtn").addEventListener("click", () => openPostForm(null));
$("#postFormClose").addEventListener("click", closePostForm);
$("#postCancel").addEventListener("click", closePostForm);

function closePostForm() {
  $("#postOverlay").classList.add("hidden");
  state.editingPost = null;
}

function openPostForm(p) {
  state.editingPost = p;
  state.postPhotoId = p ? p.photo_id : null;
  $("#postFormTitle").textContent = p ? t("edit") : t("new_post");
  $("#poTitleZh").value = p ? p.title_zh || "" : "";
  $("#poTitleEn").value = p ? p.title_en || "" : "";
  $("#poBodyZh").value = p ? p.body_zh || "" : "";
  $("#poBodyEn").value = p ? p.body_en || "" : "";
  $("#poStartsOn").value = p ? p.starts_on || todayISO() : todayISO();
  $("#poEndsOn").value = p ? p.ends_on || "" : "";
  $("#poShowCal").checked = p ? !!p.show_on_calendar : false;
  renderPhotoPreview("#poPhotoPreview", "#poPhotoClear", state.postPhotoId);
  $("#postOverlay").classList.remove("hidden");
}

$("#poPhotoBtn").addEventListener("click", () => $("#poPhotoFile").click());
$("#poPhotoFile").addEventListener("change", (e) =>
  uploadPhoto(e.target.files[0], "#poPhotoPreview", "#poPhotoClear", "#poPhotoBtn",
    (id) => { state.postPhotoId = id; }));
$("#poPhotoClear").addEventListener("click", () => {
  state.postPhotoId = null;
  renderPhotoPreview("#poPhotoPreview", "#poPhotoClear", null);
});

$("#postSave").addEventListener("click", async () => {
  const titleZh = $("#poTitleZh").value.trim();
  const titleEn = $("#poTitleEn").value.trim();
  if (!titleZh && !titleEn) {
    toast(t("post_title"), true);
    return;
  }
  const payload = {
    title_zh: titleZh,
    title_en: titleEn,
    body_zh: $("#poBodyZh").value,
    body_en: $("#poBodyEn").value,
    photo_id: state.postPhotoId,
    starts_on: $("#poStartsOn").value || null,
    ends_on: $("#poEndsOn").value || null,
    show_on_calendar: $("#poShowCal").checked,
  };
  try {
    if (state.editingPost) {
      await api.updateAnnouncement(state.editingPost.id, payload, state.editingPost.version);
    } else {
      await api.createAnnouncement(payload);
    }
    toast(t("saved"));
    closePostForm();
    await loadPosts();
  } catch (err) {
    toast(err.status === 409 ? t("updated_by_other") : err.message, true);
  }
});

// ---------------------------------------------------------------- 设置

// 每种接口的默认地址和默认模型。换类型时，如果当前填的是上一家的默认值，就跟着换。
const AI_DEFAULTS = {
  minimax: { url: "https://api.minimaxi.com/v1", model: "MiniMax-M3" },
  anthropic: { url: "https://api.anthropic.com", model: "claude-sonnet-4-6" },
  openai: { url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:1.5b-instruct" },
};

function refreshAiHints() {
  const p = $("#setProvider").value;
  const isOllama = p === "ollama";
  $("#setCtx").closest(".field").classList.toggle("hidden", !isOllama);
  $("#setApiKey").closest(".field").classList.toggle("hidden", isOllama);
  $("#setBaseUrl").placeholder = AI_DEFAULTS[p].url;
}

async function loadSettings() {
  const s = await api.settings().catch(() => null);
  if (!s) return;
  $("#setProvider").value = s.ai_provider || "ollama";
  $("#setProvider").dataset.prev = $("#setProvider").value;
  $("#setBaseUrl").value = s.ai_base_url || "";
  $("#setModel").value = s.ai_model || "";
  $("#setCtx").value = s.ai_num_ctx || 4096;
  $("#setPrompt").value = s.ai_system_prompt || "";
  $("#setApiKey").value = "";
  $("#setKeyStatus").textContent =
    s.ai_key_source === "db" || s.ai_key_source === "none"
      ? s.ai_api_key_masked
        ? t("settings_key_saved", { masked: s.ai_api_key_masked })
        : t("settings_key_none")
      : t("settings_key_env", { name: s.ai_key_source });
  $("#setSchoolZh").value = s.school_name_zh || "";
  $("#setSchoolEn").value = s.school_name_en || "";
  $("#setYearStart").value = s.academic_year_start || "08-01";
  refreshAiHints();
}

$("#setProvider").addEventListener("change", () => {
  const prev = $("#setProvider").dataset.prev || "";
  const from = AI_DEFAULTS[prev];
  const to = AI_DEFAULTS[$("#setProvider").value];
  if (from && to) {
    if (!$("#setBaseUrl").value.trim() || $("#setBaseUrl").value.trim() === from.url) {
      $("#setBaseUrl").value = to.url;
    }
    if (!$("#setModel").value.trim() || $("#setModel").value.trim() === from.model) {
      $("#setModel").value = to.model;
    }
  }
  $("#setProvider").dataset.prev = $("#setProvider").value;
  refreshAiHints();
});

$("#testAiBtn").addEventListener("click", async () => {
  const btn = $("#testAiBtn");
  const out = $("#testAiResult");
  btn.disabled = true;
  out.textContent = t("settings_testing");
  try {
    await api.saveSettings({
      ai_provider: $("#setProvider").value,
      ai_base_url: $("#setBaseUrl").value.trim(),
      ai_model: $("#setModel").value.trim(),
      ai_num_ctx: $("#setCtx").value.trim(),
      ai_system_prompt: $("#setPrompt").value.trim(),
    });
    const key = $("#setApiKey").value.trim();
    if (key) {
      await api.saveSettings({ ai_api_key: key });
      $("#setApiKey").value = "";
    }
    const res = await api.testAi();
    out.textContent = res.ok ? t("settings_test_ok") : `${t("settings_test_fail")}：${res.error}`;
  } catch (err) {
    out.textContent = `${t("settings_test_fail")}：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$("#saveSettingsBtn").addEventListener("click", async () => {
  const pwd1 = $("#setPwd1").value;
  const pwd2 = $("#setPwd2").value;
  if (pwd1 !== pwd2) {
    $("#pwdError").classList.remove("hidden");
    return;
  }
  $("#pwdError").classList.add("hidden");
  const payload = {
    ai_provider: $("#setProvider").value,
    ai_base_url: $("#setBaseUrl").value.trim(),
    ai_model: $("#setModel").value.trim(),
    ai_num_ctx: $("#setCtx").value.trim(),
    ai_system_prompt: $("#setPrompt").value.trim(),
    school_name_zh: $("#setSchoolZh").value.trim(),
    school_name_en: $("#setSchoolEn").value.trim(),
    academic_year_start: $("#setYearStart").value.trim(),
  };
  const key = $("#setApiKey").value.trim();
  if (key) payload.ai_api_key = key;
  if (pwd1) payload.new_password = pwd1;
  try {
    await api.saveSettings(payload);
    $("#setPwd1").value = "";
    $("#setPwd2").value = "";
    $("#setApiKey").value = "";
    toast(t("saved"));
    const meta = await api.meta();
    store.meta = meta;
    store.subjects = meta.subjects;
    store.aiAvailable = meta.ai_available;
    renderAiBadge();
    await loadSettings();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------- 启动

boot().catch(() => showLogin());

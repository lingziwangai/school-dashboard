// 标签比例条
// 存的是「权重」(0-100)，显示时才归一化成百分比 —— 这样拖动时在权重空间加减，
// 总和天然守恒，不会出现 99%/101% 的舍入问题。
//
// 交互要点：
// - 用 pointer 事件统一鼠标和触摸；手柄视觉 3px 但命中区 22px（10 寸屏手指精度差）
// - touch-action: none，防止拖动变成页面滚动
// - 拖动中本地即时重绘，pointerup 才回调保存

import { subjectById } from "./store.js";
import { t, getLang } from "./i18n.js";

/** 只读的彩色比例条（屏幕端用） */
export function renderTagBar(container, tags, lang = "zh") {
  const list = (tags || []).filter((t) => t.weight > 0);
  if (!list.length) {
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  const total = list.reduce((s, t) => s + t.weight, 0);
  container.innerHTML = list
    .map((t) => {
      const s = subjectById(t.tag_id);
      const name = lang === "en" ? s.name_en : s.name_zh;
      const pct = Math.round((t.weight / total) * 100);
      return `<span style="width:${(t.weight / total) * 100}%;background:${s.color}"
                    title="${name} ${pct}%"></span>`;
    })
    .join("");
}

/** 带标签说明的比例条（详情页用） */
export function renderTagBarLegend(container, tags, lang = "zh") {
  const list = (tags || []).filter((t) => t.weight > 0);
  container.innerHTML = "";
  if (!list.length) return;
  const total = list.reduce((s, t) => s + t.weight, 0);
  list
    .sort((a, b) => b.weight - a.weight)
    .forEach((t) => {
      const s = subjectById(t.tag_id);
      const name = lang === "en" ? s.name_en : s.name_zh;
      const pct = Math.round((t.weight / total) * 100);
      const el = document.createElement("span");
      el.className = "tag-legend-item";
      el.innerHTML = `<i class="dot" style="background:${s.color}"></i>${name} ${pct}%`;
      container.appendChild(el);
    });
}

/**
 * 可编辑的比例条。
 * @param {HTMLElement} host 容器
 * @param {Object} opts { subjects, value, onChange }
 */
export function createTagBarEditor(host, opts) {
  const { subjects = [], onChange = () => {} } = opts;
  let value = []; // [{tag_id, weight}]

  host.classList.add("tagbar-editor");
  host.innerHTML = `
    <div class="tb-track" data-role="track"></div>
    <div class="tb-list" data-role="list"></div>
    <div class="tb-add">
      <span class="muted small">${t("tag_add")}</span>
      <select data-role="add-select"></select>
      <button type="button" data-role="add-btn" title="${t("tag_add")}">+</button>
    </div>`;

  const track = host.querySelector('[data-role="track"]');
  const list = host.querySelector('[data-role="list"]');
  const addSelect = host.querySelector('[data-role="add-select"]');
  const addBtn = host.querySelector('[data-role="add-btn"]');

  function totalWeight() {
    return value.reduce((s, t) => s + t.weight, 0);
  }

  function normalized() {
    const total = totalWeight() || 1;
    return value.map((t) => ({ ...t, pct: t.weight / total }));
  }

  function render() {
    const items = normalized();

    // 轨道
    track.innerHTML = "";
    if (!items.length) {
      track.classList.add("empty");
      track.innerHTML = `<span class="tb-empty">${t("tags_empty")}</span>`;
    } else {
      track.classList.remove("empty");
      items.forEach((t, i) => {
        if (i > 0) {
          const div = document.createElement("div");
          div.className = "tb-divider";
          div.dataset.index = String(i - 1);
          div.setAttribute("role", "separator");
          div.setAttribute("tabindex", "0");
          div.setAttribute("aria-label", "拖动调整比例");
          track.appendChild(div);
        }
        const seg = document.createElement("div");
        seg.className = "tb-seg";
        seg.style.flexGrow = String(t.weight);
        seg.style.background = subjectById(t.tag_id).color;
        seg.innerHTML = `<span class="tb-seg-label">${Math.round(t.pct * 100)}%</span>`;
        track.appendChild(seg);
      });
    }

    // 列表
    list.innerHTML = "";
    const lang = getLang();
    items.forEach((t) => {
      const s = subjectById(t.tag_id);
      const row = document.createElement("div");
      row.className = "tb-row";
      row.innerHTML = `
        <i class="dot" style="background:${s.color}"></i>
        <span class="tb-name">${lang === "en" ? s.name_en : s.name_zh}</span>
        <span class="tb-en">${lang === "en" ? s.name_zh : s.name_en}</span>
        <input type="number" class="tb-weight" min="1" max="100" value="${t.weight}" />
        <span class="muted small">${t("weight")}</span>
        <button type="button" class="danger tb-remove" title="${t("tag_remove")}">✕</button>`;
      const input = row.querySelector(".tb-weight");
      input.addEventListener("change", () => {
        const w = Math.max(1, Math.min(100, Number(input.value) || 1));
        const item = value.find((x) => x.tag_id === t.tag_id);
        if (item) item.weight = w;
        render();
        onChange(value.map((x) => ({ ...x })));
      });
      row.querySelector(".tb-remove").addEventListener("click", () => {
        value = value.filter((x) => x.tag_id !== t.tag_id);
        render();
        onChange(value.map((x) => ({ ...x })));
      });
      list.appendChild(row);
    });

    // 可添加的科目
    const used = new Set(value.map((t) => t.tag_id));
    addSelect.innerHTML = subjects
      .filter((s) => !used.has(s.id))
      .map((s) => `<option value="${s.id}">${s.name_zh} · ${s.name_en}</option>`)
      .join("");
    addBtn.disabled = !addSelect.options.length;
  }

  // ---- 拖动分隔线 ----
  track.addEventListener("pointerdown", (ev) => {
    const divider = ev.target.closest(".tb-divider");
    if (!divider) return;
    ev.preventDefault();

    const index = Number(divider.dataset.index);
    const rect = track.getBoundingClientRect();
    const width = rect.width || 1;
    const total = totalWeight();
    if (value.length < 2 || !total) return;

    const startX = ev.clientX;
    const left = value[index].weight;
    const right = value[index + 1].weight;
    divider.setPointerCapture(ev.pointerId);
    divider.classList.add("dragging");

    const onMove = (e) => {
      const deltaWeight = ((e.clientX - startX) / width) * total;
      let newLeft = left + deltaWeight;
      let newRight = right - deltaWeight;
      // 不允许把某一段压成 0 或负数
      if (newLeft < 0) { newRight += newLeft; newLeft = 0; }
      if (newRight < 0) { newLeft += newRight; newRight = 0; }
      value[index].weight = Math.round(newLeft);
      value[index + 1].weight = Math.round(newRight);
      renderTrackOnly();
    };

    const onUp = () => {
      divider.releasePointerCapture?.(ev.pointerId);
      divider.classList.remove("dragging");
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      divider.removeEventListener("pointercancel", onUp);
      render();
      onChange(value.map((x) => ({ ...x })));
    };

    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
    divider.addEventListener("pointercancel", onUp);
  });

  // 键盘：左右方向键微调
  track.addEventListener("keydown", (ev) => {
    const divider = ev.target.closest(".tb-divider");
    if (!divider) return;
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const index = Number(divider.dataset.index);
    const step = ev.shiftKey ? 10 : 1;
    const delta = ev.key === "ArrowRight" ? step : -step;
    let newLeft = value[index].weight + delta;
    let newRight = value[index + 1].weight - delta;
    if (newLeft < 1 || newRight < 1) return;
    value[index].weight = newLeft;
    value[index + 1].weight = newRight;
    render();
    onChange(value.map((x) => ({ ...x })));
  });

  /** 拖动过程中只重画轨道（列表不动，避免闪） */
  function renderTrackOnly() {
    const items = normalized();
    const segs = track.querySelectorAll(".tb-seg");
    items.forEach((t, i) => {
      if (!segs[i]) return;
      segs[i].style.flexGrow = String(t.weight);
      segs[i].querySelector(".tb-seg-label").textContent = `${Math.round(t.pct * 100)}%`;
    });
  }

  addBtn.addEventListener("click", () => {
    const id = addSelect.value;
    if (!id) return;
    value.push({ tag_id: id, weight: 50 });
    render();
    onChange(value.map((x) => ({ ...x })));
  });

  render();

  return {
    get value() {
      return value.map((x) => ({ ...x }));
    },
    setValue(next) {
      value = (next || []).map((t) => ({ tag_id: t.tag_id, weight: Number(t.weight) || 0 }));
      render();
    },
    // 切换语言后重画（词条变了，标签名也要跟着变）
    render,
  };
}

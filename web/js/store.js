// 全局共享状态。各页面 import 同一个 store，改一处两边都能看到。
import { getLang } from "./i18n.js";

const listeners = new Set();

export const store = {
  lang: getLang(),
  meta: null,          // 科目表、学校名等
  subjects: [],        // [{id, name_zh, name_en, color}]
  revision: -1,
  chips: [],           // 当前视图区间内的日历条目
  announcements: [],
  aiAvailable: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn(store);
}

export function subjectById(id) {
  return store.subjects.find((s) => s.id === id) || { id, name_zh: id, name_en: id, color: "#9a8f85" };
}

export function subjectName(id, lang = store.lang) {
  const s = subjectById(id);
  return lang === "en" ? s.name_en : s.name_zh;
}

export function setLang(lang) {
  store.lang = lang;
  emit();
}

/** 把扁平的 chips 按日期分组，方便日历格子直接取用。 */
export function groupByDate(chips = store.chips) {
  const map = new Map();
  for (const chip of chips) {
    if (!map.has(chip.date)) map.set(chip.date, []);
    map.get(chip.date).push(chip);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.seq - b.seq);
  }
  return map;
}

/** 今天的日期字符串（YYYY-MM-DD），本地时区。 */
export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isoDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(dateStr, days) {
  const d = parseISO(dateStr);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

export function daysBetween(fromStr, toStr) {
  const a = parseISO(fromStr);
  const b = parseISO(toStr);
  return Math.round((b - a) / 86400000);
}

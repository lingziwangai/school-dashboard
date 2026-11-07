// 昼夜主题：白天 / 黑夜两套配色，选择记在浏览器本地。
// 颜色本身写在 css/base.css 的 :root 和 :root[data-theme="light"] 里。
import { t } from "./i18n.js";

const LS_KEY = "rb_theme";
const buttons = [];

export function getTheme() {
  const saved = localStorage.getItem(LS_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

export function setTheme(theme) {
  localStorage.setItem(LS_KEY, theme);
  applyTheme(theme);
}

export function toggleTheme() {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/** 刷新切换按钮上的提示文字（换语言之后要再调一次）。 */
export function refreshThemeButtons() {
  const title = getTheme() === "dark" ? t("theme_to_light") : t("theme_to_dark");
  for (const btn of buttons) {
    btn.title = title;
    btn.setAttribute("aria-label", title);
  }
}

/** 绑定昼夜切换按钮，屏幕端和老师端共用一个。 */
export function bindThemeButton(btn) {
  if (!btn) return;
  buttons.push(btn);
  btn.addEventListener("click", () => {
    toggleTheme();
    refreshThemeButtons();
  });
  refreshThemeButtons();
}

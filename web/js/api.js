// 后端接口封装。所有网络请求都走这里，方便统一处理错误。
async function request(url, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch(url, {
    credentials: "same-origin",
    ...options,
    // headers 必须放最后合并，否则 options.headers 会整个覆盖掉 Content-Type
    headers: isForm
      ? (options.headers || {})
      : { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
      else if (Array.isArray(data.detail)) {
        message = data.detail.map((d) => d.msg || JSON.stringify(d)).join("；");
      }
    } catch (_) { /* 不是 JSON 就用默认信息 */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  meta: () => request("/api/meta"),
  version: () => request("/api/sync/version"),
  calendarRange: (start, end, today, lang) =>
    request(`/api/calendar/range?start=${start}&end=${end}&today=${today}&lang=${lang}`),
  event: (id, lang) => request(`/api/events/${id}?lang=${lang}`),
  announcements: (lang, scope = "all") =>
    request(`/api/announcements?lang=${lang}&scope=${scope}`),
  banner: (lang, days = 45) => request(`/api/banner?lang=${lang}&days=${days}`),
  faceState: () => request("/api/face/state"),
  setFace: (expression, intensity = 1) =>
    request("/api/face/state", {
      method: "POST",
      body: JSON.stringify({ expression, intensity }),
    }),

  login: (password) =>
    request("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  me: () => request("/api/auth/me"),

  listEvents: (lang = "zh") => request(`/api/admin/events?lang=${lang}`),
  createEvent: (payload) =>
    request("/api/events", { method: "POST", body: JSON.stringify(payload) }),
  updateEvent: (id, payload, version) =>
    request(`/api/events/${id}`, {
      method: "PATCH",
      headers: { "If-Match": String(version) },
      body: JSON.stringify(payload),
    }),
  deleteEvent: (id) => request(`/api/events/${id}`, { method: "DELETE" }),
  setTags: (id, tags) =>
    request(`/api/events/${id}/tags`, { method: "PUT", body: JSON.stringify({ tags }) }),
  preview: (payload) =>
    request("/api/recurrence/preview", { method: "POST", body: JSON.stringify(payload) }),

  createAnnouncement: (payload) =>
    request("/api/announcements", { method: "POST", body: JSON.stringify(payload) }),
  updateAnnouncement: (id, payload, version) =>
    request(`/api/announcements/${id}`, {
      method: "PATCH",
      headers: { "If-Match": String(version) },
      body: JSON.stringify(payload),
    }),
  deleteAnnouncement: (id) => request(`/api/announcements/${id}`, { method: "DELETE" }),

  upload: (file) => {
    const fd = new FormData();
    fd.append("file", file);
    return request("/api/uploads", { method: "POST", body: fd });
  },

  settings: () => request("/api/settings"),
  saveSettings: (payload) =>
    request("/api/settings", { method: "PUT", body: JSON.stringify(payload) }),

  aiHealth: () => request("/api/ai/health"),
  testAi: () => request("/api/ai/test", { method: "POST" }),
};

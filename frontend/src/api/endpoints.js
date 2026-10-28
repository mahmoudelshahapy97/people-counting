import client, { API_BASE, mediaUrl } from "./client";

/**
 * One function per backend route, so no component builds a URL by hand.
 *
 * Mirrors app/api/routes/: camera_router, count_router, alert_router,
 * analytics_router and system_router.
 */

// --- health and system ----------------------------------------------------
export const health = {
  // /health is mounted on the app root, outside the versioned prefix, so it is
  // the one call that has to escape the axios baseURL.
  live: (opts) => client.get("/health", { baseURL: "", ...opts }).then((r) => r.data),
};

// --- auth -------------------------------------------------------------------
export const auth = {
  login: (username, password) =>
    client.post("/auth/login", { username, password }).then((r) => r.data),
  refresh: (refreshToken) =>
    client.post("/auth/refresh", { refresh_token: refreshToken }).then((r) => r.data),
  logout: (refreshToken) =>
    client.post("/auth/logout", { refresh_token: refreshToken }).then((r) => r.data),
  logoutAll: () => client.post("/auth/logout-all").then((r) => r.data),
  me: (opts) => client.get("/auth/me", opts).then((r) => r.data),
  /** Self-service settings: {notify_email}. Returns the updated account. */
  updateMe: (changes) => client.patch("/auth/me", changes).then((r) => r.data),
  changePassword: (currentPassword, newPassword) =>
    client
      .post("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      })
      .then((r) => r.data),
  /** Public: what the login page may offer, e.g. {password_reset: true}. */
  options: (opts) => client.get("/auth/options", opts).then((r) => r.data),
  /** Mails a reset code; the answer is the same whether or not the account exists. */
  forgotPassword: (email) =>
    client.post("/auth/forgot-password", { email }).then((r) => r.data),
  resetPassword: ({ email, code, newPassword }) =>
    client
      .post("/auth/reset-password", { email, code, new_password: newPassword })
      .then((r) => r.data),
};

// --- workspaces -------------------------------------------------------------
export const workspaces = {
  /** The caller's workspaces (all of them for admins), Default first. */
  mine: (opts) => client.get("/workspaces/mine", opts).then((r) => r.data),
  // Admin only from here.
  list: (opts) => client.get("/workspaces", opts).then((r) => r.data),
  create: (payload) => client.post("/workspaces", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/workspaces/${id}`, payload).then((r) => r.data),
  remove: (id) => client.delete(`/workspaces/${id}`).then((r) => r.data),
  members: (id, opts) => client.get(`/workspaces/${id}/members`, opts).then((r) => r.data),
};

// --- users (admin only) ------------------------------------------------------
export const users = {
  list: (opts) => client.get("/users", opts).then((r) => r.data),
  get: (id, opts) => client.get(`/users/${id}`, opts).then((r) => r.data),
  create: (payload) => client.post("/users", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/users/${id}`, payload).then((r) => r.data),
  resetPassword: (id, newPassword) =>
    client.post(`/users/${id}/reset-password`, { new_password: newPassword }).then((r) => r.data),
  remove: (id) => client.delete(`/users/${id}`).then((r) => r.data),
};

export const system = {
  workers: (opts) => client.get("/system/workers", opts).then((r) => r.data),
  config: (opts) => client.get("/system/config", opts).then((r) => r.data),
};

// --- cameras --------------------------------------------------------------
export const cameras = {
  list: (params, opts) => client.get("/cameras", { params, ...opts }).then((r) => r.data),
  get: (id, opts) => client.get(`/cameras/${id}`, opts).then((r) => r.data),
  create: (payload) => client.post("/cameras", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/cameras/${id}`, payload).then((r) => r.data),
  remove: (id) => client.delete(`/cameras/${id}`).then((r) => r.data),

  start: (id) => client.post(`/cameras/${id}/start`).then((r) => r.data),
  stop: (id) => client.post(`/cameras/${id}/stop`).then((r) => r.data),
  status: (id, opts) => client.get(`/cameras/${id}/status`, opts).then((r) => r.data),

  thresholds: (id, opts) => client.get(`/cameras/${id}/thresholds`, opts).then((r) => r.data),
  /** Replaces the limits: one left out (or null) is removed. Operators may do this. */
  setThresholds: (id, payload) =>
    client.put(`/cameras/${id}/thresholds`, payload).then((r) => r.data),

  /**
   * Latest frame, as an <img> source. The timestamp is not decoration: without
   * it the browser serves the frame it already has and the view never updates.
   */
  snapshotUrl: (id, bust = Date.now()) => mediaUrl(`/cameras/${id}/snapshot`, { t: bust }),

  /**
   * MJPEG live view of the annotated count, as an <img> source.
   * Bump `bust` to reconnect after the worker restarts.
   */
  streamUrl: (id, bust = Date.now()) => mediaUrl(`/cameras/${id}/stream`, { t: bust }),

  /** Open the camera's stream briefly and report what it found; detection is not touched. */
  probe: (id) => client.post(`/cameras/${id}/probe`).then((r) => r.data),
  /** The same for every enabled camera of the workspace, a few at a time. */
  probeAll: () => client.post("/cameras/probe-all").then((r) => r.data),
};

// --- counts ---------------------------------------------------------------
/**
 * Every count route takes the same filter (see countParams in utils/filters.js):
 * start_date / end_date (whole days in tz), camera_id, buildings, floors,
 * zones, areas. No dates = the last 7 days.
 */
export const counts = {
  /** Paginated sample history, newest first: {total, num_of_pages, samples}. */
  history: (params, opts) => client.get("/counts", { params, ...opts }).then((r) => r.data),
  /** Every camera's current count against its limits. */
  live: (opts) => client.get("/counts/live", opts).then((r) => r.data),
  /** Distinct buildings / floors / zones / areas, for the filter menus. */
  locations: (opts) => client.get("/counts/locations", opts).then((r) => r.data),
  /** CSV of the filtered history; fetched with the auth header, saved as a file. */
  exportCsv: (params) =>
    client.get("/counts/export.csv", { params, responseType: "blob" }).then((r) => r.data),
};

// --- alerts ---------------------------------------------------------------
export const alerts = {
  /** The list's filters as a CSV download (a Blob, so the token stays in the header). */
  exportBlob: (params) =>
    client.get("/alerts/export.csv", { params, responseType: "blob" }).then((r) => r.data),
  list: (params, opts) => client.get("/alerts", { params, ...opts }).then((r) => r.data),
  get: (id, params, opts) => client.get(`/alerts/${id}`, { params, ...opts }).then((r) => r.data),
  stats: (params, opts) => client.get("/alerts/stats", { params, ...opts }).then((r) => r.data),
  /** notes: optional {action_taken, description}; left out, the stored ones are kept. */
  setStatus: (id, status, notes = {}) =>
    client.patch(`/alerts/${id}/status`, { status, ...notes }).then((r) => r.data),

  /** The annotated frame of the sample that raised the alert. */
  frameUrl: (id) => mediaUrl(`/alerts/${id}/frame`),
};

// --- notifications ----------------------------------------------------------
// Addressed to the account, not the active workspace: the bell lists every
// workspace the caller can see, and each row names its own.
export const notifications = {
  /** {unread_only, kind, workspace_id, limit, offset} -> {items, total, unread}. */
  list: (params, opts) => client.get("/notifications", { params, ...opts }).then((r) => r.data),
  unreadCount: (opts) => client.get("/notifications/unread-count", opts).then((r) => r.data.unread),
  /** The listed ids, or every unread one when none are given. -> {marked, unread} */
  markRead: (ids) =>
    client.post("/notifications/read", ids ? { notification_ids: ids } : {}).then((r) => r.data),
  markUnread: (id) => client.delete(`/notifications/${id}/read`).then((r) => r.data),
  /** A "system" notification to yourself, to check the bell and the socket end to end. */
  sendTest: () => client.post("/notifications/test").then((r) => r.data),
  /** ws(s)://<host>/api/v1/notifications/ws; the token goes in the first message. */
  socketUrl: () => {
    const base = new URL(API_BASE, window.location.href).toString().replace(/\/$/, "");
    return `${base.replace(/^http/, "ws")}/notifications/ws`;
  },
};

// --- audit log ----------------------------------------------------------------
export const audit = {
  /** {action, actor, since, until, limit, offset} -> {items, total}. Admins only. */
  list: (params, opts) => client.get("/audit-logs", { params, ...opts }).then((r) => r.data),
  exportBlob: (params) =>
    client.get("/audit-logs/export.csv", { params, responseType: "blob" }).then((r) => r.data),
};

// --- analytics ------------------------------------------------------------
const report = (path) => (params, opts) =>
  client.get(`/analytics/${path}`, { params, ...opts }).then((r) => r.data);

export const analytics = {
  /** KPIs, the occupancy series and the weekday x hour heatmap. */
  summary: report("summary"),
  // InsightEye's people reports, same paths and field names.
  averageByCamera: report("cameras/average-people"),
  busiestHours: report("busiest-hours/by-weekday"),
  averageByFloor: report("floors/average-people"),
  floorsByWeekday: report("floors/people-by-weekday"),
  floorsByHour: report("floors/people-by-hour"),
  heatmap: report("heatmap"),
  timeseries: report("timeseries"),
  violationsByCamera: report("threshold-violations-by-camera"),
};

export default {
  health,
  auth,
  users,
  system,
  cameras,
  counts,
  alerts,
  analytics,
};

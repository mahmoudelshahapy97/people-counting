import dayjs from "dayjs";
import i18n from "i18next";

/** The viewer's IANA timezone: hours and weekdays are cut in it server-side. */
export const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Quick ranges for the filter bar, as [label, days]. */
export const RANGE_PRESETS = [
  ["Today", 1],
  ["7 days", 7],
  ["30 days", 30],
  ["90 days", 90],
];

export function presetDates(days) {
  const end = dayjs();
  return {
    start_date: end.subtract(days - 1, "day").format("YYYY-MM-DD"),
    end_date: end.format("YYYY-MM-DD"),
  };
}

export const EMPTY_FILTERS = {
  ...presetDates(7),
  camera_id: [],
  buildings: [],
  floors: [],
  zones: [],
  areas: [],
};

/**
 * The query params every count / analytics route takes. Lists are repeated
 * params (axios writes camera_id[]= by default, so they are joined instead;
 * the API accepts comma-joined location lists, and camera_id is sent once per
 * value through URLSearchParams).
 */
export function countParams(filters) {
  const params = new URLSearchParams();
  params.set("tz", VIEWER_TZ);
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  (filters.camera_id || []).forEach((id) => params.append("camera_id", id));
  for (const key of ["buildings", "floors", "zones", "areas"]) {
    if (filters[key]?.length) params.set(key, filters[key].join(","));
  }
  return params;
}

/** "HQ - Floor 2 - Office - East Wing", as InsightEye phrases a location. */
export function locationText(row) {
  const parts = [
    row.building,
    row.floor_level ? `Floor ${row.floor_level}` : null,
    row.zone,
    row.area,
  ].filter(Boolean);
  return parts.length ? parts.join(" - ") : row.location || "";
}

/** "Limits 1 – 15", "Max 15", "Min 1" or "No limits". */
export function limitsText(row) {
  const min = row.count_threshold_less;
  const max = row.count_threshold_greater;
  if (min != null && max != null) return i18n.t("filters.limits", { min, max });
  if (max != null) return i18n.t("filters.max", { max });
  if (min != null) return i18n.t("filters.min", { min });
  return i18n.t("filters.noLimits");
}

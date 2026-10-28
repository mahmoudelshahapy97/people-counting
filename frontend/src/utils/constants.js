import i18n from "i18next";
/**
 * Mirrors the enums in app/schemas/ — keep the two in step. The CHECK
 * constraints in database/schema.sql are the ultimate authority on which
 * values a column will accept.
 */

/** count_alert.status */
export const ALERT_STATUS = {
  OPEN: "OPEN",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  RESOLVED: "RESOLVED",
  FALSE_POSITIVE: "FALSE_POSITIVE",
};

export const ALERT_STATUSES = Object.values(ALERT_STATUS);

/** MUI palette keys, so a status colours identically everywhere it appears. */
export const ALERT_STATUS_COLOR = {
  OPEN: "error",
  ACKNOWLEDGED: "warning",
  RESOLVED: "success",
  FALSE_POSITIVE: "default",
};

/** threshold_violation.threshold_type / count_alert.threshold_type */
export const THRESHOLD_TYPE = {
  GREATER_THAN: "greater_than",
  LESS_THAN: "less_than",
};

export const THRESHOLD_LABEL = {
  get greater_than() { return i18n.t("constants.aboveMax"); },
  get less_than() { return i18n.t("constants.belowMin"); },
};

export const THRESHOLD_COLOR = {
  greater_than: "error",
  less_than: "warning",
};

export const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 5000;

/** Default page size, matched to the API's per_page default. */
export const PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/** Sunday-first, matching Postgres EXTRACT(DOW) (0 = Sunday). */
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

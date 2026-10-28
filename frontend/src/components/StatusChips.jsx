import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import { ALERT_STATUS_COLOR, THRESHOLD_COLOR, THRESHOLD_LABEL } from "../utils/constants";
import { titleCase } from "../utils/format";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

const ALERT_HINT = {
  get OPEN() { return i18n.t("statusChips.nobodyHasTriagedThisYet"); },
  get ACKNOWLEDGED() { return i18n.t("statusChips.someoneIsDealingWithIt"); },
  get RESOLVED() { return i18n.t("statusChips.handledTheAreaIsBack"); },
  get FALSE_POSITIVE() { return i18n.t("statusChips.theCountWasWrongReflections"); },
};

const THRESHOLD_HINT = {
  get greater_than() { return i18n.t("statusChips.morePeopleThanTheCamera"); },
  get less_than() { return i18n.t("statusChips.fewerPeopleThanTheCamera"); },
};

export function AlertStatusChip({ status, size = "small", ...props }) {
  if (!status) return null;
  const color = ALERT_STATUS_COLOR[status] || "default";
  return (
    <Tooltip title={ALERT_HINT[status] || ""}>
      <Chip
        label={titleCase(status)}
        color={color}
        size={size}
        variant={color === "default" ? "outlined" : "filled"}
        {...props}
      />
    </Tooltip>
  );
}

/** Which limit a sample or alert broke: above the maximum or below the minimum. */
export function ThresholdChip({ type, value, size = "small", ...props }) {
  if (!type) return null;
  const label = value != null ? `${THRESHOLD_LABEL[type]} ${value}` : THRESHOLD_LABEL[type];
  return (
    <Tooltip title={THRESHOLD_HINT[type] || ""}>
      <Chip label={label} color={THRESHOLD_COLOR[type]} size={size} variant="outlined" {...props} />
    </Tooltip>
  );
}

/** Whether a camera is configured to run, which is not whether it *is* running. */
export function EnabledChip({ enabled, size = "small", ...props }) {
  const { t } = useTranslation();
  return (
    <Chip
      label={enabled ? t("statusChips.enabled") : t("statusChips.disabled")}
      color={enabled ? "success" : "default"}
      size={size}
      variant={enabled ? "filled" : "outlined"}
      {...props}
    />
  );
}

/** Whether a worker exists for this camera right now, and whether it has a stream. */
export function WorkerChip({ worker, size = "small", ...props }) {
  const { t } = useTranslation();
  if (!worker || !worker.running) {
    return <Chip label={t("statusChips.stopped")} size={size} variant="outlined" {...props} />;
  }
  return (
    <Tooltip
      title={
        worker.connected
          ? t("statusChips.v0FramesProcessed", { v0: worker.frames_processed ?? 0 })
          : t("statusChips.workerIsUpButThe")
      }
    >
      <Chip
        label={worker.connected ? t("statusChips.streaming") : t("statusChips.reconnecting")}
        color={worker.connected ? "success" : "warning"}
        size={size}
        variant="outlined"
        {...props}
      />
    </Tooltip>
  );
}

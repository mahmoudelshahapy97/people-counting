import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import { ALERT_STATUS_COLOR, THRESHOLD_COLOR, THRESHOLD_LABEL } from "../utils/constants";
import { titleCase } from "../utils/format";

const ALERT_HINT = {
  OPEN: "Nobody has triaged this yet",
  ACKNOWLEDGED: "Someone is dealing with it",
  RESOLVED: "Handled: the area is back within its limits",
  FALSE_POSITIVE: "The count was wrong (reflections, posters, a bad angle)",
};

const THRESHOLD_HINT = {
  greater_than: "More people than the camera's maximum",
  less_than: "Fewer people than the camera's minimum",
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
  return (
    <Chip
      label={enabled ? "Enabled" : "Disabled"}
      color={enabled ? "success" : "default"}
      size={size}
      variant={enabled ? "filled" : "outlined"}
      {...props}
    />
  );
}

/** Whether a worker exists for this camera right now, and whether it has a stream. */
export function WorkerChip({ worker, size = "small", ...props }) {
  if (!worker || !worker.running) {
    return <Chip label="Stopped" size={size} variant="outlined" {...props} />;
  }
  return (
    <Tooltip
      title={
        worker.connected
          ? `${worker.frames_processed ?? 0} frames processed`
          : "Worker is up but the RTSP source is not answering"
      }
    >
      <Chip
        label={worker.connected ? "Streaming" : "Reconnecting"}
        color={worker.connected ? "success" : "warning"}
        size={size}
        variant="outlined"
        {...props}
      />
    </Tooltip>
  );
}

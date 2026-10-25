import { useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import ThumbDownOffAltIcon from "@mui/icons-material/ThumbDownOffAlt";

import ItemImage from "../components/ItemImage";
import PageHeader from "../components/PageHeader";
import { ErrorState, Loading } from "../components/DataStates";
import { AlertStatusChip, ThresholdChip } from "../components/StatusChips";
import { useToast } from "../components/Toast";
import { errorMessage } from "../api/client";
import { alerts as alertApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { useAsync } from "../hooks/useAsync";
import { ALERT_STATUS, THRESHOLD_TYPE } from "../utils/constants";
import { locationText } from "../utils/filters";
import { formatDateTime, fromNow, shortId, titleCase } from "../utils/format";

function DetailRow({ label, children }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 150, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Stack>
  );
}

/** The three ways an operator closes out an alert. */
const TRIAGE = [
  {
    status: ALERT_STATUS.ACKNOWLEDGED,
    label: "Acknowledge",
    icon: <CheckCircleOutlineIcon />,
    color: "warning",
  },
  { status: ALERT_STATUS.RESOLVED, label: "Resolve", icon: <DoneAllIcon />, color: "success" },
  {
    status: ALERT_STATUS.FALSE_POSITIVE,
    label: "False positive",
    icon: <ThumbDownOffAltIcon />,
    color: "inherit",
  },
];

const TRIAGE_HINT = {
  [ALERT_STATUS.ACKNOWLEDGED]: "Someone is on it. The alert stays in the open work.",
  [ALERT_STATUS.RESOLVED]: "Handled: the area was cleared, re-staffed or opened up.",
  [ALERT_STATUS.FALSE_POSITIVE]:
    "The count was wrong: reflections, posters or a bad angle were counted as people.",
};

/** Confirms a triage step and records how the alert was handled. */
function TriageDialog({ open, status, label, initial, busy, onConfirm, onClose }) {
  const [actionTaken, setActionTaken] = useState("");
  const [description, setDescription] = useState("");

  const reset = () => {
    setActionTaken(initial?.action_taken || "");
    setDescription(initial?.description || "");
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      TransitionProps={{ onEnter: reset }}
    >
      <DialogTitle>{label}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>{TRIAGE_HINT[status]}</DialogContentText>
        <Stack spacing={2}>
          <TextField
            label="Action taken"
            placeholder="e.g. Opened the overflow area, sent two stewards"
            value={actionTaken}
            onChange={(event) => setActionTaken(event.target.value)}
            inputProps={{ maxLength: 200 }}
            fullWidth
            autoFocus
          />
          <TextField
            label="Notes"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            inputProps={{ maxLength: 2000 }}
            multiline
            minRows={3}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy}
          onClick={() => onConfirm({ action_taken: actionTaken.trim(), description: description.trim() })}
        >
          {busy ? "Working…" : label}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function AlertDetail() {
  const { alertId } = useParams();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canTriage = hasRole("operator");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // the TRIAGE step being confirmed

  // The snapshot is fetched as an image instead of base64 in the JSON, so it
  // streams and caches.
  const { data, error, loading, refresh } = useAsync(
    ({ signal }) => alertApi.get(alertId, { include_frame: false }, { signal }),
    [alertId]
  );

  const setStatus = async (status, notes) => {
    setBusy(true);
    try {
      // Empty fields are left out so the notes already stored are kept.
      const filled = Object.fromEntries(Object.entries(notes || {}).filter(([, v]) => v));
      await alertApi.setStatus(alertId, status, filled);
      toast.success(`Alert marked ${titleCase(status).toLowerCase()}.`);
      setPending(null);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Loading label="Loading alert…" />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  if (!data) return null;

  const over = data.threshold_type === THRESHOLD_TYPE.GREATER_THAN;
  const people = `${data.person_count} ${data.person_count === 1 ? "person" : "people"}`;

  return (
    <Box>
      <Button component={RouterLink} to="/alerts" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
        All alerts
      </Button>

      <PageHeader
        title={`${over ? "High" : "Low"} occupancy: ${people}`}
        subtitle={`${data.camera_name || "Unknown camera"} · ${fromNow(data.triggered_at)}`}
        actions={
          canTriage &&
          TRIAGE.map(({ status, label, icon, color }) => (
            <Button
              key={status}
              variant={data.status === status ? "contained" : "outlined"}
              color={color}
              startIcon={icon}
              disabled={busy || data.status === status}
              onClick={() => setPending({ status, label })}
            >
              {label}
            </Button>
          ))
        }
      />

      <TriageDialog
        open={Boolean(pending)}
        status={pending?.status}
        label={pending?.label}
        initial={data}
        busy={busy}
        onConfirm={(notes) => setStatus(pending.status, notes)}
        onClose={() => setPending(null)}
      />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Card>
            <Box sx={{ px: 2.5, py: 1.5 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                Snapshot
              </Typography>
              <Typography variant="caption" color="text.secondary">
                The annotated frame of the sample that raised the alert: every counted person boxed.
              </Typography>
            </Box>
            <Divider />
            <ItemImage
              src={alertApi.frameUrl(alertId)}
              alt={`Annotated frame: ${people}`}
              height={420}
              fit="contain"
              fallbackLabel="No snapshot stored for this alert"
            />
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Count
              </Typography>
              <Divider />
              <DetailRow label="Status">
                <AlertStatusChip status={data.status} />
              </DetailRow>
              <DetailRow label="People counted">
                <Typography variant="h5" color={over ? "error.main" : "warning.main"} sx={{ fontWeight: 800 }}>
                  {data.person_count}
                </Typography>
              </DetailRow>
              <DetailRow label="Limit broken">
                <ThresholdChip type={data.threshold_type} value={data.threshold_value} />
              </DetailRow>
              <DetailRow label="Camera">
                {data.camera_id ? (
                  <Link component={RouterLink} to={`/cameras/${data.camera_id}`} variant="body2">
                    {data.camera_name}
                  </Link>
                ) : (
                  <Typography variant="body2">—</Typography>
                )}
              </DetailRow>
              <DetailRow label="Location">
                <Typography variant="body2" color="text.secondary">
                  {locationText(data) || "—"}
                </Typography>
              </DetailRow>
              <DetailRow label="Triggered">
                <Typography variant="body2">{formatDateTime(data.triggered_at)}</Typography>
              </DetailRow>
              <DetailRow label="Identity">
                <Typography variant="caption" color="text.disabled">
                  alert {shortId(data.alert_id)}
                </Typography>
              </DetailRow>
            </CardContent>
          </Card>

          {data.acknowledged_at || data.action_taken || data.description ? (
            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                  Handling
                </Typography>
                <Divider />
                <DetailRow label="Acknowledged">
                  <Typography variant="body2" color="text.secondary">
                    {formatDateTime(data.acknowledged_at)}
                  </Typography>
                </DetailRow>
                <DetailRow label="Closed">
                  <Typography variant="body2" color="text.secondary">
                    {data.resolved_at
                      ? `${formatDateTime(data.resolved_at)}${
                          data.resolved_by_username ? ` by ${data.resolved_by_username}` : ""
                        }`
                      : "Still open"}
                  </Typography>
                </DetailRow>
                <DetailRow label="Action taken">
                  <Typography variant="body2">{data.action_taken || "—"}</Typography>
                </DetailRow>
                <DetailRow label="Notes">
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                    {data.description || "—"}
                  </Typography>
                </DetailRow>
              </CardContent>
            </Card>
          ) : null}
        </Grid>
      </Grid>
    </Box>
  );
}

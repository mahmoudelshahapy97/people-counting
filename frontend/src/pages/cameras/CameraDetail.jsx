import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid2";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import StopIcon from "@mui/icons-material/Stop";
import TuneIcon from "@mui/icons-material/Tune";

import ConfirmDialog from "../../components/ConfirmDialog";
import ItemImage from "../../components/ItemImage";
import PageHeader from "../../components/PageHeader";
import Sparkline from "../../components/Sparkline";
import { EmptyState, ErrorState, Loading } from "../../components/DataStates";
import { EnabledChip, ThresholdChip } from "../../components/StatusChips";
import { useToast } from "../../components/Toast";
import { errorMessage } from "../../api/client";
import { analytics, cameras as cameraApi } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { useAsync } from "../../hooks/useAsync";
import { usePolling } from "../../hooks/usePolling";
import { POLL_INTERVAL_MS } from "../../utils/constants";
import { countParams, limitsText, locationText, presetDates } from "../../utils/filters";
import { formatDateTime, formatDuration, parseJsonField, redactUrl, titleCase } from "../../utils/format";

function DetailRow({ label, children }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 140, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Stack>
  );
}

/** Operators tune the limits without the full camera form (an admin's job). */
function LimitsDialog({ open, camera, onClose, onSaved }) {
  const toast = useToast();
  const [max, setMax] = useState("");
  const [min, setMin] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const reset = () => {
    setMax(camera?.count_threshold_greater ?? "");
    setMin(camera?.count_threshold_less ?? "");
    setEnabled(camera?.alert_enabled ?? true);
    setError(null);
  };

  const save = async () => {
    const greater = max === "" ? null : Number(max);
    const less = min === "" ? null : Number(min);
    if ([greater, less].some((v) => v !== null && (!Number.isInteger(v) || v < 0))) {
      setError("Limits are whole numbers, 0 or more.");
      return;
    }
    if (greater !== null && less !== null && less >= greater) {
      setError("The minimum must be lower than the maximum.");
      return;
    }
    setBusy(true);
    try {
      await cameraApi.setThresholds(camera.camera_id, {
        count_threshold_greater: greater,
        count_threshold_less: less,
        alert_enabled: enabled,
      });
      toast.success("Occupancy limits saved.");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth TransitionProps={{ onEnter: reset }}>
      <DialogTitle>Occupancy limits</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label="Maximum people"
            type="number"
            value={max}
            onChange={(event) => setMax(event.target.value)}
            helperText="Blank: no maximum"
            inputProps={{ min: 0, step: 1 }}
            autoFocus
          />
          <TextField
            label="Minimum people"
            type="number"
            value={min}
            onChange={(event) => setMin(event.target.value)}
            helperText="Blank: no minimum"
            inputProps={{ min: 0, step: 1 }}
          />
          <FormControlLabel
            control={<Switch checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />}
            label="Raise alerts"
          />
          {error ? (
            <Typography variant="body2" color="error.main">
              {error}
            </Typography>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save limits"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function CameraDetail() {
  const { cameraId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canOperate = hasRole("operator");
  const canManage = hasRole("admin");

  const camera = useAsync(({ signal }) => cameraApi.get(cameraId, { signal }), [cameraId]);
  const status = usePolling(({ signal }) => cameraApi.status(cameraId, { signal }), {
    intervalMs: POLL_INTERVAL_MS,
    deps: [cameraId],
  });

  // Bumping this changes the snapshot URL, which is what makes the browser
  // re-request the frame rather than serve the one it already has.
  const [snapshotKey, setSnapshotKey] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Today's trend, 5-minute buckets; it moves slowly, so poll it slowly.
  const trend = usePolling(
    ({ signal }) => {
      const params = countParams(presetDates(1));
      params.append("camera_id", cameraId);
      return analytics.timeseries(params, { signal });
    },
    { intervalMs: POLL_INTERVAL_MS * 12, deps: [cameraId] }
  );
  const [editLimits, setEditLimits] = useState(false);

  const worker = status.data?.data;
  const running = Boolean(worker?.running);
  const points = (trend.data?.data?.[0]?.datapoints || []).map((p) => p.avg_person_count);

  // The live stream ends when the worker stops or the supervisor replaces it.
  // Fall back to the snapshot then, and reconnect whenever a new worker starts.
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamKey, setStreamKey] = useState(() => Date.now());
  const workerStartedAt = worker?.started_at;
  useEffect(() => {
    setStreamFailed(false);
    setStreamKey(Date.now());
  }, [running, workerStartedAt]);
  const live = running && !streamFailed;

  // jsonb arrives as a string; parse once here rather than at every read.
  const roi = parseJsonField(camera.data?.roi);
  const settings = parseJsonField(camera.data?.settings, {}) || {};

  const runAction = async (action, message) => {
    setBusy(true);
    try {
      await action();
      toast.success(message);
      status.refresh();
      camera.refresh();
      setSnapshotKey(Date.now());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await cameraApi.remove(cameraId);
      toast.success(`Camera "${camera.data?.name}" deleted.`);
      navigate("/cameras");
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  if (camera.loading && !camera.data) return <Loading label="Loading camera…" />;
  if (camera.error) return <ErrorState error={camera.error} onRetry={camera.refresh} />;
  if (!camera.data) return null;

  return (
    <Box>
      <Button component={RouterLink} to="/cameras" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
        All cameras
      </Button>

      <PageHeader
        title={camera.data.name}
        subtitle={locationText(camera.data) || "No location set"}
        actions={[
          canOperate &&
            (running ? (
              <Button
                key="stop"
                variant="outlined"
                color="warning"
                startIcon={<StopIcon />}
                disabled={busy}
                onClick={() => runAction(() => cameraApi.stop(cameraId), "Worker stopped.")}
              >
                Stop worker
              </Button>
            ) : (
              <Button
                key="start"
                variant="contained"
                startIcon={<PlayArrowIcon />}
                disabled={busy}
                onClick={() => runAction(() => cameraApi.start(cameraId), "Worker started.")}
              >
                Start worker
              </Button>
            )),
          <Button key="alerts" component={RouterLink} to={`/alerts?camera_id=${cameraId}`}>
            View alerts
          </Button>,
          canOperate && (
            <Button key="limits" startIcon={<TuneIcon />} onClick={() => setEditLimits(true)}>
              Limits
            </Button>
          ),
          canManage && (
            <Button
              key="edit"
              component={RouterLink}
              to={`/cameras/${cameraId}/edit`}
              startIcon={<EditIcon />}
            >
              Edit
            </Button>
          ),
          canManage && (
            <Button
              key="delete"
              color="error"
              startIcon={<DeleteOutlineIcon />}
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          ),
        ]}
      />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Card>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ px: 2.5, py: 1.5 }}
            >
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {live ? "Live view" : "Snapshot"}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {live
                    ? "Every counted person boxed, the count on top; the frame turns red outside the limits."
                    : "The worker's latest frame, or a one-shot grab when it is stopped."}
                </Typography>
              </Box>
              {live ? (
                <Chip size="small" color="error" label="LIVE" />
              ) : (
                <Button
                  size="small"
                  startIcon={<RefreshIcon />}
                  onClick={() => {
                    setSnapshotKey(Date.now());
                    if (running) setStreamFailed(false);
                  }}
                >
                  Refresh frame
                </Button>
              )}
            </Stack>
            <Divider />
            {live ? (
              <Box
                component="img"
                key={streamKey}
                src={cameraApi.streamUrl(cameraId, streamKey)}
                alt={`Live view from ${camera.data.name}`}
                onError={() => setStreamFailed(true)}
                sx={{
                  height: 380,
                  width: "100%",
                  objectFit: "contain",
                  display: "block",
                  bgcolor: "common.black",
                }}
              />
            ) : (
              <ItemImage
                key={snapshotKey}
                src={cameraApi.snapshotUrl(cameraId, snapshotKey)}
                alt={`Snapshot from ${camera.data.name}`}
                height={380}
                fit="contain"
                fallbackLabel="No frame — the RTSP source is not answering"
              />
            )}
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Card sx={{ mb: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Occupancy
              </Typography>
              <Divider />
              <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mt: 2 }}>
                <Typography
                  variant="h2"
                  sx={{ fontWeight: 800 }}
                  color={worker?.in_violation ? "error.main" : "text.primary"}
                  data-testid="live-count"
                >
                  {running && worker?.connected && worker.current_count != null ? worker.current_count : "—"}
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  people now
                </Typography>
                <Box sx={{ flexGrow: 1 }} />
                <ThresholdChip
                  type={worker?.violation}
                  value={
                    worker?.violation === "greater_than"
                      ? camera.data.count_threshold_greater
                      : camera.data.count_threshold_less
                  }
                />
              </Stack>
              <DetailRow label="Limits">
                <Typography variant="body2">
                  {limitsText(camera.data)}
                  {camera.data.alert_enabled ? "" : " · alerts off"}
                </Typography>
              </DetailRow>
              {running && worker?.cooldown_remaining_s > 0 ? (
                <DetailRow label="Next alert">
                  <Typography variant="body2" color="text.secondary">
                    Held back for {formatDuration(worker.cooldown_remaining_s)} (cooldown)
                  </Typography>
                </DetailRow>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Configuration
              </Typography>
              <Divider />
              <DetailRow label="State">
                <EnabledChip enabled={camera.data.enabled} />
              </DetailRow>
              <DetailRow label="RTSP URL">
                <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                  {redactUrl(camera.data.rtsp_url)}
                </Typography>
              </DetailRow>
              <DetailRow label="Counting region">
                <Typography variant="body2" color="text.secondary">
                  {roi?.length ? `${roi.length}-point polygon (people standing inside it)` : "Whole frame"}
                </Typography>
              </DetailRow>
              <DetailRow label="Overrides">
                {Object.keys(settings).length ? (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {Object.entries(settings).map(([key, value]) => (
                      <Chip key={key} size="small" variant="outlined" label={`${key}: ${value}`} />
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Inheriting every global default
                  </Typography>
                )}
              </DetailRow>
              <DetailRow label="Registered">
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(camera.data.created_at)}
                </Typography>
              </DetailRow>
            </CardContent>
          </Card>

          <Card sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Worker
              </Typography>
              <Divider />
              {running ? (
                <>
                  <DetailRow label="Connection">
                    <Chip
                      size="small"
                      color={
                        worker.state === "error"
                          ? "error"
                          : worker.connected
                            ? "success"
                            : "warning"
                      }
                      label={
                        worker.state === "error"
                          ? "Error — supervisor will restart it"
                          : worker.connected
                            ? "Streaming"
                            : titleCase(worker.state || "reconnecting")
                      }
                    />
                  </DetailRow>
                  <DetailRow label="Last frame">
                    <Typography variant="body2" color="text.secondary">
                      {worker.last_frame_at
                        ? `${formatDuration(worker.seconds_since_frame)} ago · ${worker.fps ?? 0} fps`
                        : "None yet"}
                    </Typography>
                  </DetailRow>
                  <DetailRow label="Reconnects">
                    <Typography variant="body2">
                      {worker.reconnects ?? 0}
                      {worker.supervisor_restarts
                        ? ` · ${worker.supervisor_restarts} supervisor restart(s)`
                        : ""}
                    </Typography>
                  </DetailRow>
                  <DetailRow label="Started">
                    <Typography variant="body2" color="text.secondary">
                      {formatDateTime(worker.started_at)}
                    </Typography>
                  </DetailRow>
                  <DetailRow label="Frames processed">
                    <Typography variant="body2">{worker.frames_processed ?? 0}</Typography>
                  </DetailRow>
                  <DetailRow label="Samples stored">
                    <Typography variant="body2">
                      {worker.samples_stored ?? 0}
                      {worker.last_sample_at ? ` · last ${formatDateTime(worker.last_sample_at)}` : ""}
                    </Typography>
                  </DetailRow>
                  <DetailRow label="Violations">
                    <Typography variant="body2">
                      {worker.violations ?? 0} · {worker.alerts_raised ?? 0} alert(s) raised
                    </Typography>
                  </DetailRow>
                  {worker.last_error ? (
                    <DetailRow label="Last error">
                      <Typography variant="body2" color="error.main">
                        {worker.last_error}
                      </Typography>
                    </DetailRow>
                  ) : null}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                  Not running. Nothing from this camera is being analysed.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid size={12}>
          <Card>
            <Box sx={{ px: 2.5, py: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                Today
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Average count per 5 minutes since midnight; dashed lines are the limits.
              </Typography>
            </Box>
            <Divider />
            {points.length ? (
              <Box sx={{ p: 2 }}>
                <Sparkline
                  points={points}
                  height={140}
                  max={camera.data.count_threshold_greater}
                  min={camera.data.count_threshold_less}
                />
              </Box>
            ) : (
              <EmptyState
                title="No samples today"
                description={
                  running
                    ? "The first sample is stored a few seconds after the worker connects."
                    : "Start the worker to begin counting."
                }
              />
            )}
          </Card>
        </Grid>
      </Grid>

      <LimitsDialog
        open={editLimits}
        camera={camera.data}
        onClose={() => setEditLimits(false)}
        onSaved={() => {
          setEditLimits(false);
          camera.refresh();
          status.refresh();
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${camera.data.name}”?`}
        description="This also deletes its count history, violations and every alert it raised."
        confirmLabel="Delete"
        confirmColor="error"
        busy={busy}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </Box>
  );
}

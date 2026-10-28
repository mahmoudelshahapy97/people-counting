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
import NetworkCheckIcon from "@mui/icons-material/NetworkCheck";
import { ProbeDialog, useProbe } from "@insighteye/ui";
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
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
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
      setError(t("cameraDetail.limitsAreWholeNumbers0"));
      return;
    }
    if (greater !== null && less !== null && less >= greater) {
      setError(t("cameraDetail.theMinimumMustBeLower"));
      return;
    }
    setBusy(true);
    try {
      await cameraApi.setThresholds(camera.camera_id, {
        count_threshold_greater: greater,
        count_threshold_less: less,
        alert_enabled: enabled,
      });
      toast.success(t("cameraDetail.occupancyLimitsSaved"));
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth TransitionProps={{ onEnter: reset }}>
      <DialogTitle>{t("cameraDetail.occupancyLimits")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label={t("cameraDetail.maximumPeople")}
            type="number"
            value={max}
            onChange={(event) => setMax(event.target.value)}
            helperText={t("cameraDetail.blankNoMaximum")}
            inputProps={{ min: 0, step: 1 }}
            autoFocus
          />
          <TextField
            label={t("cameraDetail.minimumPeople")}
            type="number"
            value={min}
            onChange={(event) => setMin(event.target.value)}
            helperText={t("cameraDetail.blankNoMinimum")}
            inputProps={{ min: 0, step: 1 }}
          />
          <FormControlLabel
            control={<Switch checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />}
            label={t("cameraDetail.raiseAlerts")}
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
          {t("cameraDetail.cancel")}
        </Button>
        <Button variant="contained" onClick={save} disabled={busy}>
          {busy ? t("cameraDetail.saving") : t("cameraDetail.saveLimits")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function CameraDetail() {
  const { t } = useTranslation();
  const { cameraId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canOperate = hasRole("operator");
  const canManage = hasRole("admin");

  const camera = useAsync(({ signal }) => cameraApi.get(cameraId, { signal }), [cameraId]);
  const probe = useProbe(cameraApi, errorMessage);
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
      toast.success(t("cameraDetail.cameraV0Deleted", { v0: camera.data?.name }));
      navigate("/cameras");
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  if (camera.loading && !camera.data) return <Loading label={t("cameraDetail.loadingCamera")} />;
  if (camera.error) return <ErrorState error={camera.error} onRetry={camera.refresh} />;
  if (!camera.data) return null;

  return (
    <Box>
      <Button component={RouterLink} to="/cameras" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
        {t("cameraDetail.allCameras")}
      </Button>

      <PageHeader
        title={camera.data.name}
        subtitle={locationText(camera.data) || t("cameraDetail.noLocationSet")}
        actions={[
          canOperate && (
            <Button key="probe" startIcon={<NetworkCheckIcon />} onClick={() => probe.probe(cameraId)}>
              {t("actions.testConnection")}
            </Button>
          ),
          canOperate &&
            (running ? (
              <Button
                key="stop"
                variant="outlined"
                color="warning"
                startIcon={<StopIcon />}
                disabled={busy}
                onClick={() => runAction(() => cameraApi.stop(cameraId), t("cameraDetail.workerStopped"))}
              >
                {t("cameraDetail.stopWorker")}
              </Button>
            ) : (
              <Button
                key="start"
                variant="contained"
                startIcon={<PlayArrowIcon />}
                disabled={busy}
                onClick={() => runAction(() => cameraApi.start(cameraId), t("cameraDetail.workerStarted"))}
              >
                {t("cameraDetail.startWorker")}
              </Button>
            )),
          <Button key="alerts" component={RouterLink} to={`/alerts?camera_id=${cameraId}`}>
            {t("cameraDetail.viewAlerts")}
          </Button>,
          canOperate && (
            <Button key="limits" startIcon={<TuneIcon />} onClick={() => setEditLimits(true)}>
              {t("cameraDetail.limits")}
            </Button>
          ),
          canManage && (
            <Button
              key="edit"
              component={RouterLink}
              to={`/cameras/${cameraId}/edit`}
              startIcon={<EditIcon />}
            >
              {t("cameraDetail.edit")}
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
              {t("cameraDetail.delete")}
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
                  {live ? t("cameraDetail.liveView") : t("cameraDetail.snapshot")}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {live
                    ? t("cameraDetail.everyCountedPersonBoxedThe")
                    : t("cameraDetail.theWorkerSLatestFrame")}
                </Typography>
              </Box>
              {live ? (
                <Chip size="small" color="error" label={t("cameraDetail.live")} />
              ) : (
                <Button
                  size="small"
                  startIcon={<RefreshIcon />}
                  onClick={() => {
                    setSnapshotKey(Date.now());
                    if (running) setStreamFailed(false);
                  }}
                >
                  {t("cameraDetail.refreshFrame")}
                </Button>
              )}
            </Stack>
            <Divider />
            {live ? (
              <Box
                component="img"
                key={streamKey}
                src={cameraApi.streamUrl(cameraId, streamKey)}
                alt={t("cameraDetail.liveViewFromName", { name: camera.data.name })}
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
                alt={t("cameraDetail.snapshotFromName", { name: camera.data.name })}
                height={380}
                fit="contain"
                fallbackLabel={t("cameraDetail.noFrameTheRtspSource")}
              />
            )}
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Card sx={{ mb: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                {t("cameraDetail.occupancy")}
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
                  {t("cameraDetail.peopleNow")}
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
              <DetailRow label={t("cameraDetail.limits")}>
                <Typography variant="body2">
                  {limitsText(camera.data)}
                  {camera.data.alert_enabled ? "" : t("cameraDetail.alertsOff")}
                </Typography>
              </DetailRow>
              {running && worker?.cooldown_remaining_s > 0 ? (
                <DetailRow label={t("cameraDetail.nextAlert")}>
                  <Typography variant="body2" color="text.secondary">
                    {t("cameraDetail.heldBackForV0Cooldown", { v0: formatDuration(worker.cooldown_remaining_s) })}
                  </Typography>
                </DetailRow>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                {t("cameraDetail.configuration")}
              </Typography>
              <Divider />
              <DetailRow label={t("cameraDetail.state")}>
                <EnabledChip enabled={camera.data.enabled} />
              </DetailRow>
              <DetailRow label={t("cameraDetail.rtspUrl")}>
                <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                  {redactUrl(camera.data.rtsp_url)}
                </Typography>
              </DetailRow>
              <DetailRow label={t("cameraDetail.countingRegion")}>
                <Typography variant="body2" color="text.secondary">
                  {roi?.length ? t("cameraDetail.lengthPointPolygonPeopleStanding", { length: roi.length }) : t("cameraDetail.wholeFrame")}
                </Typography>
              </DetailRow>
              <DetailRow label={t("cameraDetail.overrides")}>
                {Object.keys(settings).length ? (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {Object.entries(settings).map(([key, value]) => (
                      <Chip key={key} size="small" variant="outlined" label={`${key}: ${value}`} />
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    {t("cameraDetail.inheritingEveryGlobalDefault")}
                  </Typography>
                )}
              </DetailRow>
              <DetailRow label={t("cameraDetail.registered")}>
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(camera.data.created_at)}
                </Typography>
              </DetailRow>
            </CardContent>
          </Card>

          <Card sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                {t("cameraDetail.worker")}
              </Typography>
              <Divider />
              {running ? (
                <>
                  <DetailRow label={t("cameraDetail.connection")}>
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
                          ? t("cameraDetail.errorSupervisorWillRestartIt")
                          : worker.connected
                            ? t("cameraDetail.streaming")
                            : titleCase(worker.state || "reconnecting")
                      }
                    />
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.lastFrame")}>
                    <Typography variant="body2" color="text.secondary">
                      {worker.last_frame_at
                        ? t("cameraDetail.v0AgoV1Fps", { v0: formatDuration(worker.seconds_since_frame), v1: worker.fps ?? 0 })
                        : t("cameraDetail.noneYet")}
                    </Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.reconnects")}>
                    <Typography variant="body2">
                      {worker.reconnects ?? 0}
                      {worker.supervisor_restarts
                        ? t("cameraDetail.supervisorRestartsSupervisorRestartS", { supervisor_restarts: worker.supervisor_restarts })
                        : ""}
                    </Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.started")}>
                    <Typography variant="body2" color="text.secondary">
                      {formatDateTime(worker.started_at)}
                    </Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.framesProcessed")}>
                    <Typography variant="body2">{worker.frames_processed ?? 0}</Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.samplesStored")}>
                    <Typography variant="body2">
                      {worker.samples_stored ?? 0}
                      {worker.last_sample_at ? t("cameraDetail.lastV0", { v0: formatDateTime(worker.last_sample_at) }) : ""}
                    </Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.violations")}>
                    <Typography variant="body2">
                      {t("cameraDetail.v0V1AlertSRaised", { v0: worker.violations ?? 0, v1: worker.alerts_raised ?? 0 })}
                    </Typography>
                  </DetailRow>
                  {worker.last_error ? (
                    <DetailRow label={t("cameraDetail.lastError")}>
                      <Typography variant="body2" color="error.main">
                        {worker.last_error}
                      </Typography>
                    </DetailRow>
                  ) : null}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                  {t("cameraDetail.notRunningNothingFromThis")}
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid size={12}>
          <Card>
            <Box sx={{ px: 2.5, py: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t("cameraDetail.today")}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("cameraDetail.averageCountPer5Minutes")}
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
                title={t("cameraDetail.noSamplesToday")}
                description={
                  running
                    ? t("cameraDetail.theFirstSampleIsStored")
                    : t("cameraDetail.startTheWorkerToBegin")
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

      <ProbeDialog {...probe.dialogProps} />
      <ConfirmDialog
        open={confirmDelete}
        title={t("cameraDetail.deleteName", { name: camera.data.name })}
        description={t("cameraDetail.thisAlsoDeletesItsCount")}
        confirmLabel={t("cameraDetail.delete")}
        confirmColor="error"
        busy={busy}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </Box>
  );
}

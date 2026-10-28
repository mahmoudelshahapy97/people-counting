import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid2";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";

import { errorMessage } from "../../api/client";
import { cameras as camerasApi } from "../../api/endpoints";
import { useAsync } from "../../hooks/useAsync";
import { useToast } from "../../components/Toast";
import { ErrorState, Loading } from "../../components/DataStates";
import PageHeader from "../../components/PageHeader";
import { parseJsonField } from "../../utils/format";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

const EMPTY = {
  name: "",
  rtsp_url: "",
  enabled: true,
  location: "",
  building: "",
  floor_level: "",
  zone: "",
  area: "",
  alert_enabled: true,
  count_threshold_greater: "",
  count_threshold_less: "",
  confidence: "",
  sample_interval_s: "",
  alert_cooldown_s: "",
};

const LOCATION_FIELDS = [
  { key: "building", get label() { return i18n.t("cameraForm.building"); }, placeholder: "HQ", max: 100 },
  { key: "floor_level", get label() { return i18n.t("cameraForm.floor"); }, placeholder: "G, 1, 2…", max: 40 },
  { key: "zone", get label() { return i18n.t("cameraForm.zone"); }, placeholder: "Entrance", max: 120 },
  { key: "area", get label() { return i18n.t("cameraForm.area"); }, placeholder: "Lobby", max: 120 },
];

/**
 * The counting knobs a camera may override, mirroring CountParams. They live
 * in the `settings` jsonb rather than in columns of their own, so an absent
 * key means "inherit the global .env value" — which is why blanks are omitted
 * from the payload rather than sent as zero.
 */
const OVERRIDE_FIELDS = [
  {
    key: "confidence",
    get label() { return i18n.t("cameraForm.detectorConfidence"); },
    unit: "0–1",
    get help() { return i18n.t("cameraForm.boxesBelowThisScoreAre"); },
    min: 0.05,
    max: 0.95,
    step: 0.05,
  },
  {
    key: "sample_interval_s",
    get label() { return i18n.t("cameraForm.storeASampleEvery"); },
    unit: "s",
    get help() { return i18n.t("cameraForm.howOftenTheCountIs"); },
    min: 1,
    max: 3600,
  },
  {
    key: "alert_cooldown_s",
    get label() { return i18n.t("cameraForm.alertCooldown"); },
    unit: "s",
    get help() { return i18n.t("cameraForm.atMostOneAlertPer"); },
    min: 0,
    max: 86400,
  },
];

const blank = (raw) => raw === "" || raw === null || raw === undefined;

function validate(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = i18n.t("cameraForm.required");
  else if (values.name.length > 120) errors.name = i18n.t("cameraForm.atMost120Characters");

  if (!values.rtsp_url.trim()) errors.rtsp_url = i18n.t("cameraForm.required");
  if (values.location.length > 200) errors.location = i18n.t("cameraForm.atMost200Characters");
  LOCATION_FIELDS.forEach(({ key, max }) => {
    if (values[key].length > max) errors[key] = i18n.t("cameraForm.atMostMaxCharacters", { max });
  });

  for (const key of ["count_threshold_greater", "count_threshold_less"]) {
    const raw = values[key];
    if (blank(raw)) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) errors[key] = i18n.t("cameraForm.aWholeNumber0Or");
  }
  // The API and the database both refuse this; say so before the round trip.
  const max = blank(values.count_threshold_greater) ? null : Number(values.count_threshold_greater);
  const min = blank(values.count_threshold_less) ? null : Number(values.count_threshold_less);
  if (max !== null && min !== null && min >= max) {
    errors.count_threshold_less = i18n.t("cameraForm.mustBeLowerThanThe");
  }

  OVERRIDE_FIELDS.forEach(({ key, min: lo, max: hi }) => {
    const raw = values[key];
    if (blank(raw)) return;
    const value = Number(raw);
    if (Number.isNaN(value)) errors[key] = i18n.t("cameraForm.mustBeANumber");
    else if (value < lo || value > hi) errors[key] = i18n.t("cameraForm.betweenLoAndHi", { lo, hi });
  });

  return errors;
}

export default function CameraForm() {
  const { t } = useTranslation();
  const { cameraId } = useParams();
  const isEdit = Boolean(cameraId);
  const navigate = useNavigate();
  const toast = useToast();

  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const {
    data: camera,
    error: loadError,
    loading,
    refresh,
  } = useAsync(({ signal }) => camerasApi.get(cameraId, { signal }), [cameraId], {
    enabled: isEdit,
  });

  useEffect(() => {
    if (!camera) return;
    const settings = parseJsonField(camera.settings, {}) || {};
    setValues({
      name: camera.name ?? "",
      rtsp_url: camera.rtsp_url ?? "",
      enabled: camera.enabled ?? true,
      location: camera.location ?? "",
      building: camera.building ?? "",
      floor_level: camera.floor_level ?? "",
      zone: camera.zone ?? "",
      area: camera.area ?? "",
      alert_enabled: camera.alert_enabled ?? true,
      count_threshold_greater: camera.count_threshold_greater ?? "",
      count_threshold_less: camera.count_threshold_less ?? "",
      confidence: settings.confidence ?? "",
      sample_interval_s: settings.sample_interval_s ?? "",
      alert_cooldown_s: settings.alert_cooldown_s ?? "",
    });
  }, [camera]);

  const setField = (field) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const payload = useMemo(() => {
    // Keep any other override already stored (set through the API by hand).
    const settings = { ...(parseJsonField(camera?.settings, {}) || {}) };
    OVERRIDE_FIELDS.forEach(({ key }) => {
      const raw = values[key];
      // Omitted, not zeroed: an absent key is what "inherit the default" means.
      if (blank(raw)) delete settings[key];
      else settings[key] = Number(raw);
    });
    const text = (key) => values[key].trim() || null;
    // A blank limit is sent as null, which removes it.
    const limit = (key) => (blank(values[key]) ? null : Number(values[key]));

    return {
      name: values.name.trim(),
      rtsp_url: values.rtsp_url.trim(),
      enabled: values.enabled,
      location: text("location"),
      building: text("building"),
      floor_level: text("floor_level"),
      zone: text("zone"),
      area: text("area"),
      alert_enabled: values.alert_enabled,
      count_threshold_greater: limit("count_threshold_greater"),
      count_threshold_less: limit("count_threshold_less"),
      settings,
    };
  }, [values, camera]);

  const submit = async (event) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    setSubmitError(null);
    try {
      if (isEdit) {
        await camerasApi.update(cameraId, payload);
        toast.success(t("cameraForm.cameraNameUpdated", { name: payload.name }));
        navigate(`/cameras/${cameraId}`);
      } else {
        const created = await camerasApi.create(payload);
        toast.success(t("cameraForm.cameraNameRegistered", { name: created.name }));
        navigate(`/cameras/${created.camera_id}`);
      }
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isEdit && loading && !camera) return <Loading label={t("cameraForm.loadingCamera")} />;
  if (isEdit && loadError) return <ErrorState error={loadError} onRetry={refresh} />;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
        sx={{ mb: 2 }}
      >
        {t("cameraForm.back")}
      </Button>

      <PageHeader
        title={isEdit ? t("cameraForm.editV0", { v0: camera?.name || "camera" }) : t("cameraForm.registerACamera")}
        subtitle={
          isEdit
            ? t("cameraForm.aRunningWorkerIsRestarted")
            : t("cameraForm.anEnabledCameraStartsCounting")
        }
      />

      <Box component="form" onSubmit={submit} noValidate>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>
                  {t("cameraForm.source")}
                </Typography>
                <Stack spacing={2.5}>
                  <TextField
                    label={t("cameraForm.name")}
                    value={values.name}
                    onChange={setField("name")}
                    error={Boolean(errors.name)}
                    helperText={errors.name || t("cameraForm.mustBeUniqueWithinThis")}
                    required
                    fullWidth
                    autoFocus
                  />
                  <TextField
                    label={t("cameraForm.rtspUrl")}
                    value={values.rtsp_url}
                    onChange={setField("rtsp_url")}
                    error={Boolean(errors.rtsp_url)}
                    helperText={
                      errors.rtsp_url ||
                      t("cameraForm.rtspUserPassHost554")
                    }
                    required
                    fullWidth
                    placeholder={t("cameraForm.rtspMediamtx8554People")}
                  />
                  <FormControlLabel
                    control={<Switch checked={values.enabled} onChange={setField("enabled")} />}
                    label={t("cameraForm.enabled")}
                  />
                </Stack>
              </CardContent>
            </Card>

            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {t("cameraForm.placement")}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  {t("cameraForm.theAnalyticsGroupByFloor")}
                </Typography>
                <Grid container spacing={2}>
                  <Grid size={12}>
                    <TextField
                      label={t("cameraForm.location")}
                      value={values.location}
                      onChange={setField("location")}
                      error={Boolean(errors.location)}
                      helperText={errors.location || t("cameraForm.whereAnOperatorWouldPhysically")}
                      fullWidth
                      placeholder={t("cameraForm.hqLobbyDoors")}
                    />
                  </Grid>
                  {LOCATION_FIELDS.map(({ key, label, placeholder }) => (
                    <Grid key={key} size={{ xs: 12, sm: 6 }}>
                      <TextField
                        label={label}
                        value={values[key]}
                        onChange={setField(key)}
                        error={Boolean(errors[key])}
                        helperText={errors[key]}
                        placeholder={placeholder}
                        fullWidth
                      />
                    </Grid>
                  ))}
                </Grid>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {t("cameraForm.occupancyLimits")}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  {t("cameraForm.aCountAboveTheMaximum")}
                </Typography>
                <Divider sx={{ mb: 2.5 }} />
                <Stack spacing={2.5}>
                  <TextField
                    label={t("cameraForm.maximumPeople")}
                    value={values.count_threshold_greater}
                    onChange={setField("count_threshold_greater")}
                    error={Boolean(errors.count_threshold_greater)}
                    helperText={errors.count_threshold_greater || t("cameraForm.alertWhenMorePeopleThan")}
                    type="number"
                    inputProps={{ min: 0, step: 1 }}
                    fullWidth
                  />
                  <TextField
                    label={t("cameraForm.minimumPeople")}
                    value={values.count_threshold_less}
                    onChange={setField("count_threshold_less")}
                    error={Boolean(errors.count_threshold_less)}
                    helperText={errors.count_threshold_less || t("cameraForm.alertWhenFewerPeopleThan")}
                    type="number"
                    inputProps={{ min: 0, step: 1 }}
                    fullWidth
                  />
                  <FormControlLabel
                    control={
                      <Switch checked={values.alert_enabled} onChange={setField("alert_enabled")} />
                    }
                    label={t("cameraForm.raiseAlerts")}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {t("cameraForm.offViolationsAreStillRecorded")}
                  </Typography>
                </Stack>
              </CardContent>
            </Card>

            <Card sx={{ mt: 2 }}>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {t("cameraForm.countingOverrides")}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  {t("cameraForm.leaveAFieldBlankTo")}
                </Typography>
                <Divider sx={{ mb: 2.5 }} />
                <Stack spacing={2.5}>
                  {OVERRIDE_FIELDS.map(({ key, label, unit, help, step }) => (
                    <TextField
                      key={key}
                      label={label}
                      value={values[key]}
                      onChange={setField(key)}
                      error={Boolean(errors[key])}
                      helperText={errors[key] || help}
                      type="number"
                      fullWidth
                      inputProps={step ? { step } : undefined}
                      slotProps={{
                        input: {
                          endAdornment: <InputAdornment position="end">{unit}</InputAdornment>,
                        },
                      }}
                    />
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={12}>
            {submitError ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                {submitError}
              </Alert>
            ) : null}
            <Stack direction="row" spacing={1}>
              <Button type="submit" variant="contained" disabled={saving}>
                {saving ? t("cameraForm.saving") : isEdit ? t("cameraForm.saveChanges") : t("cameraForm.registerCamera")}
              </Button>
              <Button
                color="inherit"
                disabled={saving}
                onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
              >
                {t("cameraForm.cancel")}
              </Button>
            </Stack>
          </Grid>
        </Grid>
      </Box>
    </Box>
  );
}

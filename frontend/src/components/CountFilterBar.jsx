import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import ButtonGroup from "@mui/material/ButtonGroup";
import Card from "@mui/material/Card";
import Grid from "@mui/material/Grid2";
import TextField from "@mui/material/TextField";

import { cameras as cameraApi, counts } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import { EMPTY_FILTERS, RANGE_PRESETS, presetDates } from "../utils/filters";
import { useTranslation } from "react-i18next";

const LOCATION_KEYS = [
  ["buildings", "Buildings"],
  ["floors", "Floors"],
  ["zones", "Zones"],
  ["areas", "Areas"],
];

/**
 * Dates, cameras and the location hierarchy: InsightEye's OrderFilter, laid
 * out inline instead of in a popup. `value` is the shape of EMPTY_FILTERS;
 * every change is applied at once.
 */
export function CountFilterBar({ value, onChange }) {
  const { t } = useTranslation();
  const cameraList = useAsync(({ signal }) => cameraApi.list(undefined, { signal }), []);
  const options = useAsync(({ signal }) => counts.locations({ signal }), []);
  const locations = options.data?.data || {};
  const cameraOptions = cameraList.data || [];

  const set = (patch) => onChange({ ...value, ...patch });
  const activePreset = RANGE_PRESETS.find(([, days]) => {
    const preset = presetDates(days);
    return preset.start_date === value.start_date && preset.end_date === value.end_date;
  });

  return (
    <Card sx={{ p: 2, mb: 2 }}>
      <Grid container spacing={2} alignItems="center">
        <Grid size={{ xs: 12, md: "auto" }}>
          <ButtonGroup size="small" aria-label={t("countFilterBar.dateRange")}>
            {RANGE_PRESETS.map(([label, days]) => (
              <Button
                key={label}
                variant={activePreset?.[1] === days ? "contained" : "outlined"}
                onClick={() => set(presetDates(days))}
              >
                {label}
              </Button>
            ))}
          </ButtonGroup>
        </Grid>
        <Grid size={{ xs: 6, md: "auto" }}>
          <TextField
            label={t("countFilterBar.from")}
            type="date"
            size="small"
            value={value.start_date || ""}
            onChange={(event) => set({ start_date: event.target.value })}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: value.end_date } }}
          />
        </Grid>
        <Grid size={{ xs: 6, md: "auto" }}>
          <TextField
            label={t("countFilterBar.to")}
            type="date"
            size="small"
            value={value.end_date || ""}
            onChange={(event) => set({ end_date: event.target.value })}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: value.start_date } }}
          />
        </Grid>
        <Grid size={{ xs: 12, md: true }}>
          <Autocomplete
            multiple
            size="small"
            options={cameraOptions}
            getOptionLabel={(camera) => camera.name}
            value={cameraOptions.filter((camera) => value.camera_id.includes(camera.camera_id))}
            onChange={(_, picked) => set({ camera_id: picked.map((camera) => camera.camera_id) })}
            isOptionEqualToValue={(a, b) => a.camera_id === b.camera_id}
            renderInput={(params) => (
              <TextField {...params} label={t("countFilterBar.cameras")} placeholder={value.camera_id.length ? "" : t("countFilterBar.allCameras")} />
            )}
          />
        </Grid>
        {LOCATION_KEYS.map(([key, label]) =>
          locations[key]?.length ? (
            <Grid key={key} size={{ xs: 12, sm: 6, md: 3 }}>
              <Autocomplete
                multiple
                size="small"
                options={locations[key]}
                value={value[key]}
                onChange={(_, picked) => set({ [key]: picked })}
                renderInput={(params) => <TextField {...params} label={label} />}
              />
            </Grid>
          ) : null
        )}
        <Grid size={{ xs: 12, md: "auto" }}>
          <Button onClick={() => onChange(EMPTY_FILTERS)}>{t("countFilterBar.reset")}</Button>
        </Grid>
      </Grid>
    </Card>
  );
}

export default CountFilterBar;

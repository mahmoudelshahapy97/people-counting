import { useMemo } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

// Postgres EXTRACT(DOW): 0 is Sunday.
// Postgres EXTRACT(DOW) order, 0 = Sunday; names come from the locale.
const weekdays = () => i18n.t("common:time.weekdaysShort", { returnObjects: true });
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const pad = (hour) => String(hour).padStart(2, "0");

/**
 * Weekday x hour-of-day grid: here, the average head count per hour.
 *
 * Chart.js has no matrix type, and one grid of boxes is not worth a plugin.
 * One hue, light to dark: the cells only ever say "how many", so a second hue
 * would suggest a polarity that is not in the data. Empty cells keep a faint
 * fill so the grid still reads as a grid.
 *
 * `cells` is sparse - [{weekday, hour, [valueKey]}] for the non-empty ones only.
 */
export function HourHeatmap({ cells = [], valueKey = "avg_person_count", unit = "person", digits = 1 }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const base = theme.palette.primary.main;

  const { grid, max } = useMemo(() => {
    const counts = Array.from({ length: 7 }, () => HOURS.map(() => 0));
    let peak = 0;
    for (const cell of cells) {
      const value = Number(cell[valueKey]) || 0;
      counts[cell.weekday][cell.hour] = value;
      peak = Math.max(peak, value);
    }
    return { grid: counts, max: peak };
  }, [cells, valueKey]);
  const show = (value) => (Number.isInteger(value) ? value : value.toFixed(digits));
  const plural = (value) => (value === 1 ? unit : unit === "person" ? "people" : `${unit}s`);

  const fill = (value) =>
    value ? alpha(base, 0.15 + 0.85 * (value / max)) : alpha(theme.palette.text.primary, 0.04);

  return (
    <Box>
      {/* Scrolls sideways on a phone rather than squashing 24 columns. */}
      <Box sx={{ overflowX: "auto", pb: 1 }} dir="ltr">
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "36px repeat(24, minmax(18px, 1fr))",
            gap: "2px",
            minWidth: 520,
          }}
        >
          <Box />
          {HOURS.map((hour) => (
            <Typography
              key={hour}
              variant="caption"
              color="text.secondary"
              sx={{ textAlign: "center", lineHeight: 1.6 }}
            >
              {hour % 3 === 0 ? pad(hour) : ""}
            </Typography>
          ))}

          {weekdays().map((day, weekday) => [
            <Typography
              key={`${day}-label`}
              variant="caption"
              color="text.secondary"
              sx={{ alignSelf: "center" }}
            >
              {day}
            </Typography>,
            ...HOURS.map((hour) => {
              const value = grid[weekday][hour];
              return (
                <Tooltip
                  key={`${day}-${hour}`}
                  title={t("hourHeatmap.dayV100V259", { day, v1: pad(hour), v2: pad(hour), v3: show(value), v4: plural(value) })}
                  disableInteractive
                >
                  <Box
                    tabIndex={0}
                    aria-label={`${day} ${pad(hour)}:00, ${show(value)} ${plural(value)}`}
                    sx={{
                      height: 22,
                      borderRadius: "4px",
                      bgcolor: fill(value),
                      outline: "none",
                      "&:hover, &:focus-visible": {
                        boxShadow: `0 0 0 2px ${theme.palette.text.primary}`,
                      },
                    }}
                  />
                </Tooltip>
              );
            }),
          ])}
        </Box>
      </Box>

      <Stack direction="row" alignItems="center" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary">
          0
        </Typography>
        <Box
          sx={{
            width: 120,
            height: 8,
            borderRadius: 4,
            background: `linear-gradient(90deg, ${alpha(base, 0.15)}, ${base})`,
          }}
        />
        <Typography variant="caption" color="text.secondary">
          {t("hourHeatmap.v0Average", { v0: show(max) })}
        </Typography>
      </Stack>
    </Box>
  );
}

export default HourHeatmap;

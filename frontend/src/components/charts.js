import { useMemo } from "react";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
} from "chart.js";
import { useTheme } from "@mui/material/styles";

// Registered once, here: only the lazy Analytics and History chunks import
// this module, so chart.js never lands in the main bundle.
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Filler,
  ChartTooltip,
  Legend
);

/**
 * Series colours that hold up in both themes. Cycled when there are more
 * series (cameras, floors, weekdays) than colours.
 */
export const SERIES = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

export const seriesColor = (index) => SERIES[index % SERIES.length];

/** Axes, grid and legend styled from the MUI theme. */
export function useBaseOptions() {
  const theme = useTheme();
  return useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: theme.palette.text.secondary, maxRotation: 0, autoSkipPadding: 12 },
          grid: { display: false },
          border: { color: theme.palette.divider },
        },
        y: {
          beginAtZero: true,
          ticks: { color: theme.palette.text.secondary },
          grid: { color: theme.palette.divider },
          border: { display: false },
        },
      },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: {
            color: theme.palette.text.secondary,
            boxWidth: 10,
            boxHeight: 10,
            useBorderRadius: true,
            borderRadius: 2,
          },
        },
      },
    }),
    [theme]
  );
}

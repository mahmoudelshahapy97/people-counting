import { useMemo } from "react";
import Box from "@mui/material/Box";
import { Line } from "react-chartjs-2";
import dayjs from "dayjs";

import { seriesColor, useBaseOptions } from "./charts";
import { useTranslation } from "react-i18next";

const LABEL_FORMAT = {
  "5 minutes": "HH:mm",
  "1 hour": "MMM D HH:mm",
  "1 day": "MMM D",
};

/**
 * People over time, one line per camera: GET /analytics/timeseries.
 * InsightEye's ChartSearch ("Person Count by Camera Over Time"), on buckets
 * instead of raw samples.
 */
export function TrendChart({ cameras = [], interval = "1 hour", height = 320 }) {
  const { t } = useTranslation();
  const baseOptions = useBaseOptions();

  const chart = useMemo(() => {
    // One shared x axis: the union of every camera's buckets, in order.
    const stamps = [...new Set(cameras.flatMap((c) => c.datapoints.map((p) => p.timestamp)))].sort();
    const format = LABEL_FORMAT[interval] || "MMM D HH:mm";
    return {
      data: {
        labels: stamps.map((stamp) => dayjs(stamp).format(format)),
        datasets: cameras.map((camera, index) => {
          const byStamp = new Map(camera.datapoints.map((p) => [p.timestamp, p.avg_person_count]));
          return {
            label: camera.camera_name,
            data: stamps.map((stamp) => byStamp.get(stamp) ?? null),
            borderColor: seriesColor(index),
            backgroundColor: seriesColor(index),
            pointRadius: 0,
            tension: 0.3,
            spanGaps: false,
          };
        }),
      },
      options: {
        ...baseOptions,
        scales: {
          ...baseOptions.scales,
          y: { ...baseOptions.scales.y, title: { display: true, text: t("trendChart.peopleAverage") } },
        },
      },
    };
  }, [cameras, interval, baseOptions, t]);

  return (
    <Box sx={{ height, mt: 2 }}>
      <Line data={chart.data} options={chart.options} />
    </Box>
  );
}

export default TrendChart;

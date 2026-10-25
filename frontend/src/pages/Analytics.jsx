import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid2";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";

import GroupsIcon from "@mui/icons-material/Groups";
import NotificationsIcon from "@mui/icons-material/NotificationsActive";
import RefreshIcon from "@mui/icons-material/Refresh";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import WarningIcon from "@mui/icons-material/WarningAmber";

import { Bar, Line } from "react-chartjs-2";
import dayjs from "dayjs";

import { analytics } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import CountFilterBar from "../components/CountFilterBar";
import HourHeatmap from "../components/HourHeatmap";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import TrendChart from "../components/TrendChart";
import { seriesColor, useBaseOptions } from "../components/charts";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import { WEEKDAYS } from "../utils/constants";
import { EMPTY_FILTERS, countParams, limitsText } from "../utils/filters";
import { formatDateTime, formatNumber } from "../utils/format";

const pad = (hour) => `${String(hour).padStart(2, "0")}:00`;
const formatPct = (value) => (value === null || value === undefined ? "—" : `${Number(value).toFixed(1)}%`);

function ChartCard({ title, subtitle, children, empty }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent>
        <Typography variant="subtitle2">{title}</Typography>
        {subtitle && (
          <Typography variant="caption" color="text.secondary">
            {subtitle}
          </Typography>
        )}
        <Box sx={{ mt: 2 }}>
          {empty ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 6, textAlign: "center" }}>
              No samples in this range.
            </Typography>
          ) : (
            children
          )}
        </Box>
      </CardContent>
    </Card>
  );
}

const ChartBox = ({ height = 280, children }) => <Box sx={{ height }}>{children}</Box>;

/** Pivot [{group, key, value}] rows into one dataset per group. */
function pivot(rows, groupKey, labelKey, labels) {
  const groups = [...new Set(rows.map((row) => row[groupKey]))];
  return groups.map((group, index) => {
    const byLabel = new Map(
      rows.filter((row) => row[groupKey] === group).map((row) => [row[labelKey], row.avg_person_count])
    );
    return {
      label: `Floor ${group}`,
      data: labels.map((label) => byLabel.get(label) ?? null),
      backgroundColor: seriesColor(index),
      borderColor: seriesColor(index),
      borderRadius: 4,
      pointRadius: 0,
      tension: 0.4,
      fill: false,
    };
  });
}

export default function Analytics() {
  const theme = useTheme();
  const baseOptions = useBaseOptions();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const query = useMemo(() => countParams(filters), [filters]);

  // Every report for the same filter, in parallel: one loading state, one error.
  const { data, error, loading, refresh } = useAsync(
    async ({ signal }) => {
      const opts = { signal };
      const [
        summary,
        byCamera,
        busiest,
        byFloor,
        floorWeekday,
        floorHour,
        series,
        violations,
      ] = await Promise.all([
        analytics.summary(query, opts),
        analytics.averageByCamera(query, opts),
        analytics.busiestHours(query, opts),
        analytics.averageByFloor(query, opts),
        analytics.floorsByWeekday(query, opts),
        analytics.floorsByHour(query, opts),
        analytics.timeseries(query, opts),
        analytics.violationsByCamera(query, opts),
      ]);
      return { summary: summary.data, byCamera, busiest, byFloor, floorWeekday, floorHour, series, violations };
    },
    [query.toString()]
  );

  const charts = useMemo(() => {
    if (!data) return null;
    const bar = (extra = {}) => ({
      ...baseOptions,
      ...extra,
      plugins: { ...baseOptions.plugins, legend: { display: false }, ...(extra.plugins || {}) },
    });

    // Occupancy over the window: average and peak per bucket.
    const points = data.summary.series || [];
    const hourly = data.summary.window.bucket === "hour";
    const occupancy = {
      data: {
        labels: points.map((p) => dayjs(p.bucket_start).format(hourly ? "HH:mm" : "MMM D")),
        datasets: [
          {
            label: "Average",
            data: points.map((p) => p.avg_person_count),
            borderColor: theme.palette.primary.main,
            backgroundColor: `${theme.palette.primary.main}33`,
            fill: true,
            tension: 0.35,
            pointRadius: 0,
          },
          {
            label: "Peak",
            data: points.map((p) => p.max_person_count),
            borderColor: theme.palette.error.main,
            borderDash: [6, 4],
            tension: 0.35,
            pointRadius: 0,
          },
        ],
      },
      options: baseOptions,
    };

    // InsightEye AveragePeopleChart: one bar per camera.
    const cams = data.byCamera.data;
    const byCamera = {
      data: {
        labels: cams.map((row) => row.camera_name),
        datasets: [
          {
            label: "Average people",
            data: cams.map((row) => row.avg_person_count),
            backgroundColor: theme.palette.info.main,
            borderRadius: 6,
          },
        ],
      },
      options: bar({ indexAxis: cams.length > 6 ? "y" : "x" }),
    };

    // InsightEye BusiestHourChart: one bar per weekday, its busiest hour in the tooltip.
    const busiestByDay = new Map(data.busiest.data.map((row) => [row.weekday_num, row]));
    const busiest = {
      data: {
        labels: WEEKDAYS.map((day, num) => {
          const row = busiestByDay.get(num);
          return row ? [day, pad(row.hour)] : day;
        }),
        datasets: [
          {
            label: "Average at the busiest hour",
            data: WEEKDAYS.map((_, num) => busiestByDay.get(num)?.avg_person_count ?? null),
            backgroundColor: theme.palette.secondary.main,
            borderRadius: 6,
          },
        ],
      },
      options: bar({
        plugins: {
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const row = busiestByDay.get(ctx.dataIndex);
                return row ? `Avg ${row.avg_person_count} at ${pad(row.hour)}` : "No samples";
              },
            },
          },
        },
      }),
    };

    const floors = data.byFloor.data;
    const byFloor = {
      data: {
        labels: floors.map((row) => `Floor ${row.floor_level}`),
        datasets: [
          {
            label: "Average people",
            data: floors.map((row) => row.avg_person_count),
            backgroundColor: theme.palette.success.main,
            borderRadius: 6,
          },
        ],
      },
      options: bar(),
    };

    const floorWeekday = {
      data: {
        labels: WEEKDAYS,
        datasets: pivot(data.floorWeekday.data, "floor_level", "weekday_name", WEEKDAYS),
      },
      options: baseOptions,
    };

    const hours = Array.from({ length: 24 }, (_, h) => h);
    const floorHour = {
      data: {
        labels: hours.map(pad),
        datasets: pivot(data.floorHour.data, "floor_level", "hour", hours),
      },
      options: baseOptions,
    };

    // InsightEye ThresholdViolationsByCameraChart: above max vs below min.
    const rows = data.violations.data;
    const violations = {
      data: {
        labels: rows.map((row) => row.camera_name),
        datasets: [
          {
            label: "Above max",
            data: rows.map((row) => row.above_max_count),
            backgroundColor: theme.palette.error.main,
            borderRadius: 4,
          },
          {
            label: "Below min",
            data: rows.map((row) => row.below_min_count),
            backgroundColor: theme.palette.warning.main,
            borderRadius: 4,
          },
        ],
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...baseOptions.scales.x, stacked: true },
          y: { ...baseOptions.scales.y, stacked: true, ticks: { ...baseOptions.scales.y.ticks, precision: 0 } },
        },
      },
    };

    return { occupancy, byCamera, busiest, byFloor, floorWeekday, floorHour, violations };
  }, [data, baseOptions, theme]);

  const kpis = data?.summary?.kpis || {};
  const noSamples = data && !kpis.samples;

  return (
    <Box>
      <PageHeader
        title="Analytics"
        subtitle="Footfall and occupancy over time, by camera and by floor. Hours and weekdays are in your timezone."
        actions={[
          <Button key="refresh" onClick={refresh} startIcon={<RefreshIcon />}>
            Refresh
          </Button>,
        ]}
      />

      <CountFilterBar value={filters} onChange={setFilters} />
      <ErrorState error={error} onRetry={refresh} title="Could not load analytics" />

      {loading && !data ? (
        <Loading label="Crunching the numbers…" height={320} />
      ) : !data ? null : noSamples ? (
        <Card>
          <EmptyState
            title="No samples in this range"
            description="Counts are stored while a camera's worker runs. Widen the dates, clear a filter, or load database/seed.sql for demo data."
          />
        </Card>
      ) : (
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
            <StatCard
              label="Average people"
              value={formatNumber(kpis.avg_person_count, 1)}
              hint={`${formatNumber(kpis.samples)} samples from ${kpis.cameras_reporting} camera(s)`}
              icon={<GroupsIcon />}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
            <StatCard
              label="Peak"
              value={formatNumber(kpis.max_person_count)}
              hint={kpis.peak ? `${kpis.peak.camera_name}, ${formatDateTime(kpis.peak.captured_at)}` : "—"}
              icon={<TrendingUpIcon />}
              color="info"
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
            <StatCard
              label="Violations"
              value={formatNumber(kpis.violations)}
              hint={`${formatPct(kpis.violation_rate)} of samples · ${kpis.above_max} above / ${kpis.below_min} below`}
              icon={<WarningIcon />}
              color="warning"
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
            <StatCard
              label="Alerts"
              value={formatNumber(kpis.alerts)}
              hint={`${kpis.open_alerts} open · ${kpis.false_positive_alerts} false positive`}
              icon={<NotificationsIcon />}
              color="error"
            />
          </Grid>

          <Grid size={12}>
            <ChartCard
              title="Occupancy"
              subtitle={`Average and peak count per ${data.summary.window.bucket}, all selected cameras together`}
            >
              <ChartBox height={300}>
                <Line data={charts.occupancy.data} options={charts.occupancy.options} />
              </ChartBox>
            </ChartCard>
          </Grid>

          <Grid size={12}>
            <ChartCard title="People over time, by camera" subtitle={`Average per ${data.series.interval}`}>
              <TrendChart cameras={data.series.data} interval={data.series.interval} height={300} />
            </ChartCard>
          </Grid>

          <Grid size={{ xs: 12, lg: 6 }}>
            <ChartCard title="Average people per camera" subtitle="Busiest first" empty={!data.byCamera.count}>
              <ChartBox>
                <Bar data={charts.byCamera.data} options={charts.byCamera.options} />
              </ChartBox>
            </ChartCard>
          </Grid>
          <Grid size={{ xs: 12, lg: 6 }}>
            <ChartCard
              title="Busiest hour by weekday"
              subtitle="Each day's busiest hour, and its average count"
              empty={!data.busiest.count}
            >
              <ChartBox>
                <Bar data={charts.busiest.data} options={charts.busiest.options} />
              </ChartBox>
            </ChartCard>
          </Grid>

          <Grid size={12}>
            <ChartCard title="When it is busy" subtitle="Average count per weekday and hour">
              <HourHeatmap cells={data.summary.heatmap} />
            </ChartCard>
          </Grid>

          <Grid size={{ xs: 12, lg: 4 }}>
            <ChartCard title="Average people per floor" empty={!data.byFloor.count}>
              <ChartBox>
                <Bar data={charts.byFloor.data} options={charts.byFloor.options} />
              </ChartBox>
            </ChartCard>
          </Grid>
          <Grid size={{ xs: 12, lg: 8 }}>
            <ChartCard title="Floors by weekday" empty={!data.floorWeekday.count}>
              <ChartBox>
                <Bar data={charts.floorWeekday.data} options={charts.floorWeekday.options} />
              </ChartBox>
            </ChartCard>
          </Grid>
          <Grid size={12}>
            <ChartCard title="Floors by hour of day" empty={!data.floorHour.count}>
              <ChartBox>
                <Line data={charts.floorHour.data} options={charts.floorHour.options} />
              </ChartBox>
            </ChartCard>
          </Grid>

          <Grid size={12}>
            <ChartCard
              title="Threshold violations by camera"
              subtitle="Stored samples above the camera's maximum or below its minimum"
            >
              {data.violations.count ? (
                <>
                  <ChartBox height={240}>
                    <Bar data={charts.violations.data} options={charts.violations.options} />
                  </ChartBox>
                  <TableContainer sx={{ mt: 2 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Camera</TableCell>
                          <TableCell align="right">Limits</TableCell>
                          <TableCell align="right">Above max</TableCell>
                          <TableCell align="right">Below min</TableCell>
                          <TableCell align="right">Rate</TableCell>
                          <TableCell align="right">Alerts</TableCell>
                          <TableCell>Last violation</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {data.violations.data.map((row) => {
                          const last = [row.last_above_max_time, row.last_below_min_time]
                            .filter(Boolean)
                            .sort()
                            .pop();
                          return (
                            <TableRow key={row.camera_id} hover>
                              <TableCell>
                                <Link component={RouterLink} to={`/cameras/${row.camera_id}`}>
                                  {row.camera_name}
                                </Link>
                              </TableCell>
                              <TableCell align="right">
                                {limitsText({
                                  count_threshold_less: row.min_threshold,
                                  count_threshold_greater: row.max_threshold,
                                })}
                              </TableCell>
                              <TableCell align="right">{formatNumber(row.above_max_count)}</TableCell>
                              <TableCell align="right">{formatNumber(row.below_min_count)}</TableCell>
                              <TableCell align="right">{formatPct(row.violation_rate)}</TableCell>
                              <TableCell align="right">
                                <Link component={RouterLink} to={`/alerts?camera_id=${row.camera_id}`}>
                                  {formatNumber(row.alerts)}
                                </Link>
                              </TableCell>
                              <TableCell>{last ? formatDateTime(last) : "—"}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
                  No camera with limits broke them in this range.
                </Typography>
              )}
            </ChartCard>
          </Grid>
        </Grid>
      )}
    </Box>
  );
}

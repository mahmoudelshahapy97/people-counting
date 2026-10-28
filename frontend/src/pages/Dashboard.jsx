import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import GroupsIcon from "@mui/icons-material/Groups";
import NotificationsIcon from "@mui/icons-material/NotificationsActive";
import RefreshIcon from "@mui/icons-material/Refresh";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import VideocamIcon from "@mui/icons-material/Videocam";
import WarningIcon from "@mui/icons-material/WarningAmber";

import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import OccupancyCard from "../components/OccupancyCard";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import { AlertStatusChip, ThresholdChip } from "../components/StatusChips";
import { alerts, analytics, counts } from "../api/endpoints";
import { usePolling } from "../hooks/usePolling";
import { POLL_INTERVAL_MS } from "../utils/constants";
import { countParams, presetDates } from "../utils/filters";
import { formatNumber, formatTime, fromNow } from "../utils/format";
import { useTranslation } from "react-i18next";

export default function Dashboard() {
  const { t } = useTranslation();
  // The live counts move every few seconds; that is the point of the page.
  const live = usePolling(({ signal }) => counts.live({ signal }), {
    intervalMs: POLL_INTERVAL_MS,
  });
  const stats = usePolling(({ signal }) => alerts.stats(undefined, { signal }), {
    intervalMs: POLL_INTERVAL_MS * 4,
  });
  const recent = usePolling(({ signal }) => alerts.list({ per_page: 8 }, { signal }), {
    intervalMs: POLL_INTERVAL_MS * 4,
  });
  const today = usePolling(
    ({ signal }) => analytics.summary(countParams(presetDates(1)), { signal }),
    { intervalMs: POLL_INTERVAL_MS * 12 }
  );

  const liveData = live.data?.data;
  const rows = liveData?.cameras || [];
  const alertStats = stats.data?.data || {};
  const kpis = today.data?.data?.kpis || {};

  const refreshAll = () => {
    live.refresh();
    stats.refresh();
    recent.refresh();
    today.refresh();
  };

  return (
    <Box>
      <PageHeader
        title={t("dashboard.dashboard")}
        subtitle={t("dashboard.howManyPeopleEachCamera")}
        actions={[
          <Button key="refresh" onClick={refreshAll} startIcon={<RefreshIcon />}>
            {t("dashboard.refresh")}
          </Button>,
        ]}
      />

      <ErrorState error={live.error} onRetry={live.refresh} title={t("dashboard.couldNotLoadTheLive")} />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("dashboard.peopleNow")}
            value={formatNumber(liveData?.occupancy ?? 0)}
            hint={t("dashboard.acrossV0LiveCameraS", { v0: liveData?.cameras_live ?? 0 })}
            icon={<GroupsIcon />}
            color="primary"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("dashboard.outOfLimits")}
            value={formatNumber(liveData?.cameras_in_violation ?? 0)}
            hint={t("dashboard.camerasAboveTheirMaxOr")}
            icon={<WarningIcon />}
            color={liveData?.cameras_in_violation ? "error" : "success"}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("dashboard.todaySPeak")}
            value={formatNumber(kpis.max_person_count ?? 0)}
            hint={
              kpis.peak
                ? t("dashboard.cameraNameAtV1", { camera_name: kpis.peak.camera_name, v1: formatTime(kpis.peak.captured_at) })
                : t("dashboard.noSamplesTodayYet")
            }
            icon={<TrendingUpIcon />}
            color="info"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("dashboard.openAlerts")}
            value={formatNumber(alertStats.open ?? 0)}
            hint={
              alertStats.last_alert_at
                ? t("dashboard.v0In24hLatestV1", { v0: formatNumber(alertStats.last_24h ?? 0), v1: fromNow(alertStats.last_alert_at) })
                : t("dashboard.nothingYet")
            }
            icon={<NotificationsIcon />}
            color="warning"
          />
        </Grid>

        <Grid size={12}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              {t("dashboard.liveOccupancy")}
            </Typography>
            <Link component={RouterLink} to="/cameras" variant="body2">
              {t("dashboard.manageCameras")}
            </Link>
          </Stack>
        </Grid>

        {live.loading && !live.data ? (
          <Grid size={12}>
            <Loading label={t("dashboard.loadingCameras")} height={140} />
          </Grid>
        ) : rows.length ? (
          rows.map((row) => (
            <Grid key={row.camera_id} size={{ xs: 12, sm: 6, md: 4, xl: 3 }}>
              <OccupancyCard row={row} />
            </Grid>
          ))
        ) : (
          <Grid size={12}>
            <Card>
              <EmptyState
                title={t("dashboard.noCameras")}
                description={t("dashboard.registerAnRtspSourceAnd")}
                icon={<VideocamIcon fontSize="inherit" />}
                action={
                  <Button component={RouterLink} to="/cameras/new" variant="contained" size="small">
                    {t("dashboard.addACamera")}
                  </Button>
                }
              />
            </Card>
          </Grid>
        )}

        <Grid size={12}>
          <Card>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ px: 2.5, py: 2 }}
            >
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t("dashboard.recentAlerts")}
              </Typography>
              <Link component={RouterLink} to="/alerts" variant="body2">
                {t("dashboard.viewAll")}
              </Link>
            </Stack>
            <Divider />

            {recent.error ? (
              <Box sx={{ p: 2 }}>
                <ErrorState error={recent.error} onRetry={recent.refresh} />
              </Box>
            ) : recent.loading && !recent.data ? (
              <Loading label={t("dashboard.loadingAlerts")} />
            ) : recent.data?.alerts?.length ? (
              <List disablePadding>
                {recent.data.alerts.map((alert) => (
                  <ListItemButton
                    key={alert.alert_id}
                    component={RouterLink}
                    to={`/alerts/${alert.alert_id}`}
                    divider
                  >
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {alert.person_count} {alert.person_count === 1 ? t("dashboard.person") : t("dashboard.people")}
                          </Typography>
                          <ThresholdChip type={alert.threshold_type} value={alert.threshold_value} />
                          <AlertStatusChip status={alert.status} />
                        </Stack>
                      }
                      secondary={`${alert.camera_name || t("dashboard.unknownCamera")} · ${fromNow(alert.triggered_at)}`}
                    />
                  </ListItemButton>
                ))}
              </List>
            ) : (
              <EmptyState
                title={t("dashboard.noAlertsYet")}
                description={t("dashboard.anAlertIsRaisedWhen")}
              />
            )}
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}

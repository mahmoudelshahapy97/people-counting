import { AppShell, NotificationBell, NotificationsProvider, usePolling } from "@insighteye/ui";
import { useTranslation } from "react-i18next";
import DashboardIcon from "@mui/icons-material/SpaceDashboard";
import VideocamIcon from "@mui/icons-material/Videocam";
import GridViewIcon from "@mui/icons-material/GridView";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import NotificationsIcon from "@mui/icons-material/Notifications";
import InsightsIcon from "@mui/icons-material/Insights";
import TimelineIcon from "@mui/icons-material/Timeline";
import TuneIcon from "@mui/icons-material/Tune";
import GroupIcon from "@mui/icons-material/Group";
import WorkspacesIcon from "@mui/icons-material/Workspaces";
import HistoryIcon from "@mui/icons-material/History";
import GroupsIcon from "@mui/icons-material/Groups";

import { alerts } from "../api/endpoints";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { POLL_INTERVAL_MS } from "../utils/constants";

/** The active workspace's open threshold alerts, for the Alerts menu entry. */
function useOpenAlerts(workspaceId) {
  // Tagged with the workspace it was asked for: right after a switch the
  // previous workspace's answer is still held and must not show.
  const stats = usePolling(
    ({ signal }) => alerts.stats(undefined, { signal }).then((body) => ({ ...body.data, workspaceId })),
    { intervalMs: POLL_INTERVAL_MS * 2, enabled: Boolean(workspaceId), deps: [workspaceId] }
  );
  const current = stats.data && stats.data.workspaceId === workspaceId ? stats.data : null;
  return current?.open ?? 0;
}

/**
 * Watch the cameras and their thresholds, then read the numbers back.
 * `perm` is the role floor the API enforces for the same action.
 */
export function AppLayout() {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const openAlerts = useOpenAlerts(workspace.active?.workspace_id);

  const navSections = [
    {
      heading: t("shell.monitor"),
      items: [
        { to: "/", label: t("nav.dashboard"), icon: <DashboardIcon />, end: true, perm: "viewer" },
        { to: "/cameras", label: t("nav.cameras"), icon: <VideocamIcon />, perm: "viewer" },
        { to: "/live", label: t("nav.liveWall"), icon: <GridViewIcon />, perm: "viewer" },
        { to: "/alerts", label: t("nav.alerts"), icon: <NotificationsActiveIcon />, perm: "viewer", badge: "openAlerts" },
        { to: "/notifications", label: t("nav.notifications"), icon: <NotificationsIcon />, perm: "viewer" },
      ],
    },
    {
      heading: t("shell.reports"),
      items: [
        { to: "/analytics", label: t("nav.analytics"), icon: <InsightsIcon />, perm: "viewer" },
        { to: "/history", label: t("layout.countHistory"), icon: <TimelineIcon />, perm: "viewer" },
      ],
    },
    {
      heading: t("shell.system"),
      items: [
        { to: "/system", label: t("nav.system"), icon: <TuneIcon />, perm: "viewer" },
        { to: "/workspaces", label: t("nav.workspaces"), icon: <WorkspacesIcon />, perm: "admin" },
        { to: "/users", label: t("nav.users"), icon: <GroupIcon />, perm: "admin" },
        { to: "/audit", label: t("nav.audit"), icon: <HistoryIcon />, perm: "admin" },
      ],
    },
  ];

  return (
    <NotificationsProvider>
      <AppShell
        product={{ brand: "InsightEye", tagline: t("product.tagline"), icon: <GroupsIcon /> }}
        navSections={navSections}
        badges={{ openAlerts }}
        topBarExtras={<NotificationBell />}
      />
    </NotificationsProvider>
  );
}

export default AppLayout;

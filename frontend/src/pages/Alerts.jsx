import { Link as RouterLink, useSearchParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import NotificationsIcon from "@mui/icons-material/NotificationsActive";
import RefreshIcon from "@mui/icons-material/Refresh";

import PageHeader from "../components/PageHeader";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import { AlertStatusChip, ThresholdChip } from "../components/StatusChips";
import { alerts as alertApi, cameras as cameraApi } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import {
  ALERT_STATUSES,
  PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  THRESHOLD_LABEL,
} from "../utils/constants";
import { formatDateTime, fromNow, titleCase } from "../utils/format";

/**
 * Filters live in the query string rather than in component state, so a
 * filtered view is a real URL: it survives a reload, works with back/forward,
 * and can be linked to from the dashboard and from a camera's detail page.
 */
export default function Alerts() {
  const [params, setParams] = useSearchParams();

  const status = params.get("status") || "";
  const thresholdType = params.get("threshold_type") || "";
  const cameraId = params.get("camera_id") || "";
  const page = Math.max(1, Number(params.get("page") || 1));
  const perPage = Number(params.get("per_page") || PAGE_SIZE);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the current offset.
    if (key !== "page") next.delete("page");
    setParams(next);
  };

  const { data, error, loading, refresh } = useAsync(
    ({ signal }) =>
      alertApi.list(
        {
          ...(status && { status }),
          ...(thresholdType && { threshold_type: thresholdType }),
          ...(cameraId && { camera_id: cameraId }),
          page,
          per_page: perPage,
        },
        { signal }
      ),
    [status, thresholdType, cameraId, page, perPage]
  );

  const cameraList = useAsync(({ signal }) => cameraApi.list(undefined, { signal }), []);

  const rows = data?.alerts || [];
  const hasFilters = Boolean(status || thresholdType || cameraId);

  return (
    <Box>
      <PageHeader
        title="Alerts"
        subtitle="Every time a camera's count went outside its limits and was raised to operators, newest first."
        actions={[
          <Button key="refresh" onClick={refresh} startIcon={<RefreshIcon />}>
            Refresh
          </Button>,
        ]}
      />

      <Card sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <TextField
            select
            label="Status"
            size="small"
            value={status}
            onChange={(event) => setParam("status", event.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">All statuses</MenuItem>
            {ALERT_STATUSES.map((value) => (
              <MenuItem key={value} value={value}>
                {titleCase(value)}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="Limit"
            size="small"
            value={thresholdType}
            onChange={(event) => setParam("threshold_type", event.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">Either limit</MenuItem>
            {Object.entries(THRESHOLD_LABEL).map(([value, label]) => (
              <MenuItem key={value} value={value}>
                {label}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="Camera"
            size="small"
            value={cameraId}
            onChange={(event) => setParam("camera_id", event.target.value)}
            sx={{ minWidth: 220 }}
          >
            <MenuItem value="">All cameras</MenuItem>
            {(cameraList.data || []).map((camera) => (
              <MenuItem key={camera.camera_id} value={camera.camera_id}>
                {camera.name}
              </MenuItem>
            ))}
          </TextField>

          <Box sx={{ flex: 1 }} />
          {hasFilters ? (
            <Button onClick={() => setParams(new URLSearchParams())}>Clear filters</Button>
          ) : null}
        </Stack>
      </Card>

      <ErrorState error={error} onRetry={refresh} />

      {loading && !data ? (
        <Loading label="Loading alerts…" />
      ) : rows.length ? (
        <Card>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell align="right">People</TableCell>
                  <TableCell>Limit</TableCell>
                  <TableCell>Camera</TableCell>
                  <TableCell>Triggered</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((alert) => (
                  <TableRow key={alert.alert_id} hover>
                    <TableCell align="right">
                      <Link
                        component={RouterLink}
                        to={`/alerts/${alert.alert_id}`}
                        underline="hover"
                        sx={{ fontWeight: 700 }}
                      >
                        {alert.person_count}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <ThresholdChip type={alert.threshold_type} value={alert.threshold_value} />
                    </TableCell>
                    <TableCell>
                      {alert.camera_id ? (
                        <Link
                          component={RouterLink}
                          to={`/cameras/${alert.camera_id}`}
                          underline="hover"
                          color="text.secondary"
                          variant="body2"
                        >
                          {alert.camera_name || "Unnamed"}
                        </Link>
                      ) : (
                        <Typography variant="body2" color="text.disabled">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Tooltip title={formatDateTime(alert.triggered_at)}>
                        <Typography variant="body2" color="text.secondary">
                          {fromNow(alert.triggered_at)}
                        </Typography>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <AlertStatusChip status={alert.status} />
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" component={RouterLink} to={`/alerts/${alert.alert_id}`}>
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          <TablePagination
            component="div"
            count={data?.total ?? 0}
            page={page - 1}
            rowsPerPage={perPage}
            rowsPerPageOptions={PAGE_SIZE_OPTIONS}
            onPageChange={(_, nextPage) => setParam("page", String(nextPage + 1))}
            onRowsPerPageChange={(event) => setParam("per_page", event.target.value)}
          />
        </Card>
      ) : (
        <Card>
          <EmptyState
            title={hasFilters ? "Nothing matches these filters" : "No alerts yet"}
            description={
              hasFilters
                ? "Try widening the status, limit or camera filter."
                : "Alerts appear here when a camera's count goes above its maximum or below its minimum."
            }
            icon={<NotificationsIcon fontSize="inherit" />}
            action={
              hasFilters ? (
                <Button variant="outlined" onClick={() => setParams(new URLSearchParams())}>
                  Clear filters
                </Button>
              ) : (
                <Button variant="outlined" component={RouterLink} to="/cameras">
                  Check cameras
                </Button>
              )
            }
          />
        </Card>
      )}
    </Box>
  );
}

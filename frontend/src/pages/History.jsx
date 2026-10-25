import { useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";

import DownloadIcon from "@mui/icons-material/Download";
import RefreshIcon from "@mui/icons-material/Refresh";
import ShowChartIcon from "@mui/icons-material/ShowChart";
import TableRowsIcon from "@mui/icons-material/TableRows";
import TimelineIcon from "@mui/icons-material/Timeline";

import CountFilterBar from "../components/CountFilterBar";
import PageHeader from "../components/PageHeader";
import TrendChart from "../components/TrendChart";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import { ThresholdChip } from "../components/StatusChips";
import { useToast } from "../components/Toast";
import { errorMessage } from "../api/client";
import { analytics, counts } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import { PAGE_SIZE_OPTIONS } from "../utils/constants";
import { EMPTY_FILTERS, countParams, locationText } from "../utils/filters";
import { formatDateTime } from "../utils/format";

/**
 * Every stored sample, filterable and exportable: InsightEye's Frames Search,
 * with its table and its "person count over time" chart. A sample has no
 * picture (alerts keep theirs), so there is no card view.
 */
export default function History() {
  const toast = useToast();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [view, setView] = useState("table");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [exporting, setExporting] = useState(false);

  const query = useMemo(() => countParams(filters), [filters]);
  const key = query.toString();

  const history = useAsync(
    ({ signal }) => {
      const params = new URLSearchParams(query);
      params.set("page", page);
      params.set("per_page", perPage);
      return counts.history(params, { signal });
    },
    [key, page, perPage],
    { enabled: view === "table" }
  );
  const series = useAsync(({ signal }) => analytics.timeseries(query, { signal }), [key], {
    enabled: view === "chart",
  });

  const changeFilters = (next) => {
    setFilters(next);
    setPage(1);
  };

  const download = async () => {
    setExporting(true);
    try {
      const blob = await counts.exportCsv(query);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `people-counts-${filters.start_date}-${filters.end_date}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const rows = history.data?.samples || [];
  const active = view === "table" ? history : series;

  return (
    <Box>
      <PageHeader
        title="Count history"
        subtitle="Every stored sample: one per camera every few seconds, each checked against the camera's limits."
        actions={[
          <ToggleButtonGroup
            key="view"
            size="small"
            exclusive
            value={view}
            onChange={(_, next) => next && setView(next)}
          >
            <ToggleButton value="table" aria-label="Table">
              <TableRowsIcon fontSize="small" />
            </ToggleButton>
            <ToggleButton value="chart" aria-label="Chart">
              <ShowChartIcon fontSize="small" />
            </ToggleButton>
          </ToggleButtonGroup>,
          <Button key="export" startIcon={<DownloadIcon />} onClick={download} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>,
          <Button key="refresh" onClick={active.refresh} startIcon={<RefreshIcon />}>
            Refresh
          </Button>,
        ]}
      />

      <CountFilterBar value={filters} onChange={changeFilters} />

      <ErrorState error={active.error} onRetry={active.refresh} />

      {view === "chart" ? (
        <Card sx={{ p: 2 }}>
          {series.loading && !series.data ? (
            <Loading label="Loading the chart…" />
          ) : series.data?.data?.length ? (
            <>
              <Typography variant="subtitle2">People over time</Typography>
              <Typography variant="caption" color="text.secondary">
                Average per {series.data.interval}, one line per camera.
              </Typography>
              <TrendChart cameras={series.data.data} interval={series.data.interval} height={380} />
            </>
          ) : (
            <EmptyState title="No samples in this range" description="Widen the dates or clear a filter." />
          )}
        </Card>
      ) : history.loading && !history.data ? (
        <Loading label="Loading samples…" />
      ) : rows.length ? (
        <Card>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Time</TableCell>
                  <TableCell>Camera</TableCell>
                  <TableCell>Location</TableCell>
                  <TableCell align="right">People</TableCell>
                  <TableCell>Limit</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((sample) => (
                  <TableRow key={sample.sample_id} hover>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {formatDateTime(sample.captured_at)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Link component={RouterLink} to={`/cameras/${sample.camera_id}`} underline="hover">
                        {sample.camera_name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {locationText(sample) || "—"}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography
                        variant="body2"
                        sx={{ fontWeight: 700 }}
                        color={sample.violation ? "error.main" : "text.primary"}
                      >
                        {sample.person_count}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <ThresholdChip type={sample.violation} value={sample.threshold_value} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={history.data?.total ?? 0}
            page={page - 1}
            rowsPerPage={perPage}
            rowsPerPageOptions={[...PAGE_SIZE_OPTIONS, 200]}
            onPageChange={(_, next) => setPage(next + 1)}
            onRowsPerPageChange={(event) => {
              setPerPage(Number(event.target.value));
              setPage(1);
            }}
          />
        </Card>
      ) : (
        <Card>
          <EmptyState
            title="No samples in this range"
            description="Samples are stored while a camera's worker runs. Widen the dates or clear a filter."
            icon={<TimelineIcon fontSize="inherit" />}
          />
        </Card>
      )}
    </Box>
  );
}

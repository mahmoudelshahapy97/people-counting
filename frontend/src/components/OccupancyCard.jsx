import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { ThresholdChip } from "./StatusChips";
import { fromNow } from "../utils/format";
import { locationText, limitsText } from "../utils/filters";
import { useTranslation } from "react-i18next";

/**
 * One camera's head count against its limits, as the dashboard shows it.
 * `row` is an entry of GET /counts/live.
 */
export function OccupancyCard({ row }) {
  const { t } = useTranslation();
  const max = row.count_threshold_greater;
  const count = row.person_count;
  const known = count !== null && count !== undefined;
  // Fill toward the maximum; with no maximum the bar has nothing to measure.
  const fill = max ? Math.min(100, ((count || 0) / Math.max(max, 1)) * 100) : null;
  const color = row.violation ? (row.violation === "greater_than" ? "error" : "warning") : "success";

  return (
    <Card
      sx={{
        height: "100%",
        borderLeft: 4,
        borderColor: row.violation ? `${color}.main` : "divider",
      }}
    >
      <CardActionArea component={RouterLink} to={`/cameras/${row.camera_id}`} sx={{ height: "100%" }}>
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>
                {row.camera_name}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {locationText(row) || t("occupancyCard.noLocationSet")}
              </Typography>
            </Box>
            {row.live ? (
              <Chip size="small" color="success" variant="outlined" label={t("occupancyCard.live")} />
            ) : (
              <Tooltip title={row.at ? t("occupancyCard.lastStoredSampleV0", { v0: fromNow(row.at) }) : t("occupancyCard.noRecentSample")}>
                <Chip size="small" variant="outlined" label={row.enabled ? row.state : t("occupancyCard.stopped")} />
              </Tooltip>
            )}
          </Stack>

          <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mt: 1.5 }}>
            <Typography variant="h3" sx={{ fontWeight: 800 }} color={row.violation ? `${color}.main` : "text.primary"}>
              {known ? count : "—"}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {count === 1 ? t("occupancyCard.person") : t("occupancyCard.people")}
            </Typography>
          </Stack>

          {fill !== null && (
            <LinearProgress
              variant="determinate"
              value={fill}
              color={color}
              sx={{ mt: 1, height: 6, borderRadius: 3 }}
            />
          )}

          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5, minHeight: 24 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
              {limitsText(row)}
            </Typography>
            <ThresholdChip
              type={row.violation}
              value={row.violation === "greater_than" ? max : row.count_threshold_less}
            />
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default OccupancyCard;

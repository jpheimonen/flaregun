/**
 * Service dashboard view.
 *
 * Displays all services (local + Pages) with their status, uptime,
 * restart count, and action buttons.
 */

import { useCallback } from "react";
import Box from "@mui/material/Box";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Paper from "@mui/material/Paper";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import StopIcon from "@mui/icons-material/Stop";
import CloudIcon from "@mui/icons-material/Cloud";
import TerminalIcon from "@mui/icons-material/Terminal";
import { useServiceStore } from "../stores/useServiceStore";
import { useConfigStore } from "../stores/useConfigStore";
import { formatUptime } from "../utils/formatDuration";
import type { ServiceInfo, LocalServiceInfo, ServiceState } from "../types";

/** Status color + label mapping for local service states */
const STATE_CONFIG: Record<
  ServiceState,
  { color: "success" | "error" | "warning" | "default" | "info"; label: string }
> = {
  running: { color: "success", label: "Running" },
  crashed: { color: "error", label: "Crashed" },
  restarting: { color: "warning", label: "Restarting" },
  stopped: { color: "default", label: "Stopped" },
  starting: { color: "info", label: "Starting" },
};

function isLocalService(service: ServiceInfo): service is LocalServiceInfo {
  return service.type === "local";
}

export function ServiceDashboard() {
  const services = useServiceStore((s) => s.services);
  const loaded = useServiceStore((s) => s.loaded);
  const pendingActions = useServiceStore((s) => s.pendingActions);
  const restartService = useServiceStore((s) => s.restartService);
  const stopService = useServiceStore((s) => s.stopService);
  const domain = useConfigStore((s) => s.domain);

  const handleRestart = useCallback(
    (name: string) => {
      restartService(name);
    },
    [restartService],
  );

  const handleStop = useCallback(
    (name: string) => {
      stopService(name);
    },
    [stopService],
  );

  if (!loaded) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        minHeight={200}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (services.length === 0) {
    return (
      <Box p={3}>
        <Typography variant="body1" color="text.secondary">
          No services configured.
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom sx={{ mb: 2 }}>
        Services
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Service</TableCell>
              <TableCell>Subdomain</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Uptime</TableCell>
              <TableCell>Restarts</TableCell>
              <TableCell>Details</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {services.map((service) => (
              <ServiceRow
                key={service.name}
                service={service}
                domain={domain}
                isPending={pendingActions.has(service.name)}
                onRestart={handleRestart}
                onStop={handleStop}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

interface ServiceRowProps {
  service: ServiceInfo;
  domain: string | null;
  isPending: boolean;
  onRestart: (name: string) => void;
  onStop: (name: string) => void;
}

function ServiceRow({
  service,
  domain,
  isPending,
  onRestart,
  onStop,
}: ServiceRowProps) {
  const local = isLocalService(service);

  // Build subdomain URL
  const subdomain = local
    ? domain
      ? `${service.name}.${domain}`
      : service.name
    : service.subdomain;

  // Status chip
  const statusChip = local ? (
    <Chip
      label={STATE_CONFIG[service.state].label}
      color={STATE_CONFIG[service.state].color}
      size="small"
      data-testid={`status-${service.name}`}
    />
  ) : (
    <Chip
      label={service.deployed ? "Deployed" : "Not Deployed"}
      color={service.deployed ? "success" : "default"}
      size="small"
      data-testid={`status-${service.name}`}
    />
  );

  // Uptime
  const uptime =
    local && service.state === "running" && service.runningSince
      ? formatUptime(service.runningSince)
      : "—";

  // Restart count
  const restartCount = local ? service.restartCount : "—";

  // Details (crash reason for local services)
  const details =
    local && service.lastCrashReason ? (
      <Typography
        variant="caption"
        color="error"
        data-testid={`crash-reason-${service.name}`}
      >
        {service.lastCrashReason}
      </Typography>
    ) : (
      "—"
    );

  // Type indicator
  const typeChip = local ? (
    <Chip
      icon={<TerminalIcon />}
      label="Local"
      size="small"
      variant="outlined"
      data-testid={`type-${service.name}`}
    />
  ) : (
    <Chip
      icon={<CloudIcon />}
      label="Pages"
      size="small"
      variant="outlined"
      data-testid={`type-${service.name}`}
    />
  );

  // Action buttons — only for local services
  const actions = local ? (
    <Box display="flex" gap={0.5} justifyContent="flex-end">
      {isPending ? (
        <CircularProgress size={24} data-testid={`loading-${service.name}`} />
      ) : (
        <>
          <Tooltip title="Restart">
            <span>
              <IconButton
                size="small"
                color="primary"
                onClick={() => onRestart(service.name)}
                disabled={service.state === "restarting"}
                aria-label={`Restart ${service.name}`}
                data-testid={`restart-${service.name}`}
              >
                <RestartAltIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Stop">
            <span>
              <IconButton
                size="small"
                color="error"
                onClick={() => onStop(service.name)}
                disabled={
                  service.state === "stopped" ||
                  service.state === "restarting"
                }
                aria-label={`Stop ${service.name}`}
                data-testid={`stop-${service.name}`}
              >
                <StopIcon />
              </IconButton>
            </span>
          </Tooltip>
        </>
      )}
    </Box>
  ) : null;

  return (
    <TableRow data-testid={`service-row-${service.name}`}>
      <TableCell>
        <Typography variant="body2" fontWeight="bold">
          {service.name}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography variant="body2" color="text.secondary">
          {subdomain}
        </Typography>
      </TableCell>
      <TableCell>{typeChip}</TableCell>
      <TableCell>{statusChip}</TableCell>
      <TableCell data-testid={`uptime-${service.name}`}>{uptime}</TableCell>
      <TableCell data-testid={`restarts-${service.name}`}>
        {restartCount}
      </TableCell>
      <TableCell>{details}</TableCell>
      <TableCell align="right">{actions}</TableCell>
    </TableRow>
  );
}

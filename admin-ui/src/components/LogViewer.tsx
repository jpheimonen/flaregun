/**
 * Real-time log viewer with WebSocket streaming, per-service filtering,
 * and auto-scroll with pause mechanism.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Chip from "@mui/material/Chip";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import { useLogStore, COMBINED_SERVICE } from "../stores/useLogStore";
import { useServiceStore } from "../stores/useServiceStore";
import type { LogEntry } from "../types";
import type { SelectChangeEvent } from "@mui/material/Select";

/**
 * Format an ISO timestamp to a concise HH:MM:SS.mmm format.
 */
function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${h}:${m}:${s}.${ms}`;
  } catch {
    return iso;
  }
}

/**
 * Get a color for stderr vs stdout lines.
 */
function getSourceColor(source: "stdout" | "stderr"): string {
  return source === "stderr" ? "#ff6b6b" : "inherit";
}

export function LogViewer() {
  const connectionStatus = useLogStore((s) => s.connectionStatus);
  const selectedService = useLogStore((s) => s.selectedService);
  const entries = useLogStore((s) => s.entries);
  const availableServices = useLogStore((s) => s.availableServices);
  const connect = useLogStore((s) => s.connect);
  const disconnect = useLogStore((s) => s.disconnect);
  const selectService = useLogStore((s) => s.selectService);
  const setAvailableServices = useLogStore((s) => s.setAvailableServices);

  const services = useServiceStore((s) => s.services);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [hasNewEntries, setHasNewEntries] = useState(false);
  const prevEntriesLenRef = useRef(0);

  // Update available services when service store changes
  useEffect(() => {
    const localServices = services
      .filter((s) => s.type === "local")
      .map((s) => s.name);
    setAvailableServices(localServices);
  }, [services, setAvailableServices]);

  // Connect WebSocket on mount, disconnect on unmount
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // Auto-select combined stream if nothing is selected and services are available
  useEffect(() => {
    if (!selectedService && availableServices.length > 0) {
      selectService(COMBINED_SERVICE);
    }
  }, [selectedService, availableServices, selectService]);

  // Auto-scroll logic
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
    // Show "new entries" indicator when not auto-scrolling
    if (!autoScroll && entries.length > prevEntriesLenRef.current) {
      setHasNewEntries(true);
    }
    prevEntriesLenRef.current = entries.length;
  }, [entries, autoScroll]);

  // Handle scroll events to detect user scroll-up
  const handleScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    if (atBottom) {
      setAutoScroll(true);
      setHasNewEntries(false);
    } else {
      setAutoScroll(false);
    }
  }, []);

  // Scroll to bottom when clicking "new logs" button
  const scrollToBottom = useCallback(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
    setAutoScroll(true);
    setHasNewEntries(false);
  }, []);

  const handleServiceChange = (event: SelectChangeEvent) => {
    const value = event.target.value;
    selectService(value);
    setAutoScroll(true);
    setHasNewEntries(false);
  };

  const isCombined = selectedService === COMBINED_SERVICE;

  const connectionColor =
    connectionStatus === "connected"
      ? "success"
      : connectionStatus === "reconnecting"
        ? "warning"
        : "error";

  const connectionLabel =
    connectionStatus === "connected"
      ? "Connected"
      : connectionStatus === "reconnecting"
        ? "Reconnecting…"
        : "Disconnected";

  return (
    <Box data-testid="log-viewer">
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Typography variant="h5">Log Viewer</Typography>
          <Chip
            label={connectionLabel}
            color={connectionColor}
            size="small"
            variant="outlined"
            data-testid="connection-status"
          />
        </Box>

        {/* Service selector */}
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="service-select-label">Service</InputLabel>
          <Select
            labelId="service-select-label"
            value={selectedService || ""}
            label="Service"
            onChange={handleServiceChange}
            data-testid="service-selector"
          >
            <MenuItem value={COMBINED_SERVICE} data-testid="service-option-combined">
              All Services
            </MenuItem>
            {availableServices.map((name) => (
              <MenuItem key={name} value={name} data-testid={`service-option-${name}`}>
                {name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* Connection warning */}
      {connectionStatus === "disconnected" && (
        <Typography
          variant="body2"
          color="error"
          sx={{ mb: 1 }}
          data-testid="disconnected-message"
        >
          Log streaming is temporarily unavailable. Attempting to reconnect…
        </Typography>
      )}

      {/* Log output area */}
      <Paper
        variant="outlined"
        sx={{ position: "relative" }}
      >
        <Box
          ref={logContainerRef}
          onScroll={handleScroll}
          data-testid="log-output"
          sx={{
            height: 500,
            overflow: "auto",
            fontFamily: "monospace",
            fontSize: "0.8rem",
            lineHeight: 1.5,
            p: 1,
          }}
        >
          {entries.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ p: 2, textAlign: "center" }}
              data-testid="empty-state"
            >
              {selectedService
                ? "No log entries yet. Waiting for output…"
                : "Select a service to view logs."}
            </Typography>
          ) : (
            entries.map((entry: LogEntry, i: number) => (
              <LogLine key={i} entry={entry} showService={isCombined} />
            ))
          )}
        </Box>

        {/* New logs indicator */}
        {hasNewEntries && !autoScroll && (
          <Button
            variant="contained"
            size="small"
            startIcon={<ArrowDownwardIcon />}
            onClick={scrollToBottom}
            data-testid="new-logs-indicator"
            sx={{
              position: "absolute",
              bottom: 16,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 1,
            }}
          >
            New logs ↓
          </Button>
        )}
      </Paper>
    </Box>
  );
}

/** A single log line */
function LogLine({ entry, showService }: { entry: LogEntry; showService: boolean }) {
  return (
    <Box
      data-testid="log-entry"
      sx={{
        display: "flex",
        gap: 1,
        px: 1,
        py: 0.125,
        color: getSourceColor(entry.source),
        "&:hover": { backgroundColor: "action.hover" },
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      <Box
        component="span"
        data-testid="log-timestamp"
        sx={{ color: "text.secondary", flexShrink: 0 }}
      >
        {formatTimestamp(entry.timestamp)}
      </Box>
      {showService && (
        <Box
          component="span"
          data-testid="log-service"
          sx={{ color: "info.main", flexShrink: 0, minWidth: 80 }}
        >
          [{entry.service}]
        </Box>
      )}
      <Box
        component="span"
        data-testid="log-source"
        sx={{
          flexShrink: 0,
          minWidth: 50,
          color: entry.source === "stderr" ? "#ff6b6b" : "text.secondary",
        }}
      >
        {entry.source}
      </Box>
      <Box component="span" data-testid="log-content" sx={{ flex: 1 }}>
        {entry.line}
      </Box>
    </Box>
  );
}

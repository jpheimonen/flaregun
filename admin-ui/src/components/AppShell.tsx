/**
 * Application shell with navigation and persistent header.
 *
 * Provides a layout with:
 * - Top app bar with domain name and tunnel connection status
 * - Side navigation tabs for switching between views
 * - Content area for the active view
 */

import { useEffect } from "react";
import Box from "@mui/material/Box";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import DashboardIcon from "@mui/icons-material/Dashboard";
import EditNoteIcon from "@mui/icons-material/EditNote";
import SubjectIcon from "@mui/icons-material/Subject";
import { useLocation, useNavigate, Outlet } from "react-router-dom";
import { TunnelStatus } from "./TunnelStatus";
import { useConfigStore } from "../stores/useConfigStore";
import { useServiceStore } from "../stores/useServiceStore";

/** Map routes to tab indices */
const ROUTE_TAB_MAP: Record<string, number> = {
  "/": 0,
  "/config": 1,
  "/logs": 2,
};

const TAB_ROUTE_MAP: Record<number, string> = {
  0: "/",
  1: "/config",
  2: "/logs",
};

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const domain = useConfigStore((s) => s.domain);
  const fetchConfig = useConfigStore((s) => s.fetchConfig);
  const startPolling = useServiceStore((s) => s.startPolling);
  const stopPolling = useServiceStore((s) => s.stopPolling);

  // Fetch config on mount (for domain name)
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Start polling services on mount, stop on unmount
  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const currentTab = ROUTE_TAB_MAP[location.pathname] ?? 0;

  const handleTabChange = (_: React.SyntheticEvent, newValue: number) => {
    const route = TAB_ROUTE_MAP[newValue];
    if (route) {
      navigate(route);
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Top App Bar */}
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar>
          <Typography
            variant="h6"
            component="div"
            sx={{ flexGrow: 1, fontWeight: "bold" }}
          >
            Flaregun
            {domain && (
              <Typography
                component="span"
                variant="h6"
                color="text.secondary"
                sx={{ ml: 1, fontWeight: "normal" }}
                data-testid="domain-display"
              >
                {domain}
              </Typography>
            )}
          </Typography>
          <TunnelStatus />
        </Toolbar>
      </AppBar>

      {/* Navigation Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Tabs
          value={currentTab}
          onChange={handleTabChange}
          aria-label="admin navigation"
        >
          <Tab
            icon={<DashboardIcon />}
            iconPosition="start"
            label="Dashboard"
            data-testid="nav-dashboard"
          />
          <Tab
            icon={<EditNoteIcon />}
            iconPosition="start"
            label="Config"
            data-testid="nav-config"
          />
          <Tab
            icon={<SubjectIcon />}
            iconPosition="start"
            label="Logs"
            data-testid="nav-logs"
          />
        </Tabs>
      </Box>

      {/* Content Area */}
      <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
        <Outlet />
      </Box>
    </Box>
  );
}

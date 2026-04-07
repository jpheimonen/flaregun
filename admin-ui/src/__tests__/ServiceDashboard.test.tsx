/**
 * Tests for the ServiceDashboard component.
 *
 * Verifies rendering of services, status indicators, action buttons,
 * and interaction behaviors.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { MemoryRouter } from "react-router-dom";
import { ServiceDashboard } from "../components/ServiceDashboard";
import { useServiceStore } from "../stores/useServiceStore";
import { useConfigStore } from "../stores/useConfigStore";
import type { ServiceInfo } from "../types";

// Mock the API client to prevent real network calls
vi.mock("../api/client", () => ({
  fetchServices: vi.fn().mockResolvedValue({ success: true, services: [] }),
  restartService: vi.fn().mockResolvedValue({ success: true }),
  stopService: vi.fn().mockResolvedValue({ success: true }),
  fetchConfig: vi.fn().mockResolvedValue({ success: true, content: "domain: example.com" }),
}));

const theme = createTheme({ palette: { mode: "dark" } });

function renderDashboard() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ServiceDashboard />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const allServices: ServiceInfo[] = [
  {
    name: "api",
    type: "local",
    state: "running",
    runningSince: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    restartCount: 2,
    lastCrashReason: null,
  },
  {
    name: "worker",
    type: "local",
    state: "crashed",
    runningSince: null,
    restartCount: 5,
    lastCrashReason: "exit code 1",
  },
  {
    name: "scheduler",
    type: "local",
    state: "stopped",
    runningSince: null,
    restartCount: 0,
    lastCrashReason: null,
  },
  {
    name: "watcher",
    type: "local",
    state: "restarting",
    runningSince: null,
    restartCount: 3,
    lastCrashReason: "SIGTERM",
  },
  {
    name: "starter",
    type: "local",
    state: "starting",
    runningSince: null,
    restartCount: 0,
    lastCrashReason: null,
  },
  {
    name: "blog",
    type: "pages",
    subdomain: "blog.example.com",
    deployed: true,
  },
  {
    name: "docs",
    type: "pages",
    subdomain: "docs.example.com",
    deployed: false,
  },
];

describe("ServiceDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store states
    useServiceStore.setState({
      services: allServices,
      loaded: true,
      connected: true,
      pendingActions: new Set(),
      _pollInterval: null,
    });
    useConfigStore.setState({
      domain: "example.com",
      rawContent: "domain: example.com",
      loaded: true,
    });
  });

  it("renders all services returned by the service list endpoint", () => {
    renderDashboard();

    for (const service of allServices) {
      expect(screen.getByTestId(`service-row-${service.name}`)).toBeInTheDocument();
    }
  });

  it("displays service names", () => {
    renderDashboard();

    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByText("blog")).toBeInTheDocument();
  });

  it("displays subdomains for all services", () => {
    renderDashboard();

    // Local services use name.domain
    expect(screen.getByText("api.example.com")).toBeInTheDocument();
    expect(screen.getByText("worker.example.com")).toBeInTheDocument();

    // Pages services use their subdomain field
    expect(screen.getByText("blog.example.com")).toBeInTheDocument();
    expect(screen.getByText("docs.example.com")).toBeInTheDocument();
  });

  it("displays service types", () => {
    renderDashboard();

    // Local services have "Local" type chip
    const apiType = screen.getByTestId("type-api");
    expect(apiType).toHaveTextContent("Local");

    // Pages services have "Pages" type chip
    const blogType = screen.getByTestId("type-blog");
    expect(blogType).toHaveTextContent("Pages");
  });

  it("displays running state with positive indicator", () => {
    renderDashboard();

    const statusChip = screen.getByTestId("status-api");
    expect(statusChip).toHaveTextContent("Running");
    // MUI success color class
    expect(statusChip).toHaveClass("MuiChip-colorSuccess");
  });

  it("displays crashed state with error indicator and restart count", () => {
    renderDashboard();

    const statusChip = screen.getByTestId("status-worker");
    expect(statusChip).toHaveTextContent("Crashed");
    expect(statusChip).toHaveClass("MuiChip-colorError");

    // Restart count
    const restartCell = screen.getByTestId("restarts-worker");
    expect(restartCell).toHaveTextContent("5");
  });

  it("displays stopped state with neutral indicator", () => {
    renderDashboard();

    const statusChip = screen.getByTestId("status-scheduler");
    expect(statusChip).toHaveTextContent("Stopped");
    expect(statusChip).toHaveClass("MuiChip-colorDefault");
  });

  it("displays restarting state with warning indicator", () => {
    renderDashboard();

    const statusChip = screen.getByTestId("status-watcher");
    expect(statusChip).toHaveTextContent("Restarting");
    expect(statusChip).toHaveClass("MuiChip-colorWarning");
  });

  it("displays starting state with info indicator", () => {
    renderDashboard();

    const statusChip = screen.getByTestId("status-starter");
    expect(statusChip).toHaveTextContent("Starting");
    expect(statusChip).toHaveClass("MuiChip-colorInfo");
  });

  it("displays uptime for running local services", () => {
    renderDashboard();

    const uptimeCell = screen.getByTestId("uptime-api");
    // Should show ~1h (since runningSince is 1 hour ago)
    expect(uptimeCell.textContent).toMatch(/1h/);
  });

  it("does not display uptime for non-running services", () => {
    renderDashboard();

    const uptimeCell = screen.getByTestId("uptime-worker");
    expect(uptimeCell).toHaveTextContent("—");
  });

  it("displays restart count for local services", () => {
    renderDashboard();

    expect(screen.getByTestId("restarts-api")).toHaveTextContent("2");
    expect(screen.getByTestId("restarts-worker")).toHaveTextContent("5");
  });

  it("displays last crash reason for crashed services", () => {
    renderDashboard();

    const crashReason = screen.getByTestId("crash-reason-worker");
    expect(crashReason).toHaveTextContent("exit code 1");
  });

  it("displays Pages service with deployed status", () => {
    renderDashboard();

    const statusChip = screen.getByTestId("status-blog");
    expect(statusChip).toHaveTextContent("Deployed");
    expect(statusChip).toHaveClass("MuiChip-colorSuccess");
  });

  it("displays Pages service with not-deployed status", () => {
    renderDashboard();

    const statusChip = screen.getByTestId("status-docs");
    expect(statusChip).toHaveTextContent("Not Deployed");
  });

  it("does not show action buttons for Pages services", () => {
    renderDashboard();

    expect(screen.queryByTestId("restart-blog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stop-blog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("restart-docs")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stop-docs")).not.toBeInTheDocument();
  });

  it("shows action buttons for local services", () => {
    renderDashboard();

    expect(screen.getByTestId("restart-api")).toBeInTheDocument();
    expect(screen.getByTestId("stop-api")).toBeInTheDocument();
  });

  it("disables stop button for stopped services", () => {
    renderDashboard();

    const stopButton = screen.getByTestId("stop-scheduler");
    expect(stopButton).toBeDisabled();
  });

  it("disables restart and stop buttons for restarting services", () => {
    renderDashboard();

    const restartButton = screen.getByTestId("restart-watcher");
    const stopButton = screen.getByTestId("stop-watcher");
    expect(restartButton).toBeDisabled();
    expect(stopButton).toBeDisabled();
  });

  it("calls restart endpoint when restart button is clicked", async () => {
    const mockRestart = vi.fn().mockResolvedValue(undefined);
    useServiceStore.setState({ restartService: mockRestart });

    renderDashboard();

    const restartButton = screen.getByTestId("restart-api");
    await userEvent.click(restartButton);

    expect(mockRestart).toHaveBeenCalledWith("api");
  });

  it("calls stop endpoint when stop button is clicked", async () => {
    const mockStop = vi.fn().mockResolvedValue(undefined);
    useServiceStore.setState({ stopService: mockStop });

    renderDashboard();

    const stopButton = screen.getByTestId("stop-api");
    await userEvent.click(stopButton);

    expect(mockStop).toHaveBeenCalledWith("api");
  });

  it("shows loading state during pending actions", () => {
    useServiceStore.setState({
      pendingActions: new Set(["api"]),
    });

    renderDashboard();

    // Should show a loading spinner instead of action buttons
    expect(screen.getByTestId("loading-api")).toBeInTheDocument();
    expect(screen.queryByTestId("restart-api")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stop-api")).not.toBeInTheDocument();
  });

  it("shows a loading spinner when services are not yet loaded", () => {
    useServiceStore.setState({
      services: [],
      loaded: false,
    });

    renderDashboard();

    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });
});

/**
 * Tests for the LogViewer component.
 *
 * Verifies service selector, log entry rendering, auto-scroll behavior,
 * connection status indicator, and empty state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { MemoryRouter } from "react-router-dom";
import { LogViewer } from "../components/LogViewer";
import { useLogStore, COMBINED_SERVICE } from "../stores/useLogStore";
import { useServiceStore } from "../stores/useServiceStore";
import type { LogEntry } from "../types";

// Mock the API client
vi.mock("../api/client", () => ({
  fetchConfig: vi.fn().mockResolvedValue({ success: true, content: "domain: example.com" }),
  validateConfig: vi.fn().mockResolvedValue({ success: true, errors: [] }),
  saveConfig: vi.fn().mockResolvedValue({ success: true }),
  fetchServices: vi.fn().mockResolvedValue({ success: true, services: [] }),
  restartService: vi.fn().mockResolvedValue({ success: true }),
  stopService: vi.fn().mockResolvedValue({ success: true }),
  getLogWebSocketUrl: vi.fn().mockReturnValue("ws://localhost/api/logs"),
}));

const theme = createTheme({ palette: { mode: "dark" } });

const sampleEntries: LogEntry[] = [
  {
    timestamp: "2024-01-01T12:00:00.000Z",
    service: "api",
    source: "stdout",
    line: "Server started on port 3000",
  },
  {
    timestamp: "2024-01-01T12:00:01.000Z",
    service: "api",
    source: "stderr",
    line: "Warning: deprecated function used",
  },
  {
    timestamp: "2024-01-01T12:00:02.000Z",
    service: "worker",
    source: "stdout",
    line: "Worker processing job 42",
  },
];

function renderLogViewer() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <LogViewer />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("LogViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset service store
    useServiceStore.setState({
      services: [
        {
          name: "api",
          type: "local",
          state: "running",
          runningSince: "2024-01-01T00:00:00.000Z",
          restartCount: 0,
          lastCrashReason: null,
        },
        {
          name: "worker",
          type: "local",
          state: "running",
          runningSince: "2024-01-01T00:00:00.000Z",
          restartCount: 0,
          lastCrashReason: null,
        },
        {
          name: "blog",
          type: "pages",
          subdomain: "blog.example.com",
          deployed: true,
        },
      ],
      loaded: true,
      connected: true,
      pendingActions: new Set(),
      _pollInterval: null,
    });

    // Reset log store — pre-set so connect/disconnect mocks don't fire real WebSocket
    useLogStore.setState({
      connectionStatus: "connected",
      selectedService: COMBINED_SERVICE,
      entries: sampleEntries,
      availableServices: ["api", "worker"],
      _ws: null,
      _reconnectTimer: null,
      _intentionalClose: false,
    });

    // Override connect/disconnect to no-ops for view tests
    useLogStore.setState({
      connect: vi.fn(),
      disconnect: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the service selector with local services and combined option", () => {
    renderLogViewer();

    expect(screen.getByTestId("service-selector")).toBeInTheDocument();
    // The select should show "All Services" as the current value
    expect(screen.getByText("All Services")).toBeInTheDocument();
  });

  it("does not show Pages services in the service selector", () => {
    renderLogViewer();

    // Pages service "blog" should not appear as an option
    expect(screen.queryByTestId("service-option-blog")).not.toBeInTheDocument();
  });

  it("displays log entries with timestamps and content", () => {
    renderLogViewer();

    const logEntries = screen.getAllByTestId("log-entry");
    expect(logEntries.length).toBe(3);

    // Check timestamps are rendered
    const timestamps = screen.getAllByTestId("log-timestamp");
    expect(timestamps.length).toBe(3);

    // Check log content
    expect(screen.getByText("Server started on port 3000")).toBeInTheDocument();
    expect(screen.getByText("Warning: deprecated function used")).toBeInTheDocument();
    expect(screen.getByText("Worker processing job 42")).toBeInTheDocument();
  });

  it("shows service name in combined mode", () => {
    renderLogViewer();

    const serviceLabels = screen.getAllByTestId("log-service");
    expect(serviceLabels.length).toBe(3);
    expect(serviceLabels[0]).toHaveTextContent("[api]");
    expect(serviceLabels[2]).toHaveTextContent("[worker]");
  });

  it("does not show service name in per-service mode", () => {
    useLogStore.setState({
      selectedService: "api",
      entries: [sampleEntries[0]],
    });

    renderLogViewer();

    expect(screen.queryByTestId("log-service")).not.toBeInTheDocument();
  });

  it("visually differentiates stdout and stderr", () => {
    renderLogViewer();

    const sourceLabels = screen.getAllByTestId("log-source");
    expect(sourceLabels[0]).toHaveTextContent("stdout");
    expect(sourceLabels[1]).toHaveTextContent("stderr");
  });

  it("shows connection status indicator", () => {
    renderLogViewer();

    const status = screen.getByTestId("connection-status");
    expect(status).toHaveTextContent("Connected");
  });

  it("shows disconnected status", () => {
    useLogStore.setState({ connectionStatus: "disconnected" });

    renderLogViewer();

    const status = screen.getByTestId("connection-status");
    expect(status).toHaveTextContent("Disconnected");
    expect(screen.getByTestId("disconnected-message")).toBeInTheDocument();
  });

  it("shows reconnecting status", () => {
    useLogStore.setState({ connectionStatus: "reconnecting" });

    renderLogViewer();

    const status = screen.getByTestId("connection-status");
    expect(status).toHaveTextContent("Reconnecting…");
  });

  it("shows empty state when no logs available", () => {
    useLogStore.setState({ entries: [] });

    renderLogViewer();

    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
  });

  it("shows empty state with appropriate message when no service selected", () => {
    // Clear available services too so auto-select doesn't fire
    useLogStore.setState({
      entries: [],
      selectedService: null,
      availableServices: [],
      selectService: vi.fn(),
    });
    // Also clear the service store so the useEffect doesn't populate availableServices
    useServiceStore.setState({ services: [], loaded: true });

    renderLogViewer();

    expect(screen.getByTestId("empty-state")).toHaveTextContent("Select a service to view logs");
  });

  it("calls selectService when service selector changes", async () => {
    const mockSelectService = vi.fn();
    useLogStore.setState({ selectService: mockSelectService });

    const user = userEvent.setup();
    renderLogViewer();

    // Open the MUI select dropdown
    const selector = screen.getByTestId("service-selector");
    const button = selector.querySelector("[role='combobox']");
    if (button) {
      await user.click(button);
    }

    // Click on "api" option in the dropdown
    const apiOption = await screen.findByTestId("service-option-api");
    await user.click(apiOption);

    expect(mockSelectService).toHaveBeenCalledWith("api");
  });

  it("auto-scroll is active by default — log output is at bottom", () => {
    renderLogViewer();

    const logOutput = screen.getByTestId("log-output");
    // The new-logs indicator should not be visible initially
    expect(screen.queryByTestId("new-logs-indicator")).not.toBeInTheDocument();
    // Log output should be rendered
    expect(logOutput).toBeInTheDocument();
  });

  it("shows new-logs indicator when scrolled up and new entries arrive", () => {
    const { rerender } = render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <LogViewer />
        </MemoryRouter>
      </ThemeProvider>,
    );

    const logOutput = screen.getByTestId("log-output");

    // Simulate scrolling up (not at bottom)
    Object.defineProperty(logOutput, "scrollHeight", { value: 1000, writable: true });
    Object.defineProperty(logOutput, "scrollTop", { value: 0, writable: true });
    Object.defineProperty(logOutput, "clientHeight", { value: 500, writable: true });

    act(() => {
      fireEvent.scroll(logOutput);
    });

    // Add new entries
    act(() => {
      useLogStore.setState({
        entries: [
          ...sampleEntries,
          {
            timestamp: "2024-01-01T12:00:03.000Z",
            service: "api",
            source: "stdout",
            line: "New log line",
          },
        ],
      });
    });

    rerender(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <LogViewer />
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(screen.getByTestId("new-logs-indicator")).toBeInTheDocument();
  });

  it("clicking new-logs indicator scrolls to bottom", async () => {
    const user = userEvent.setup();

    // Pre-set the state so the indicator will be visible
    useLogStore.setState({ entries: sampleEntries });

    const { rerender } = render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <LogViewer />
        </MemoryRouter>
      </ThemeProvider>,
    );

    const logOutput = screen.getByTestId("log-output");

    // Simulate scrolled up position
    Object.defineProperty(logOutput, "scrollHeight", { value: 1000, writable: true });
    Object.defineProperty(logOutput, "scrollTop", { value: 0, writable: true });
    Object.defineProperty(logOutput, "clientHeight", { value: 500, writable: true });

    act(() => {
      fireEvent.scroll(logOutput);
    });

    // Add new entry to trigger indicator
    act(() => {
      useLogStore.setState({
        entries: [
          ...sampleEntries,
          {
            timestamp: "2024-01-01T12:00:03.000Z",
            service: "api",
            source: "stdout",
            line: "New line",
          },
        ],
      });
    });

    rerender(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <LogViewer />
        </MemoryRouter>
      </ThemeProvider>,
    );

    const indicator = screen.getByTestId("new-logs-indicator");
    await user.click(indicator);

    // After clicking, the indicator should disappear (auto-scroll re-enabled)
    expect(screen.queryByTestId("new-logs-indicator")).not.toBeInTheDocument();
  });
});

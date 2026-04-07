/**
 * Tests for the TunnelStatus component.
 *
 * Verifies connected and disconnected visual states.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { TunnelStatus } from "../components/TunnelStatus";
import { useServiceStore } from "../stores/useServiceStore";

// Mock the API client to prevent real network calls
vi.mock("../api/client", () => ({
  fetchServices: vi.fn().mockResolvedValue({ success: true, services: [] }),
  restartService: vi.fn().mockResolvedValue({ success: true }),
  stopService: vi.fn().mockResolvedValue({ success: true }),
}));

const theme = createTheme({ palette: { mode: "dark" } });

function renderTunnelStatus() {
  return render(
    <ThemeProvider theme={theme}>
      <TunnelStatus />
    </ThemeProvider>,
  );
}

describe("TunnelStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows connected state when tunnel is connected", () => {
    useServiceStore.setState({ connected: true });

    renderTunnelStatus();

    const chip = screen.getByTestId("tunnel-status");
    expect(chip).toHaveTextContent("Connected");
    expect(chip).toHaveAttribute("data-connected", "true");
  });

  it("shows disconnected state when tunnel is disconnected", () => {
    useServiceStore.setState({ connected: false });

    renderTunnelStatus();

    const chip = screen.getByTestId("tunnel-status");
    expect(chip).toHaveTextContent("Disconnected");
    expect(chip).toHaveAttribute("data-connected", "false");
  });
});

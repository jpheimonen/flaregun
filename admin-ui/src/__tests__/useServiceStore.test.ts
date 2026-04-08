/**
 * Tests for the service Zustand store.
 *
 * Verifies fetching, polling, and action behaviors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useServiceStore } from "../stores/useServiceStore";
import type { ServiceInfo } from "../types";

// Mock the API client module
vi.mock("../api/client", () => ({
  fetchServices: vi.fn(),
  restartService: vi.fn(),
  stopService: vi.fn(),
}));

// Import the mocked module
import * as api from "../api/client";

const mockFetchServices = vi.mocked(api.fetchServices);
const mockRestartService = vi.mocked(api.restartService);
const mockStopService = vi.mocked(api.stopService);

const mockServices: ServiceInfo[] = [
  {
    name: "api",
    type: "local",
    state: "running",
    runningSince: "2024-01-01T00:00:00.000Z",
    restartCount: 2,
    lastCrashReason: null,
  },
  {
    name: "blog",
    type: "pages",
    subdomain: "blog.example.com",
    deployed: true,
  },
];

describe("useServiceStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset the store state between tests
    useServiceStore.setState({
      services: [],
      loaded: false,
      connected: true,
      pendingActions: new Set(),
      _pollInterval: null,
    });
  });

  afterEach(() => {
    // Clean up polling
    useServiceStore.getState().stopPolling();
    vi.useRealTimers();
  });

  it("fetches the service list on initialization", async () => {
    mockFetchServices.mockResolvedValue({
      success: true,
      services: mockServices,
    });

    await useServiceStore.getState().fetchServices();

    const state = useServiceStore.getState();
    expect(state.services).toEqual(mockServices);
    expect(state.loaded).toBe(true);
    expect(state.connected).toBe(true);
    expect(mockFetchServices).toHaveBeenCalledTimes(1);
  });

  it("sets connected to false when fetch fails", async () => {
    mockFetchServices.mockRejectedValue(new Error("Network error"));

    await useServiceStore.getState().fetchServices();

    const state = useServiceStore.getState();
    expect(state.connected).toBe(false);
  });

  it("updates when polling returns new data", async () => {
    const updatedServices: ServiceInfo[] = [
      {
        name: "api",
        type: "local",
        state: "crashed",
        runningSince: null,
        restartCount: 3,
        lastCrashReason: "exit code 1",
      },
    ];

    mockFetchServices
      .mockResolvedValueOnce({ success: true, services: mockServices })
      .mockResolvedValueOnce({ success: true, services: updatedServices });

    // Start polling
    useServiceStore.getState().startPolling();

    // Wait for initial fetch
    await vi.advanceTimersByTimeAsync(0);
    expect(useServiceStore.getState().services).toEqual(mockServices);

    // Advance to next poll
    await vi.advanceTimersByTimeAsync(3000);
    expect(useServiceStore.getState().services).toEqual(updatedServices);
    expect(mockFetchServices).toHaveBeenCalledTimes(2);
  });

  it("sends a request to the restart endpoint and refreshes", async () => {
    mockFetchServices.mockResolvedValue({
      success: true,
      services: mockServices,
    });
    mockRestartService.mockResolvedValue({ success: true });

    // Pre-load services
    await useServiceStore.getState().fetchServices();

    await useServiceStore.getState().restartService("api");

    expect(mockRestartService).toHaveBeenCalledWith("api");
    // Should have refreshed the service list after restart
    expect(mockFetchServices).toHaveBeenCalledTimes(2);
  });

  it("sends a request to the stop endpoint and refreshes", async () => {
    mockFetchServices.mockResolvedValue({
      success: true,
      services: mockServices,
    });
    mockStopService.mockResolvedValue({ success: true });

    // Pre-load services
    await useServiceStore.getState().fetchServices();

    await useServiceStore.getState().stopService("api");

    expect(mockStopService).toHaveBeenCalledWith("api");
    // Should have refreshed the service list after stop
    expect(mockFetchServices).toHaveBeenCalledTimes(2);
  });

  it("manages pending actions during restart", async () => {
    mockFetchServices.mockResolvedValue({
      success: true,
      services: mockServices,
    });

    let resolveFn: () => void;
    const restartPromise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    mockRestartService.mockReturnValue(
      restartPromise.then(() => ({ success: true })),
    );

    const restartAction = useServiceStore.getState().restartService("api");

    // Pending should be set
    expect(useServiceStore.getState().pendingActions.has("api")).toBe(true);

    // Resolve the restart
    resolveFn!();
    await restartAction;

    // Pending should be cleared
    expect(useServiceStore.getState().pendingActions.has("api")).toBe(false);
  });

  it("clears pending action even on failure", async () => {
    mockFetchServices.mockResolvedValue({
      success: true,
      services: mockServices,
    });
    mockRestartService.mockRejectedValue(new Error("restart failed"));

    try {
      await useServiceStore.getState().restartService("api");
    } catch {
      // Expected
    }

    // Pending should be cleared even after failure
    expect(useServiceStore.getState().pendingActions.has("api")).toBe(false);
  });

  it("does not start multiple polling intervals", () => {
    mockFetchServices.mockResolvedValue({
      success: true,
      services: mockServices,
    });

    useServiceStore.getState().startPolling();
    useServiceStore.getState().startPolling();

    // Only one interval should be set
    expect(mockFetchServices).toHaveBeenCalledTimes(1);
  });

  it("force refresh immediately fetches services", async () => {
    mockFetchServices.mockResolvedValue({
      success: true,
      services: mockServices,
    });

    await useServiceStore.getState().refresh();

    expect(mockFetchServices).toHaveBeenCalledTimes(1);
    expect(useServiceStore.getState().services).toEqual(mockServices);
  });
});

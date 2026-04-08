/**
 * Tests for the log viewer Zustand store.
 *
 * Verifies WebSocket connection management, subscription switching,
 * log entry storage, buffer capping, and reconnection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useLogStore, COMBINED_SERVICE } from "../stores/useLogStore";

// Mock the API client
vi.mock("../api/client", () => ({
  fetchConfig: vi.fn(),
  validateConfig: vi.fn(),
  saveConfig: vi.fn(),
  fetchServices: vi.fn(),
  restartService: vi.fn(),
  stopService: vi.fn(),
  getLogWebSocketUrl: vi.fn().mockReturnValue("ws://localhost/api/logs"),
}));

/**
 * Fake WebSocket implementation for testing.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent("close"));
    }
  }

  /** Simulate the connection opening */
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) {
      this.onopen(new Event("open"));
    }
  }

  /** Simulate receiving a message */
  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
  }

  /** Simulate a connection error followed by close */
  simulateError() {
    if (this.onerror) {
      this.onerror(new Event("error"));
    }
  }

  static instances: FakeWebSocket[] = [];
  static reset() {
    FakeWebSocket.instances = [];
  }
  static latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

// Install the fake WebSocket globally
const OriginalWebSocket = globalThis.WebSocket;

describe("useLogStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    FakeWebSocket.reset();

    // Replace global WebSocket with our fake
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    // Reset the store
    useLogStore.setState({
      connectionStatus: "disconnected",
      selectedService: null,
      entries: [],
      availableServices: [],
      _ws: null,
      _reconnectTimer: null,
      _intentionalClose: false,
    });
  });

  afterEach(() => {
    // Restore original WebSocket
    globalThis.WebSocket = OriginalWebSocket;
    vi.useRealTimers();
  });

  it("opens a WebSocket connection on connect", () => {
    useLogStore.getState().connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.latest().url).toBe("ws://localhost/api/logs");
  });

  it("sets connected status when WebSocket opens", () => {
    useLogStore.getState().connect();
    FakeWebSocket.latest().simulateOpen();

    expect(useLogStore.getState().connectionStatus).toBe("connected");
  });

  it("closes the WebSocket connection on disconnect", () => {
    useLogStore.getState().connect();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    useLogStore.getState().disconnect();

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(useLogStore.getState().connectionStatus).toBe("disconnected");
  });

  it("adds log entries when receiving log messages", () => {
    useLogStore.getState().connect();
    FakeWebSocket.latest().simulateOpen();

    FakeWebSocket.latest().simulateMessage({
      type: "log",
      timestamp: "2024-01-01T00:00:00.000Z",
      service: "api",
      source: "stdout",
      line: "Server started",
    });

    const entries = useLogStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      timestamp: "2024-01-01T00:00:00.000Z",
      service: "api",
      source: "stdout",
      line: "Server started",
    });
  });

  it("handles history messages with multiple entries", () => {
    useLogStore.getState().connect();
    FakeWebSocket.latest().simulateOpen();

    FakeWebSocket.latest().simulateMessage({
      type: "history",
      entries: [
        { type: "log", timestamp: "2024-01-01T00:00:00.000Z", service: "api", source: "stdout", line: "Line 1" },
        { type: "log", timestamp: "2024-01-01T00:00:01.000Z", service: "api", source: "stderr", line: "Line 2" },
      ],
    });

    expect(useLogStore.getState().entries).toHaveLength(2);
  });

  it("does not exceed the maximum buffer size", () => {
    useLogStore.getState().connect();
    FakeWebSocket.latest().simulateOpen();

    // Add entries up to the max
    const maxEntries = 2000;
    const batch = Array.from({ length: maxEntries + 100 }, (_, i) => ({
      type: "log" as const,
      timestamp: `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      service: "api",
      source: "stdout" as const,
      line: `Line ${i}`,
    }));

    FakeWebSocket.latest().simulateMessage({
      type: "history",
      entries: batch,
    });

    expect(useLogStore.getState().entries.length).toBeLessThanOrEqual(maxEntries);
    // The last entry should be the most recent
    expect(useLogStore.getState().entries[useLogStore.getState().entries.length - 1].line).toBe(
      `Line ${maxEntries + 99}`,
    );
  });

  it("sends a subscription message when selecting a service", () => {
    useLogStore.getState().connect();
    FakeWebSocket.latest().simulateOpen();

    useLogStore.getState().selectService("api");

    const sent = FakeWebSocket.latest().sentMessages;
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ type: "subscribe", service: "api" });
  });

  it("clears entries when switching services", () => {
    useLogStore.getState().connect();
    FakeWebSocket.latest().simulateOpen();

    // Add some entries
    FakeWebSocket.latest().simulateMessage({
      type: "log",
      timestamp: "2024-01-01T00:00:00.000Z",
      service: "api",
      source: "stdout",
      line: "Hello",
    });

    expect(useLogStore.getState().entries).toHaveLength(1);

    // Switch service
    useLogStore.getState().selectService("worker");

    expect(useLogStore.getState().entries).toHaveLength(0);
    expect(useLogStore.getState().selectedService).toBe("worker");
  });

  it("sends subscription to combined stream with __all__", () => {
    useLogStore.getState().connect();
    FakeWebSocket.latest().simulateOpen();

    useLogStore.getState().selectService(COMBINED_SERVICE);

    const sent = FakeWebSocket.latest().sentMessages;
    expect(JSON.parse(sent[0])).toEqual({ type: "subscribe", service: "__all__" });
  });

  it("sets disconnected status and attempts reconnection when connection drops", () => {
    useLogStore.getState().connect();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    // Simulate connection drop (not intentional close)
    ws.readyState = FakeWebSocket.CLOSED;
    if (ws.onclose) {
      ws.onclose(new CloseEvent("close"));
    }

    expect(useLogStore.getState().connectionStatus).toBe("reconnecting");

    // Advance past reconnect delay
    vi.advanceTimersByTime(3000);

    // Should have created a new WebSocket
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
  });

  it("does not reconnect after intentional disconnect", () => {
    useLogStore.getState().connect();
    FakeWebSocket.latest().simulateOpen();

    useLogStore.getState().disconnect();

    vi.advanceTimersByTime(5000);

    // Only the initial connection should exist
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(useLogStore.getState().connectionStatus).toBe("disconnected");
  });

  it("re-subscribes to the selected service when reconnecting", () => {
    useLogStore.getState().connect();
    FakeWebSocket.latest().simulateOpen();

    // Select a service
    useLogStore.getState().selectService("api");

    // Simulate disconnect
    const ws = FakeWebSocket.latest();
    ws.readyState = FakeWebSocket.CLOSED;
    if (ws.onclose) {
      ws.onclose(new CloseEvent("close"));
    }

    // Reconnect
    vi.advanceTimersByTime(3000);
    const newWs = FakeWebSocket.latest();
    newWs.simulateOpen();

    // Should have re-subscribed
    const sent = newWs.sentMessages;
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(sent[sent.length - 1])).toEqual({ type: "subscribe", service: "api" });
  });
});

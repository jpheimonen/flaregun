/**
 * Zustand store for real-time log streaming via WebSocket.
 *
 * Manages the WebSocket connection lifecycle, per-service and combined
 * log subscriptions, and a capped log entry buffer.
 */

import { create } from "zustand";
import * as api from "../api/client";
import type { LogEntry, LogServerMessage, LogStreamMessage } from "../types";

/** Maximum number of log entries to keep in the buffer */
const MAX_LOG_ENTRIES = 2000;

/** Reconnection delay (ms) */
const RECONNECT_DELAY_MS = 2000;

/** Special service name for combined (all services) stream */
export const COMBINED_SERVICE = "__all__";

export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

export interface LogStoreState {
  /** Current WebSocket connection status */
  connectionStatus: ConnectionStatus;
  /** Currently selected service (name or COMBINED_SERVICE) */
  selectedService: string | null;
  /** Buffered log entries */
  entries: LogEntry[];
  /** Available services (local only — pulled from the service store) */
  availableServices: string[];
  /** Internal: WebSocket instance */
  _ws: WebSocket | null;
  /** Internal: reconnect timer */
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Internal: whether the store has been intentionally disconnected */
  _intentionalClose: boolean;
}

export interface LogStoreActions {
  /** Open the WebSocket connection */
  connect: () => void;
  /** Close the WebSocket connection */
  disconnect: () => void;
  /** Select a service and subscribe to its log stream */
  selectService: (service: string) => void;
  /** Set the list of available services */
  setAvailableServices: (services: string[]) => void;
  /** Internal: handle incoming WebSocket messages */
  _handleMessage: (event: MessageEvent) => void;
  /** Internal: attempt reconnection */
  _reconnect: () => void;
}

export type LogStore = LogStoreState & LogStoreActions;

/**
 * Convert a LogStreamMessage to a LogEntry (strip the `type` field).
 */
function toLogEntry(msg: LogStreamMessage): LogEntry {
  return {
    timestamp: msg.timestamp,
    service: msg.service,
    source: msg.source,
    line: msg.line,
  };
}

/**
 * Append entries to the buffer, capping at MAX_LOG_ENTRIES.
 */
function appendEntries(existing: LogEntry[], newEntries: LogEntry[]): LogEntry[] {
  const combined = [...existing, ...newEntries];
  if (combined.length > MAX_LOG_ENTRIES) {
    return combined.slice(combined.length - MAX_LOG_ENTRIES);
  }
  return combined;
}

export const useLogStore = create<LogStore>((set, get) => ({
  connectionStatus: "disconnected",
  selectedService: null,
  entries: [],
  availableServices: [],
  _ws: null,
  _reconnectTimer: null,
  _intentionalClose: false,

  connect: () => {
    const { _ws } = get();
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      return; // Already connected or connecting
    }

    set({ _intentionalClose: false });

    const url = api.getLogWebSocketUrl();
    const ws = new WebSocket(url);

    ws.onopen = () => {
      set({ connectionStatus: "connected", _ws: ws });
      // Re-subscribe to the currently selected service if any
      const { selectedService } = get();
      if (selectedService) {
        ws.send(JSON.stringify({ type: "subscribe", service: selectedService }));
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      get()._handleMessage(event);
    };

    ws.onclose = () => {
      set({ _ws: null });
      const { _intentionalClose } = get();
      if (!_intentionalClose) {
        set({ connectionStatus: "reconnecting" });
        get()._reconnect();
      } else {
        set({ connectionStatus: "disconnected" });
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror, so reconnection is handled there
    };

    set({ _ws: ws, connectionStatus: "reconnecting" });
  },

  disconnect: () => {
    const { _ws, _reconnectTimer } = get();
    set({ _intentionalClose: true });
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
    }
    if (_ws) {
      _ws.close();
    }
    set({
      _ws: null,
      _reconnectTimer: null,
      connectionStatus: "disconnected",
    });
  },

  selectService: (service: string) => {
    const { _ws, selectedService } = get();
    if (service === selectedService) return;

    // Clear entries when switching
    set({ selectedService: service, entries: [] });

    // Send subscription if connected
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ type: "subscribe", service }));
    }
  },

  setAvailableServices: (services: string[]) => {
    set({ availableServices: services });
  },

  _handleMessage: (event: MessageEvent) => {
    try {
      const data: LogServerMessage = JSON.parse(event.data as string);

      if (data.type === "log") {
        const entry = toLogEntry(data);
        set((state) => ({
          entries: appendEntries(state.entries, [entry]),
        }));
      } else if (data.type === "history") {
        const entries = data.entries.map(toLogEntry);
        set((state) => ({
          entries: appendEntries(state.entries, entries),
        }));
      }
    } catch {
      // Ignore malformed messages
    }
  },

  _reconnect: () => {
    const { _intentionalClose } = get();
    if (_intentionalClose) return;

    const timer = setTimeout(() => {
      const { _intentionalClose: closed } = get();
      if (!closed) {
        get().connect();
      }
    }, RECONNECT_DELAY_MS);

    set({ _reconnectTimer: timer });
  },
}));

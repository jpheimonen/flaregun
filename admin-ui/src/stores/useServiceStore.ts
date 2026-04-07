/**
 * Zustand store for managing service state.
 *
 * Fetches the service list from the backend on init, polls at a regular
 * interval, and provides actions for restart/stop.
 */

import { create } from "zustand";
import type { ServiceInfo } from "../types";
import * as api from "../api/client";

/** How often to poll the service list (ms) */
const POLL_INTERVAL = 3000;

export interface ServiceStoreState {
  /** All services (local + Pages) */
  services: ServiceInfo[];
  /** Whether the initial fetch has completed */
  loaded: boolean;
  /** Whether any fetch error has occurred (used for tunnel status) */
  connected: boolean;
  /** Set of service names with a pending action (restart/stop) */
  pendingActions: Set<string>;
  /** Polling interval ID */
  _pollInterval: ReturnType<typeof setInterval> | null;
}

export interface ServiceStoreActions {
  /** Fetch the service list from the backend */
  fetchServices: () => Promise<void>;
  /** Start polling the service list */
  startPolling: () => void;
  /** Stop polling */
  stopPolling: () => void;
  /** Force an immediate refresh */
  refresh: () => Promise<void>;
  /** Restart a local service */
  restartService: (name: string) => Promise<void>;
  /** Stop a local service */
  stopService: (name: string) => Promise<void>;
}

export type ServiceStore = ServiceStoreState & ServiceStoreActions;

export const useServiceStore = create<ServiceStore>((set, get) => ({
  services: [],
  loaded: false,
  connected: true,
  pendingActions: new Set(),
  _pollInterval: null,

  fetchServices: async () => {
    try {
      const response = await api.fetchServices();
      if (response.success) {
        set({ services: response.services, loaded: true, connected: true });
      }
    } catch {
      set({ connected: false });
    }
  },

  startPolling: () => {
    const { _pollInterval, fetchServices } = get();
    if (_pollInterval) return; // Already polling

    // Initial fetch
    fetchServices();

    const interval = setInterval(() => {
      fetchServices();
    }, POLL_INTERVAL);

    set({ _pollInterval: interval });
  },

  stopPolling: () => {
    const { _pollInterval } = get();
    if (_pollInterval) {
      clearInterval(_pollInterval);
      set({ _pollInterval: null });
    }
  },

  refresh: async () => {
    await get().fetchServices();
  },

  restartService: async (name: string) => {
    const { pendingActions } = get();
    const newPending = new Set(pendingActions);
    newPending.add(name);
    set({ pendingActions: newPending });

    try {
      await api.restartService(name);
      // Refresh service list immediately after action
      await get().fetchServices();
    } finally {
      const { pendingActions: currentPending } = get();
      const updated = new Set(currentPending);
      updated.delete(name);
      set({ pendingActions: updated });
    }
  },

  stopService: async (name: string) => {
    const { pendingActions } = get();
    const newPending = new Set(pendingActions);
    newPending.add(name);
    set({ pendingActions: newPending });

    try {
      await api.stopService(name);
      // Refresh service list immediately after action
      await get().fetchServices();
    } finally {
      const { pendingActions: currentPending } = get();
      const updated = new Set(currentPending);
      updated.delete(name);
      set({ pendingActions: updated });
    }
  },
}));

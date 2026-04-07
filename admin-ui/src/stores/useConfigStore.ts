/**
 * Zustand store for config state.
 *
 * Fetches the raw YAML config from the backend and extracts the domain name.
 */

import { create } from "zustand";
import * as api from "../api/client";

export interface ConfigStoreState {
  /** The domain from the config (e.g., "example.com") */
  domain: string | null;
  /** Raw YAML config content */
  rawContent: string | null;
  /** Whether the config has been loaded */
  loaded: boolean;
}

export interface ConfigStoreActions {
  /** Fetch the config from the backend */
  fetchConfig: () => Promise<void>;
}

export type ConfigStore = ConfigStoreState & ConfigStoreActions;

/**
 * Extract the domain value from raw YAML content.
 * Uses a simple regex to avoid needing a full YAML parser in the frontend.
 */
function extractDomain(yaml: string): string | null {
  const match = yaml.match(/^domain:\s*["']?([^\s"'#]+)["']?/m);
  return match ? match[1] : null;
}

export const useConfigStore = create<ConfigStore>((set) => ({
  domain: null,
  rawContent: null,
  loaded: false,

  fetchConfig: async () => {
    try {
      const response = await api.fetchConfig();
      if (response.success && response.content) {
        const domain = extractDomain(response.content);
        set({
          domain,
          rawContent: response.content,
          loaded: true,
        });
      }
    } catch {
      // Silently fail — the domain will remain null
    }
  },
}));

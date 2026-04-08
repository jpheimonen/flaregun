/**
 * Zustand store for config state.
 *
 * Manages the config editor: fetching YAML, live validation with debounce,
 * save with hot-reload feedback, and discard.
 */

import { create } from "zustand";
import * as api from "../api/client";
import type { HotReloadResult } from "../types";

/** Debounce delay for validation (ms) */
const VALIDATE_DEBOUNCE_MS = 400;

export interface ConfigStoreState {
  /** The domain from the config (e.g., "example.com") */
  domain: string | null;
  /** Raw YAML config content as last loaded/saved from backend */
  rawContent: string | null;
  /** Current editor content (may differ from rawContent when dirty) */
  editorContent: string | null;
  /** Whether the config has been loaded */
  loaded: boolean;
  /** Whether the editor content differs from the last loaded/saved version */
  dirty: boolean;
  /** Validation errors from the most recent validate call */
  validationErrors: string[];
  /** Whether a validation request is in flight */
  validating: boolean;
  /** Whether a save request is in flight */
  saving: boolean;
  /** Result message after a successful save */
  saveSuccess: string | null;
  /** Hot-reload result from the last save (may contain partial failures) */
  reloadResult: HotReloadResult | null;
  /** Save error messages */
  saveErrors: string[];
  /** Internal: debounce timer ID */
  _validateTimer: ReturnType<typeof setTimeout> | null;
}

export interface ConfigStoreActions {
  /** Fetch the config from the backend */
  fetchConfig: () => Promise<void>;
  /** Update the editor content (triggers debounced validation) */
  setEditorContent: (content: string) => void;
  /** Validate the current editor content immediately */
  validate: (content: string) => Promise<void>;
  /** Save the current editor content */
  save: () => Promise<void>;
  /** Discard edits and revert to the last loaded/saved content */
  discard: () => void;
  /** Clear save result messages */
  clearSaveResult: () => void;
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

export const useConfigStore = create<ConfigStore>((set, get) => ({
  domain: null,
  rawContent: null,
  editorContent: null,
  loaded: false,
  dirty: false,
  validationErrors: [],
  validating: false,
  saving: false,
  saveSuccess: null,
  reloadResult: null,
  saveErrors: [],
  _validateTimer: null,

  fetchConfig: async () => {
    try {
      const response = await api.fetchConfig();
      if (response.success && response.content) {
        const domain = extractDomain(response.content);
        set({
          domain,
          rawContent: response.content,
          editorContent: response.content,
          loaded: true,
          dirty: false,
          validationErrors: [],
          saveSuccess: null,
          reloadResult: null,
          saveErrors: [],
        });
      }
    } catch {
      // Silently fail — the domain will remain null
    }
  },

  setEditorContent: (content: string) => {
    const { rawContent, _validateTimer } = get();
    const dirty = content !== rawContent;

    // Clear any pending validation timer
    if (_validateTimer) {
      clearTimeout(_validateTimer);
    }

    // Set up a new debounced validation
    const timer = setTimeout(() => {
      get().validate(content);
    }, VALIDATE_DEBOUNCE_MS);

    set({
      editorContent: content,
      dirty,
      _validateTimer: timer,
      // Clear previous save results when editing
      saveSuccess: null,
      reloadResult: null,
      saveErrors: [],
    });
  },

  validate: async (content: string) => {
    set({ validating: true });
    try {
      const response = await api.validateConfig(content);
      // Only update if the content hasn't changed since we started validation
      if (get().editorContent === content) {
        set({
          validationErrors: response.success ? [] : response.errors,
          validating: false,
        });
      }
    } catch {
      set({ validating: false });
    }
  },

  save: async () => {
    const { editorContent } = get();
    if (!editorContent) return;

    set({
      saving: true,
      saveSuccess: null,
      reloadResult: null,
      saveErrors: [],
    });

    try {
      const response = await api.saveConfig(editorContent);

      if (response.success) {
        const domain = extractDomain(editorContent);
        set({
          rawContent: editorContent,
          domain,
          dirty: false,
          saving: false,
          validationErrors: [],
          saveSuccess: "Config saved successfully",
          reloadResult: response.reload || null,
          saveErrors: [],
        });
      } else {
        set({
          saving: false,
          saveErrors: response.errors || ["Save failed"],
          saveSuccess: null,
          reloadResult: null,
        });
      }
    } catch {
      set({
        saving: false,
        saveErrors: ["Failed to save config — network error"],
        saveSuccess: null,
        reloadResult: null,
      });
    }
  },

  discard: () => {
    const { rawContent, _validateTimer } = get();
    if (_validateTimer) {
      clearTimeout(_validateTimer);
    }
    set({
      editorContent: rawContent,
      dirty: false,
      validationErrors: [],
      validating: false,
      saveSuccess: null,
      reloadResult: null,
      saveErrors: [],
      _validateTimer: null,
    });
  },

  clearSaveResult: () => {
    set({
      saveSuccess: null,
      reloadResult: null,
      saveErrors: [],
    });
  },
}));

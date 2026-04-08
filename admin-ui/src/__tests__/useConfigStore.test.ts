/**
 * Tests for the config editor Zustand store.
 *
 * Verifies loading, dirty state tracking, debounced validation,
 * save with hot-reload feedback, and discard behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useConfigStore } from "../stores/useConfigStore";

// Mock the API client module
vi.mock("../api/client", () => ({
  fetchConfig: vi.fn(),
  validateConfig: vi.fn(),
  saveConfig: vi.fn(),
  fetchServices: vi.fn(),
  restartService: vi.fn(),
  stopService: vi.fn(),
  getLogWebSocketUrl: vi.fn(),
}));

import * as api from "../api/client";

const mockFetchConfig = vi.mocked(api.fetchConfig);
const mockValidateConfig = vi.mocked(api.validateConfig);
const mockSaveConfig = vi.mocked(api.saveConfig);

const SAMPLE_YAML = `domain: example.com
services:
  api:
    command: bun run server.ts
    port: 3000
`;

describe("useConfigStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset the store state between tests
    useConfigStore.setState({
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
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches the current YAML from the config read endpoint on load", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });

    await useConfigStore.getState().fetchConfig();

    const state = useConfigStore.getState();
    expect(state.rawContent).toBe(SAMPLE_YAML);
    expect(state.editorContent).toBe(SAMPLE_YAML);
    expect(state.loaded).toBe(true);
    expect(state.domain).toBe("example.com");
    expect(state.dirty).toBe(false);
    expect(mockFetchConfig).toHaveBeenCalledTimes(1);
  });

  it("sets dirty state to true when editor content is modified", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });

    await useConfigStore.getState().fetchConfig();

    // Edit the content
    useConfigStore.getState().setEditorContent(SAMPLE_YAML + "\n# modified");

    expect(useConfigStore.getState().dirty).toBe(true);
    expect(useConfigStore.getState().editorContent).toBe(SAMPLE_YAML + "\n# modified");
  });

  it("triggers validation after debounce delay when content changes", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });
    mockValidateConfig.mockResolvedValue({
      success: false,
      errors: ["Missing required field: domain"],
    });

    await useConfigStore.getState().fetchConfig();

    // Edit the content
    useConfigStore.getState().setEditorContent("invalid: yaml");

    // Validation should not have been called yet
    expect(mockValidateConfig).not.toHaveBeenCalled();

    // Advance past the debounce delay (400ms)
    await vi.advanceTimersByTimeAsync(500);

    expect(mockValidateConfig).toHaveBeenCalledWith("invalid: yaml");
  });

  it("stores validation errors from the backend", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });
    mockValidateConfig.mockResolvedValue({
      success: false,
      errors: ["Missing required field: domain", "Invalid port: abc"],
    });

    await useConfigStore.getState().fetchConfig();

    useConfigStore.getState().setEditorContent("bad: yaml");
    await vi.advanceTimersByTimeAsync(500);

    const state = useConfigStore.getState();
    expect(state.validationErrors).toEqual([
      "Missing required field: domain",
      "Invalid port: abc",
    ]);
  });

  it("clears errors when fixing a validation error", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });

    // First validation fails
    mockValidateConfig.mockResolvedValueOnce({
      success: false,
      errors: ["Missing field"],
    });

    await useConfigStore.getState().fetchConfig();

    // Make a bad edit
    useConfigStore.getState().setEditorContent("bad");
    await vi.advanceTimersByTimeAsync(500);
    expect(useConfigStore.getState().validationErrors).toEqual(["Missing field"]);

    // Fix the edit — validation now succeeds
    mockValidateConfig.mockResolvedValueOnce({
      success: true,
      errors: [],
    });

    useConfigStore.getState().setEditorContent(SAMPLE_YAML + "\n# fixed");
    await vi.advanceTimersByTimeAsync(500);

    expect(useConfigStore.getState().validationErrors).toEqual([]);
  });

  it("calls the config save endpoint with the current content", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });
    mockSaveConfig.mockResolvedValue({
      success: true,
      reload: { success: true, errors: [], changes: ["Restarted api"] },
    });

    await useConfigStore.getState().fetchConfig();
    useConfigStore.getState().setEditorContent(SAMPLE_YAML + "\n# edit");

    // Cancel the debounce timer to avoid interference
    vi.advanceTimersByTime(500);

    await useConfigStore.getState().save();

    expect(mockSaveConfig).toHaveBeenCalledWith(SAMPLE_YAML + "\n# edit");
  });

  it("clears dirty state after a successful save", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });
    mockSaveConfig.mockResolvedValue({
      success: true,
      reload: { success: true, errors: [], changes: [] },
    });

    await useConfigStore.getState().fetchConfig();
    useConfigStore.getState().setEditorContent(SAMPLE_YAML + "\n# edit");
    expect(useConfigStore.getState().dirty).toBe(true);

    await useConfigStore.getState().save();

    const state = useConfigStore.getState();
    expect(state.dirty).toBe(false);
    expect(state.saveSuccess).toBeTruthy();
    expect(state.rawContent).toBe(SAMPLE_YAML + "\n# edit");
  });

  it("stores errors and keeps dirty state on failed save", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });
    mockSaveConfig.mockResolvedValue({
      success: false,
      errors: ["Invalid config"],
    });

    await useConfigStore.getState().fetchConfig();
    useConfigStore.getState().setEditorContent("bad config");

    await useConfigStore.getState().save();

    const state = useConfigStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.saveErrors).toEqual(["Invalid config"]);
    expect(state.saveSuccess).toBeNull();
  });

  it("resets content on discard and clears errors", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });
    mockValidateConfig.mockResolvedValue({
      success: false,
      errors: ["Some error"],
    });

    await useConfigStore.getState().fetchConfig();
    useConfigStore.getState().setEditorContent("modified content");
    await vi.advanceTimersByTimeAsync(500);

    expect(useConfigStore.getState().dirty).toBe(true);
    expect(useConfigStore.getState().validationErrors).toEqual(["Some error"]);

    useConfigStore.getState().discard();

    const state = useConfigStore.getState();
    expect(state.editorContent).toBe(SAMPLE_YAML);
    expect(state.dirty).toBe(false);
    expect(state.validationErrors).toEqual([]);
  });

  it("debounces rapid edits — only validates once", async () => {
    mockFetchConfig.mockResolvedValue({
      success: true,
      content: SAMPLE_YAML,
    });
    mockValidateConfig.mockResolvedValue({ success: true, errors: [] });

    await useConfigStore.getState().fetchConfig();

    // Rapid edits
    useConfigStore.getState().setEditorContent("edit 1");
    await vi.advanceTimersByTimeAsync(100);
    useConfigStore.getState().setEditorContent("edit 2");
    await vi.advanceTimersByTimeAsync(100);
    useConfigStore.getState().setEditorContent("edit 3");

    // Only advance past the debounce once
    await vi.advanceTimersByTimeAsync(500);

    // Should only validate the last content
    expect(mockValidateConfig).toHaveBeenCalledTimes(1);
    expect(mockValidateConfig).toHaveBeenCalledWith("edit 3");
  });
});

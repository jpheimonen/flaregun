/**
 * Tests for the ConfigEditor component.
 *
 * Verifies rendering, live validation, save/discard behavior,
 * dirty indicator, and error display.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { MemoryRouter } from "react-router-dom";
import { ConfigEditor } from "../components/ConfigEditor";
import { useConfigStore } from "../stores/useConfigStore";

// Mock the API client
vi.mock("../api/client", () => ({
  fetchConfig: vi.fn().mockResolvedValue({
    success: true,
    content: "domain: example.com\nservices:\n  api:\n    command: bun run\n    port: 3000\n",
  }),
  validateConfig: vi.fn().mockResolvedValue({ success: true, errors: [] }),
  saveConfig: vi.fn().mockResolvedValue({
    success: true,
    reload: { success: true, errors: [], changes: [] },
  }),
  fetchServices: vi.fn().mockResolvedValue({ success: true, services: [] }),
  restartService: vi.fn().mockResolvedValue({ success: true }),
  stopService: vi.fn().mockResolvedValue({ success: true }),
  getLogWebSocketUrl: vi.fn().mockReturnValue("ws://localhost/api/logs"),
}));

import * as api from "../api/client";

const mockValidateConfig = vi.mocked(api.validateConfig);
const mockSaveConfig = vi.mocked(api.saveConfig);

const theme = createTheme({ palette: { mode: "dark" } });

const SAMPLE_YAML = "domain: example.com\nservices:\n  api:\n    command: bun run\n    port: 3000\n";

function renderEditor() {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ConfigEditor />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("ConfigEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Reset the config store
    useConfigStore.setState({
      domain: "example.com",
      rawContent: SAMPLE_YAML,
      editorContent: SAMPLE_YAML,
      loaded: true,
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

  it("loads and displays the current YAML content from the backend", () => {
    renderEditor();

    const editor = screen.getByTestId("yaml-editor") as HTMLTextAreaElement;
    expect(editor.value).toBe(SAMPLE_YAML);
  });

  it("shows validation errors inline after debounce when editing introduces errors", async () => {
    mockValidateConfig.mockResolvedValue({
      success: false,
      errors: ["Missing required field: domain"],
    });

    // Set the store to have validation errors (simulating what happens after debounce)
    useConfigStore.setState({
      editorContent: "bad config",
      dirty: true,
      validationErrors: ["Missing required field: domain"],
    });

    renderEditor();

    expect(screen.getByTestId("validation-errors")).toBeInTheDocument();
    expect(screen.getByText("Missing required field: domain")).toBeInTheDocument();
  });

  it("clears error display when validation errors are resolved", () => {
    // Start with errors
    useConfigStore.setState({
      editorContent: "bad",
      dirty: true,
      validationErrors: ["Error"],
    });

    const { rerender } = render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <ConfigEditor />
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(screen.getByTestId("validation-errors")).toBeInTheDocument();

    // Fix the errors
    act(() => {
      useConfigStore.setState({
        editorContent: SAMPLE_YAML,
        dirty: true,
        validationErrors: [],
      });
    });

    rerender(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <ConfigEditor />
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(screen.queryByTestId("validation-errors")).not.toBeInTheDocument();
  });

  it("save button is disabled when content is not modified", () => {
    renderEditor();

    const saveButton = screen.getByTestId("save-button");
    expect(saveButton).toBeDisabled();
  });

  it("save button is disabled when validation errors are present", () => {
    useConfigStore.setState({
      dirty: true,
      editorContent: "bad",
      validationErrors: ["Error"],
    });

    renderEditor();

    const saveButton = screen.getByTestId("save-button");
    expect(saveButton).toBeDisabled();
  });

  it("save button is enabled when dirty and no validation errors", () => {
    useConfigStore.setState({
      dirty: true,
      editorContent: SAMPLE_YAML + "\n# edit",
      validationErrors: [],
    });

    renderEditor();

    const saveButton = screen.getByTestId("save-button");
    expect(saveButton).not.toBeDisabled();
  });

  it("clicking save shows a loading state and then a success result", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    mockSaveConfig.mockResolvedValue({
      success: true,
      reload: { success: true, errors: [], changes: ["Restarted api"] },
    });

    // Override fetchConfig to prevent it from resetting state on mount
    useConfigStore.setState({
      dirty: true,
      editorContent: SAMPLE_YAML + "\n# edit",
      validationErrors: [],
      fetchConfig: vi.fn() as unknown as () => Promise<void>,
    });

    renderEditor();

    const saveButton = screen.getByTestId("save-button");
    await user.click(saveButton);

    // After save completes
    await waitFor(() => {
      expect(screen.getByTestId("save-success")).toBeInTheDocument();
    });
  });

  it("shows reload errors when save succeeds but hot-reload has failures", () => {
    useConfigStore.setState({
      dirty: false,
      editorContent: SAMPLE_YAML + "\n# edit",
      saveSuccess: "Config saved successfully",
      reloadResult: {
        success: false,
        errors: ["Failed to restart service: api"],
        changes: ["Updated DNS"],
      },
    });

    renderEditor();

    expect(screen.getByTestId("reload-errors")).toBeInTheDocument();
    expect(screen.getByText("Failed to restart service: api")).toBeInTheDocument();
  });

  it("discard button reverts to last loaded content", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    // Override fetchConfig to prevent it from resetting state on mount
    useConfigStore.setState({
      dirty: true,
      editorContent: "modified content",
      validationErrors: ["Some error"],
      fetchConfig: vi.fn() as unknown as () => Promise<void>,
    });

    renderEditor();

    const discardButton = screen.getByTestId("discard-button");
    await user.click(discardButton);

    await waitFor(() => {
      const editor = screen.getByTestId("yaml-editor") as HTMLTextAreaElement;
      expect(editor.value).toBe(SAMPLE_YAML);
    });

    expect(screen.queryByTestId("validation-errors")).not.toBeInTheDocument();
  });

  it("dirty indicator is visible when unsaved changes exist", () => {
    useConfigStore.setState({
      dirty: true,
      editorContent: SAMPLE_YAML + "\n# modified",
    });

    renderEditor();

    expect(screen.getByTestId("dirty-indicator")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("dirty indicator is not visible when content is not modified", () => {
    renderEditor();

    expect(screen.queryByTestId("dirty-indicator")).not.toBeInTheDocument();
  });

  it("discard button is disabled when not dirty", () => {
    renderEditor();

    const discardButton = screen.getByTestId("discard-button");
    expect(discardButton).toBeDisabled();
  });
});

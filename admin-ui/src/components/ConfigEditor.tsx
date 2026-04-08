/**
 * YAML config editor with live validation, save, and discard functionality.
 *
 * Loads the current flaregun.yml content, provides a monospace text editor,
 * validates on the fly via debounced API calls, and saves with hot-reload feedback.
 */

import { useEffect } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Paper from "@mui/material/Paper";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import SaveIcon from "@mui/icons-material/Save";
import UndoIcon from "@mui/icons-material/Undo";
import { useConfigStore } from "../stores/useConfigStore";

export function ConfigEditor() {
  const loaded = useConfigStore((s) => s.loaded);
  const editorContent = useConfigStore((s) => s.editorContent);
  const dirty = useConfigStore((s) => s.dirty);
  const validationErrors = useConfigStore((s) => s.validationErrors);
  const validating = useConfigStore((s) => s.validating);
  const saving = useConfigStore((s) => s.saving);
  const saveSuccess = useConfigStore((s) => s.saveSuccess);
  const reloadResult = useConfigStore((s) => s.reloadResult);
  const saveErrors = useConfigStore((s) => s.saveErrors);
  const fetchConfig = useConfigStore((s) => s.fetchConfig);
  const setEditorContent = useConfigStore((s) => s.setEditorContent);
  const save = useConfigStore((s) => s.save);
  const discard = useConfigStore((s) => s.discard);

  // Load config on mount
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  if (!loaded) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
        <CircularProgress data-testid="config-loading" />
      </Box>
    );
  }

  const hasValidationErrors = validationErrors.length > 0;
  const saveDisabled = !dirty || hasValidationErrors || saving;
  const hasReloadErrors = reloadResult && !reloadResult.success && reloadResult.errors.length > 0;

  return (
    <Box data-testid="config-editor">
      {/* Header row */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="h5">Config Editor</Typography>
          {dirty && (
            <Chip
              label="Unsaved changes"
              color="warning"
              size="small"
              data-testid="dirty-indicator"
            />
          )}
          {validating && (
            <Chip
              label="Validating…"
              size="small"
              variant="outlined"
              data-testid="validating-indicator"
            />
          )}
        </Box>

        <Box sx={{ display: "flex", gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<UndoIcon />}
            disabled={!dirty}
            onClick={discard}
            data-testid="discard-button"
          >
            Discard
          </Button>
          <Button
            variant="contained"
            startIcon={saving ? <CircularProgress size={18} color="inherit" /> : <SaveIcon />}
            disabled={saveDisabled}
            onClick={save}
            data-testid="save-button"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </Box>
      </Box>

      {/* Editor area */}
      <Paper variant="outlined" sx={{ mb: 2 }}>
        <Box
          component="textarea"
          value={editorContent ?? ""}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            setEditorContent(e.target.value)
          }
          data-testid="yaml-editor"
          spellCheck={false}
          sx={{
            width: "100%",
            minHeight: 400,
            p: 2,
            fontFamily: "monospace",
            fontSize: "0.875rem",
            lineHeight: 1.6,
            border: "none",
            outline: "none",
            resize: "vertical",
            backgroundColor: "transparent",
            color: "text.primary",
            boxSizing: "border-box",
          }}
        />
      </Paper>

      {/* Validation errors */}
      {hasValidationErrors && (
        <Alert severity="error" data-testid="validation-errors" sx={{ mb: 2 }}>
          <AlertTitle>Validation Errors</AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {validationErrors.map((error, i) => (
              <li key={i} data-testid={`validation-error-${i}`}>
                {error}
              </li>
            ))}
          </Box>
        </Alert>
      )}

      {/* Save errors */}
      {saveErrors.length > 0 && (
        <Alert severity="error" data-testid="save-errors" sx={{ mb: 2 }}>
          <AlertTitle>Save Failed</AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {saveErrors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </Box>
        </Alert>
      )}

      {/* Save success */}
      {saveSuccess && !hasReloadErrors && (
        <Alert severity="success" data-testid="save-success" sx={{ mb: 2 }}>
          {saveSuccess}
          {reloadResult && reloadResult.changes.length > 0 && (
            <Box component="ul" sx={{ m: 0, mt: 1, pl: 2 }}>
              {reloadResult.changes.map((change, i) => (
                <li key={i}>{change}</li>
              ))}
            </Box>
          )}
        </Alert>
      )}

      {/* Save success with reload errors */}
      {saveSuccess && hasReloadErrors && (
        <Box data-testid="reload-errors">
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>Config saved, but some changes failed to apply</AlertTitle>
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {reloadResult!.errors.map((error, i) => (
                <li key={i}>{error}</li>
              ))}
            </Box>
            {reloadResult!.changes.length > 0 && (
              <>
                <Typography variant="body2" sx={{ mt: 1, fontWeight: "bold" }}>
                  Applied changes:
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 2 }}>
                  {reloadResult!.changes.map((change, i) => (
                    <li key={i}>{change}</li>
                  ))}
                </Box>
              </>
            )}
          </Alert>
        </Box>
      )}
    </Box>
  );
}

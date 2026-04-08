# Step 015: Admin UI Config Editor & Log Viewer

## Files Created/Modified
- `admin-ui/src/types.ts` — Added ConfigValidateResponse, HotReloadResult, ConfigSaveResponse, LogEntry, LogStreamMessage, LogHistoryMessage, LogServerMessage
- `admin-ui/src/api/client.ts` — Added validateConfig(), saveConfig(), getLogWebSocketUrl()
- `admin-ui/src/stores/useConfigStore.ts` — Expanded from basic config fetch to full editor store with dirty tracking, debounced validation (400ms), save/discard actions
- `admin-ui/src/stores/useLogStore.ts` — New store for WebSocket log streaming with buffer cap (2000 entries), reconnection, service selection
- `admin-ui/src/components/ConfigEditor.tsx` — Full editor with textarea, live validation errors, save/discard buttons, dirty indicator
- `admin-ui/src/components/LogViewer.tsx` — Real-time log viewer with service selector, auto-scroll with pause, connection status

## Testing Patterns
- Config editor tests need to override `fetchConfig` with `vi.fn()` in store state when pre-setting dirty state, otherwise the useEffect on mount resets state
- Log viewer tests need to override `connect`/`disconnect` with `vi.fn()` to avoid real WebSocket creation
- FakeWebSocket class pattern works well for WebSocket store tests — store instances array, simulateOpen(), simulateMessage(), simulateError()
- MUI buttons with pointer-events: none when disabled — use `fetchConfig: vi.fn()` override instead of trying to bypass pointer-events check
- When testing empty state with "no service selected", must also clear availableServices to prevent auto-select useEffect

## Key Constants
- VALIDATE_DEBOUNCE_MS = 400
- MAX_LOG_ENTRIES = 2000
- RECONNECT_DELAY_MS = 2000
- COMBINED_SERVICE = "__all__"

## WebSocket Protocol
- Client sends: `{ type: "subscribe", service: "name" | "__all__" }`
- Server sends: `{ type: "history", entries: [...] }` and `{ type: "log", timestamp, service, source, line }`
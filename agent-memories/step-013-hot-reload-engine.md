# Step 013: Hot-Reload Engine

## Files Created
- `src/sync/hot-reload.ts` — Hot-reload engine implementation (createHotReloadEngine factory + applyHotReload + processServiceModification)
- `tests/sync/hot-reload.test.ts` — 32 tests covering all change categories, error handling, and lock file management

## Key Design Decisions
- **Factory function**: `createHotReloadEngine(deps)` returns an `IHotReloadEngine` (interface from `src/admin/types.ts`). Persistent deps (credentials, saveLock, adminPort) are captured at construction; per-reload deps (client, lockState, supervisor) are passed to `reload()`.
- **Delegates to existing sync functions**: Uses `syncAccessApplications` + `syncAccessPolicies` (step 004) and `syncTunnelIngress` (step 005) directly — no reimplementation of Cloudflare logic.
- **Error resilience**: Every action is wrapped in try/catch. Errors are collected in a result object (`HotReloadResult`). The engine never throws.
- **Domain check first**: Domain change detection happens before computing the diff, since `diffConfigs` doesn't detect domain changes (it only diffs services and auth).
- **Service restart via stop+start**: For port/command changes, the engine calls `supervisor.stopService()` then `supervisor.startService()` with the new config (since `restartService` doesn't accept a new config).
- **max_retries**: No restart needed — just records the change. The supervisor will use the new value on next crash.
- **Pages-only changes**: Explicitly recognized and skipped with an informational message.
- **Lock file**: Saved once at the end if any Cloudflare resources were modified (`cloudflareModified` flag).

## Test Pattern
- Mock supervisor records calls (`startService`, `stopService`, `restartService`) and supports `setFailOn()` for error injection.
- Uses `createMockClient()` from `tests/helpers/mock-client.ts` for Cloudflare API mocking.
- Lock save callback records copies of lock state for assertions.
- Helper functions: `baseConfig()`, `localService()`, `pagesService()` for DRY test config creation.

## Change Category → Action Mapping
| Change | Actions |
|--------|---------|
| Service added (local) | supervisor.startService + syncAccessApplications/Policies (if non-public) + syncTunnelIngress |
| Service added (pages) | syncAccessApplications/Policies (if non-public) only |
| Service removed (local) | supervisor.stopService + syncAccessApplications/Policies (if non-public) + syncTunnelIngress |
| Service removed (pages) | syncAccessApplications/Policies (if non-public) only |
| Port changed | stop+start + syncTunnelIngress |
| Command changed | stop+start |
| Auth changed | syncAccessApplications + syncAccessPolicies |
| Users changed | syncAccessApplications + syncAccessPolicies |
| max_retries changed | No-op (takes effect on next crash) |
| Superusers changed | syncAccessApplications + syncAccessPolicies for all services |
| Provider changed | Log note (manual portal action needed) |
| Pages-only fields | No-op (informational message) |
| Domain changed | Return error (requires full restart) |

## HotReloadDeps Interface
```typescript
interface HotReloadDeps {
  credentials: SyncCredentials;  // { accountId, zoneId, tunnelId }
  saveLock: SaveLockFn;          // (state: LockState) => void
  adminPort: number;             // For ingress rules
}
```
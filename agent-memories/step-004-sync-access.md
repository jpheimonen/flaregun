# Step 004: Sync Engine — Access Applications and Policies

## New Modules

### `src/sync/access.ts`
- **`syncAccessApplications(client, config, accountId, lockState)`** → `ManagedApp[]`
  - Lists existing Access apps via paginated SDK API
  - Creates apps for services with `admin_only` or `authorized` auth
  - Always creates implicit admin app (`admin.<domain>`) using lock key `ADMIN_LOCK_KEY = "__admin"`
  - Deletes stale apps (in lock state but not in desired set) via SDK delete
  - Stores app IDs in `lockState.access[key]`
  - Returns managed apps list for policy sync

- **`syncAccessPolicies(client, config, accountId, managedApps)`** → void
  - For each managed app, builds selectors via `buildServiceSelectors` from config module
  - For implicit admin: uses superusers only (admin_only auth)
  - Creates/updates/skips policies based on JSON comparison of selectors

- **`collectPages<T>(iterable)`** — pagination helper for Cloudflare SDK async iterables
- **`ADMIN_LOCK_KEY`** = `"__admin"` — constant for implicit admin lock state key

### `tests/helpers/mock-client.ts` (shared test utility)
- **`createMockClient()`** — mock Cloudflare SDK with call tracking, in-memory state
  - `getCalls(method)` — returns recorded calls for a method
  - `setApps/getApps`, `setPolicies/getPolicies` — state manipulation
  - Supports: list, create, update, delete for both applications and policies
  - App delete cascades to associated policies
  - Uses `mockPageResult()` for async iterable pagination
  - Incremental ID counter for unique mock IDs
  - Designed for extension by steps 005, 006 (tunnel, DNS, redirect, resources)

### `tests/helpers/fixtures.ts`
- **`makeConfig(overrides?)`** — builds valid `FlaregunConfig` with defaults
- **`pagesService(subdomain, auth, extra?)`** — quick Pages service config
- **`localService(subdomain, port, auth, extra?)`** — quick local service config
- **`TEST_ACCOUNT_ID`**, `TEST_TUNNEL_ID`, `TEST_ZONE_ID` — test constants

## Test Patterns
- Tests in `tests/sync/access.test.ts` (29 tests)
- Helper functions: `runAppSync`, `runPolicySync`, `runFullAccessSync`
- Mock client cast: `mockClient.client as unknown as Parameters<typeof syncFn>[0]`
- Lock state via `emptyState()` from lock module
- Tests cover: creation, idempotency, deletion, auth mode changes, policy updates

## Key Design Decisions
- Lock state modified in-place; caller saves to disk
- `__admin` key avoids collision with user service names (admin subdomain is reserved)
- Deletion logic: compare desired set against ALL lock state entries
- Selector comparison uses `JSON.stringify` (same as personal-homepage reference)

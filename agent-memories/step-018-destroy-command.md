# Step 018: Destroy Command

## Files Created
- `src/destroy/index.ts` — Complete destroy command handler with DI, confirmation prompt, sequential teardown
- `tests/destroy.test.ts` — 57 tests covering all acceptance criteria

## Files Modified
- `src/cli/index.ts` — Added `destroy` case to command dispatch switch
- `tests/helpers/mock-client.ts` — Extended with tunnel delete, Pages project delete, Worker script delete methods + state stores

## Key Design
- **DestroyCommandDeps interface**: All dependencies injectable (loadConfig, loadEnv, loadLock, saveLock, createClient, confirmFn, destroyResources, stdout, stderr)
- **ConfirmFn type**: `(domain: string, summary: string) => Promise<boolean>` — tests pass mock, production uses stdin
- **Sequential teardown order**: Access → Tunnel → DNS → Redirects → Worker → Pages → Cloud Resources (D1/R2/KV)
- **Continue-on-failure**: Each category catches errors, records them, continues to next category
- **Lock file saves after each category**: Progress preserved if interrupted
- **Final cleanup**: All succeed → clearState(); some fail → clean up empty entries, keep failures

## Mock Client Extensions
- `zeroTrust.tunnels.cloudflared.delete(tunnelId, { account_id, body })` → tracked as "tunnels.cloudflared.delete"
- `pages.projects.delete(projectName, { account_id })` → tracked as "pages.projects.delete"
- `workers.scripts.delete(scriptName, { account_id })` → tracked as "workers.scripts.delete"
- New types: `MockPagesProject`, `MockWorkerScript`, `MockTunnel`
- New state manipulators: `setPagesProjects/getPagesProjects`, `setWorkerScripts/getWorkerScripts`, `setTunnels/getTunnels`

## SDK Method Signatures Used
- Access: `client.zeroTrust.access.applications.delete(appId, { zone_id })`
- Tunnel: `client.zeroTrust.tunnels.cloudflared.delete(tunnelId, { account_id, body: {} })`
- DNS: `client.dns.records.delete(recordId, { zone_id })` (via type assertion)
- Worker: `client.workers.scripts.delete(scriptName, { account_id })`
- Pages: `client.pages.projects.delete(projectName, { account_id })`
- D1/R2/KV: Delegated to `destroyResources` from `src/sync/provision.ts`

## Test Count
57 new tests in 1 file. 628 total across 29 non-admin-ui files (all passing).
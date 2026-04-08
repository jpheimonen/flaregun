# Step 005: Sync Engine — Tunnel Ingress, DNS, Redirects, Full Sync

## New Modules

### `src/naming.ts`
- **`resourceName(domain, serviceName)`** → deterministic base name
  - Format: `{domain-dots-to-hyphens}-{serviceName}`, all lowercase
  - Sanitizes: strips invalid chars, collapses hyphens, trims leading/trailing hyphens
  - Truncates to 63 chars (R2 bucket max) without trailing hyphens
  - Used by DNS sync (Pages project pages.dev addresses), resource provisioner (step 006), wrangler config (step 007)

### `src/sync/ingress.ts`
- **`syncTunnelIngress(client, config, accountId, tunnelId, adminPort)`** → void
  - Builds ingress for all `local` services (not pages)
  - Adds implicit `admin.domain → http://localhost:adminPort`
  - Sorts alphabetically by hostname
  - Appends catch-all `{ hostname: "", service: "http_status:404" }`
  - Full replacement via `client.zeroTrust.tunnels.cloudflared.configurations.update()`

### `src/sync/dns.ts`
- **`syncDnsRecords(client, config, zoneId, tunnelId)`** → void
  - Wildcard CNAME: `*.domain → tunnelId.cfargotunnel.com`
  - Per-Pages CNAME: `subdomain.domain → resourceName(domain, name).pages.dev`
  - www CNAME: points to first Pages service (prefers subdomain "www", falls back to alphabetical first)
  - Removal: deletes stale CNAMEs pointing to *.pages.dev (not wildcard/www)
  - Uses `collectPages` from access module, `resourceName` from naming module

### `src/sync/redirects.ts`
- **`syncRedirectRule(client, config, zoneId)`** → void
  - Expression: `(http.host eq "domain")` → `https://www.domain` 301
  - Reads existing `http_request_dynamic_redirect` phase ruleset (catches error if none)
  - Preserves existing rules, appends new redirect with `preserve_query_string: true`
  - Type assertion: `as Parameters<typeof client.rulesets.phases.update>[1]`

### `src/sync/index.ts`
- **`syncFull(client, config, credentials, lockState, saveLock, adminPort)`** → `SyncResult`
  - Runs 5 steps in order: access apps → access policies → tunnel ingress → DNS → redirects
  - `saveLock(lockState)` called after each step
  - Redirect step is non-fatal (catches error, records as failed step)
  - Returns `{ steps: StepResult[] }` with step name, success, and optional error

## Mock Client Extensions (tests/helpers/mock-client.ts)
- **Tunnel**: `tunnelConfig.update` tracked, stores config in memory
- **DNS**: `dns.records.list/create/update/delete` tracked, in-memory `MockDnsRecord[]`
  - `setDnsRecords()` / `getDnsRecords()` for test setup
- **Redirects**: `rulesets.phases.get/update` tracked, in-memory `MockRedirectRuleset`
  - `setRedirectRuleset()` / `getRedirectRuleset()` for test setup
  - `get` throws when no ruleset exists (matches production)

## Test Files
- `tests/naming.test.ts` — 11 tests for resourceName
- `tests/sync/ingress.test.ts` — 8 tests for tunnel ingress
- `tests/sync/dns.test.ts` — 10 tests for DNS records
- `tests/sync/redirects.test.ts` — 6 tests for redirect rules
- `tests/sync/full-sync.test.ts` — 8 tests for full sync orchestrator

## Key Patterns
- Mock client cast: `mockClient.client as unknown as Parameters<typeof syncFn>[0]`
- Lock state modified in-place by sync functions, caller saves via callback
- `SyncCredentials` type: `{ accountId, zoneId, tunnelId }`
- DNS deletion only targets CNAMEs pointing to `*.pages.dev` (managed by flaregun)

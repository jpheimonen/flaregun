# Research

## Source Project Analysis

Flaregun extracts and generalizes the infrastructure management patterns from the `personal-homepage` project (`../personal-homepage`). This document catalogs what exists, what can be reused, and what gaps need to be addressed.

### Project Structure

The personal-homepage project is a Bun monorepo managing a single domain (`heimonen.cc`) on Cloudflare:

```
personal-homepage/
  config.yaml                    # Domain config (services, auth, subdomains)
  .env.example                   # Required environment variables template
  package.json                   # Bun project, deps: cloudflare, js-yaml
  Makefile                       # Targets: install, up, deploy, sync, down
  scripts/
    up.ts                        # Orchestration: sync → services → tunnel
    sync.ts                      # Cloudflare state sync (Access, DNS, Tunnel, Redirects)
    deploy.ts                    # Pages + Worker deployment via wrangler CLI
    lib/
      config.ts                  # YAML parsing, validation, Access selector utilities
      process.ts                 # Command runner, binary existence checker
    sync.test.ts                 # 1223-line test suite with mock Cloudflare SDK
    up.test.ts                   # Orchestration tests with dependency injection
    lib/config.test.ts           # Config validation tests
  worker/
    src/index.ts                 # Fallback Worker (down page, proxy, passthrough)
    src/index.test.ts            # Worker tests with injectable fetch
    wrangler.toml                # Worker config (hardcoded to heimonen.cc)
  projects/
    homepage/                    # Static homepage (index.html)
    admin/                       # Admin placeholder (index.html + docker-compose)
    music/                       # Complex sub-project (React frontend + Java backend)
```

### Key Dependencies

From `package.json`:
- `cloudflare` ^4.2.0 — Official Cloudflare TypeScript SDK
- `js-yaml` ^4.1.0 — YAML parsing
- `@types/bun` — Bun type definitions
- `@types/js-yaml` — YAML type definitions
- Test runner: Bun's built-in `bun test`

## Reusable Patterns

### 1. Config System (`scripts/lib/config.ts`)

**What exists:**
- `Config` type with `domain`, `auth` (provider, superusers, branding), and `services` (Record<string, ServiceConfig>)
- `ServiceConfig` with `subdomain`, `port`, `command`, `auth` ("required" | "none"), `users`
- `validateConfig()` with eager error collection — gathers ALL errors before throwing `ConfigValidationError`
- Duplicate port detection, duplicate subdomain detection, required field validation
- `loadConfig()` reads from filesystem, `parseConfig()` accepts YAML string (testable)
- Access selector utilities: `mergeUsers()`, `toAccessSelectors()`, `buildServiceSelectors()`, `isWildcard()`, `extractWildcardDomain()`

**What changes for flaregun:**
- No explicit `type` field — infer from properties (`dist` → Pages, `command` + `port` → local)
- Add `dist`, `build`, `functions`, `database`, `bucket`, `kv`, `max_retries` to service config
- Auth modes change from "required"/"none" to "admin_only"/"authorized"/"public"
- Add reserved subdomain validation (`admin`, `down`)
- Add `down_page` optional field at top level
- Config file name changes from `config.yaml` to `flaregun.yml`

**Reusable as-is:**
- Eager error collection pattern (collect errors → throw at end)
- `ConfigValidationError` class with `errors: string[]`
- User/selector utilities: `mergeUsers()`, `toAccessSelectors()`, `isWildcard()`, `extractWildcardDomain()`
- Duplicate port/subdomain detection logic

### 2. Sync Engine (`scripts/sync.ts`)

**What exists — five sync steps:**

1. **`syncAccessApplications()`** — Creates Cloudflare Access self-hosted applications per auth-protected service. Iterates existing apps (paginated), checks if one exists for the subdomain, creates if missing.

2. **`syncAccessPolicies()`** — Creates/updates Access policies with email + email_domain selectors. Merges superusers with per-service user lists. Checks existing policies and only creates if none exist.

3. **`syncTunnelIngress()`** — Pushes ingress rules mapping `subdomain.domain` → `http://localhost:port`. Rules sorted alphabetically. Includes catch-all `http_status: 404` rule. Uses `cloudflare.zeroTrust.tunnels.configurations.update()`.

4. **`syncDnsRecords()`** — Creates wildcard CNAME (`*` → tunnel UUID `.cfargotunnel.com`) and www CNAME (→ Pages project `.pages.dev`). Checks existing records before creating.

5. **`syncRedirectRule()`** — Creates/updates a redirect ruleset for bare domain → `www.domain` (301 redirect). Uses Cloudflare Rulesets API.

**Environment variables required:**
- `CLOUDFLARE_API_TOKEN` — API authentication
- `CLOUDFLARE_ACCOUNT_ID` — Account scope
- `CLOUDFLARE_TUNNEL_ID` — Tunnel for ingress rules
- `CLOUDFLARE_ZONE_ID` — DNS zone for records and rules

**Critical gap — no removal handling:**
The existing sync engine only creates and updates. It does NOT delete stale resources when a service is removed from config. Flaregun's sync engine needs bidirectional diffing:
- Compare current config vs previous config (or vs live Cloudflare state)
- Delete Access apps/policies for removed services
- Remove tunnel ingress rules for removed services
- Clean up DNS records for removed services

**Reusable patterns:**
- Step-based sync architecture (each resource type is an independent sync step)
- Idempotency checks (list existing → skip if present)
- Cloudflare SDK usage patterns for each resource type
- Environment variable validation

### 3. Orchestration (`scripts/up.ts`)

**What exists:**
- `checkPrerequisites()` — validates env vars + binary availability (`cloudflared`, `docker`)
- `orchestrate(config, tunnelToken, deps)` — sync → launch services → start tunnel
- `launchService()` — spawns child process, waits 500ms for immediate failure detection
- Signal handling (SIGINT/SIGTERM) for graceful cleanup
- Blocks on tunnel process (`await tunnelProc.exited`)
- **Dependency injection** via `UpDeps` interface (`syncFn`, `launchServiceFn`, `spawnTunnel`)

**What changes for flaregun:**
- Add process supervision (auto-restart, exponential backoff, max_retries)
- Add service state tracking (starting → running → crashed → restarting → stopped)
- Add stdout/stderr capture for log tailing (currently uses `"inherit"`)
- Add admin UI as implicit local service
- Replace `docker` prerequisite check with just `cloudflared` + `wrangler`

**Reusable patterns:**
- Dependency injection for testability (`UpDeps` interface)
- Prerequisites validation pattern
- Signal handling for cleanup
- Orchestration sequencing (sync first, then services, then tunnel)

### 4. Deploy Pipeline (`scripts/deploy.ts`)

**What exists:**
- `deployHomepage()` — runs `wrangler pages deploy ./projects/homepage --project-name=heimonen-cc-homepage`, creates project if 404
- `deployWorker()` — runs `wrangler deploy` in the `worker/` directory
- `checkDeployPrerequisites()` — validates `wrangler` binary and env vars
- `copyVideoIfNeeded()` — project-specific file copy (the "nonsense" to abstract away)
- Uses `runCommand()` from `process.ts` for shell execution

**What changes for flaregun:**
- Deploy all Pages services (not just homepage)
- Generate wrangler.toml per service (not use existing ones)
- Provision cloud resources (D1/R2/KV) before deploy
- Copy functions/ into dist/functions/ before wrangler deploy
- Generate and deploy the fallback Worker from templates
- Store provisioned resource IDs in flaregun.lock

**Reusable patterns:**
- Binary prerequisite check (`wrangler`)
- `wrangler pages deploy` invocation pattern
- Project creation on first deploy (handle 404)

### 5. Fallback Worker (`worker/src/index.ts`)

**What exists:**
- `handleRequest(request, originFetch)` — main request handler with injectable fetch for testing
- Routing logic:
  - Bare domain + `www` → pass through to origin (Pages)
  - `down` subdomain → serve inline HTML directly
  - All other subdomains → proxy to origin, redirect to down page on 5xx or network error
- `DOWN_PAGE_HTML` — inline HTML string with hardcoded `heimonen.cc` references
- `wrangler.toml` with wildcard route: `*.heimonen.cc/*`

**What changes for flaregun:**
- Template the Worker source code (replace hardcoded domain with variable)
- Template the down page HTML (replace hardcoded domain name and branding)
- Support custom down page HTML file (via `down_page` config field)
- Generate wrangler.toml from template (domain-specific name and route pattern)
- Both Worker source and wrangler.toml are internal artifacts generated by flaregun

**Reusable patterns:**
- Request routing logic (hostname parsing, subdomain detection)
- Proxy-with-fallback pattern (try origin, redirect on failure)
- Injectable fetch for testability

### 6. Process Utilities (`scripts/lib/process.ts`)

**What exists:**
- `binaryExists(name)` — checks if a binary is on PATH via `which` command
- `runCommand(args, cwd)` — spawns a process, collects stdout/stderr, returns `{exitCode, stdout, stderr}`
- `CommandRunner` type for dependency injection in tests

**Reusable as-is:** Both utilities transfer directly to flaregun.

## Testing Patterns

### Mock Cloudflare SDK (`scripts/sync.test.ts` — 1223 lines)

The sync test suite demonstrates the testing pattern flaregun should follow:

**`createMockClient()`** — factory function returning a mock Cloudflare SDK client with:
- Call tracking arrays for each API method (e.g., `accessAppsCreateCalls`, `dnsCreateCalls`)
- In-memory state stores (Maps/arrays) for apps, policies, DNS records, tunnel config
- Simulated async iterable pagination via `mockPageResult()` helper
- All SDK methods return realistic response shapes

**Test organization:**
- Separate step functions mirror production code: `syncAppsStep()`, `syncPoliciesStep()`, `syncIngressStep()`, `syncDnsStep()`, `syncRedirectStep()`
- Full integration test via `runFullSync()`
- Each step is independently testable

**Key test scenarios:**
- **Idempotency**: Second sync run makes zero create calls
- **Addition**: New service added to config → new Access app/policy created
- **Selector construction**: Superusers-only, combined user lists, wildcard domain selectors
- **Environment validation**: Missing env vars produce descriptive errors
- **Environment save/restore**: Tests that modify `process.env` clean up after themselves

**Worker tests (`worker/src/index.test.ts`):**
- Injectable `originFetch` function replaces real `fetch`
- Test each routing branch independently (bare domain, www, down, other subdomains)
- Test error scenarios (5xx responses, network failures)

## Gaps and New Functionality

### Must Build from Scratch

1. **Service type inference** — Parse config properties to determine if service is Pages or local (no existing code for this)
2. **Cloud resource provisioning** — D1, R2, KV creation via Cloudflare API (not in existing project)
3. **Lock file management** — `flaregun.lock` read/write/update with resource ID tracking
4. **Wrangler config generation** — Template-based `wrangler.toml` generation per Pages project with resource bindings
5. **Functions directory management** — Copy `functions/` → `dist/functions/`, scaffold if missing
6. **Process supervision** — Exponential backoff, restart counting, state machine (starting/running/crashed/restarting/stopped)
7. **Log capture** — Capture stdout/stderr streams for real-time tailing (existing code uses `"inherit"`)
8. **Admin UI** — Full React SPA (config editor, service dashboard, log viewer, WebSocket streaming)
9. **Admin UI backend** — Bun HTTP server with REST endpoints + WebSocket for log streaming
10. **Hot-reload engine** — Config diff detection, granular Cloudflare re-sync on config change
11. **Setup wizard** — Interactive guided setup for first-time Cloudflare configuration
12. **Destroy command** — Tear down all Cloudflare resources with confirmation
13. **Sync removals** — Bidirectional diff to detect and clean up removed services
14. **CLI framework** — Command parsing, help text, argument handling (existing project uses `import.meta.main` scripts)
15. **Functions scaffolding** — Generate starter `functions/` with example handlers and tsconfig

### Existing Code to Adapt

1. **Config validation** — Extend with new fields, new auth modes, reserved subdomain checks, service type inference
2. **Sync engine** — Extend all 5 sync steps + add removal handling
3. **Orchestration** — Add process supervision, admin UI integration, log capture
4. **Deploy pipeline** — Generalize for multiple Pages services, add resource provisioning
5. **Fallback Worker** — Templatize (remove hardcoded domain references)
6. **Process utilities** — Reuse directly (`binaryExists`, `runCommand`)
7. **Access selector utilities** — Reuse directly (`mergeUsers`, `toAccessSelectors`, etc.)

## Cloudflare SDK Patterns

The existing code uses the `cloudflare` npm package (^4.2.0). Key SDK patterns observed:

### Pagination
```typescript
// Cloudflare SDK returns async iterables for list operations
for await (const app of client.zeroTrust.access.applications.list({ account_id })) {
  // process each app
}
```

In tests, this is mocked with:
```typescript
function mockPageResult<T>(items: T[]) {
  return { [Symbol.asyncIterator]: async function* () { for (const item of items) yield item; } };
}
```

### Resource Creation
```typescript
// Access applications
await client.zeroTrust.access.applications.create({
  account_id,
  name: "Service Name",
  domain: "sub.domain.com",
  type: "self_hosted",
  session_duration: "24h",
  // ...
});

// Access policies
await client.zeroTrust.access.applications.policies.create(appId, {
  account_id,
  name: "Policy Name",
  decision: "allow",
  include: [{ email: { email: "user@example.com" } }],
  // ...
});

// Tunnel configuration
await client.zeroTrust.tunnels.configurations.update(tunnelId, {
  account_id,
  config: { ingress: [...rules, { service: "http_status:404" }] },
});

// DNS records
await client.dns.records.create({ zone_id, type: "CNAME", name, content, proxied: true });
```

### Not Yet Used in Existing Code (Needed for Flaregun)
```typescript
// D1 database creation
await client.d1.database.create({ account_id, name: "..." });

// R2 bucket creation
await client.r2.buckets.create({ account_id, name: "..." });

// KV namespace creation
await client.kv.namespaces.create({ account_id, title: "..." });

// Resource deletion (for destroy command)
await client.zeroTrust.access.applications.delete(appId, { account_id });
await client.dns.records.delete(recordId, { zone_id });
// etc.
```

## Technology Decisions

### Runtime: Bun
The existing project runs entirely on Bun. Flaregun continues this — `bun test` for testing, `Bun.spawn()` for process management, Bun's built-in HTTP server for the admin UI backend.

### Cloudflare SDK vs REST API
The existing project uses the official `cloudflare` TypeScript SDK for all API operations. This provides type safety, automatic pagination, and maintained client. Flaregun should continue using the SDK.

For resource types not yet used (D1, R2, KV), the SDK supports them — verify against latest SDK docs during implementation.

### CLI Framework
The existing project has no CLI framework — scripts are invoked directly via `bun run scripts/up.ts`. Flaregun needs a proper CLI with subcommands (`up`, `down`, `deploy`, `build`, `setup`, `destroy`). Options include:
- **Commander.js** — mature, well-known
- **Yargs** — feature-rich, auto-generated help
- **Citty** — lightweight, modern
- **Custom** — minimal argument parsing (the project has simple commands with few flags)

Given the simplicity of flaregun's command surface (6 commands, minimal flags), a lightweight approach is appropriate.

### Admin UI Architecture
- **Backend**: Bun's built-in HTTP server (`Bun.serve()`) with native WebSocket support
- **Frontend**: React + Zustand + Material UI, pre-built and bundled with the CLI
- **Build**: Frontend built at development time, dist embedded in the npm package
- **Communication**: REST for CRUD operations, WebSocket for real-time log streaming

### Config Format
YAML via `js-yaml` (same as existing project). Config file name changes from `config.yaml` to `flaregun.yml`. Lock file is also YAML (`flaregun.lock`).

## Risk Areas

1. **Sync removal complexity** — Detecting removed services requires comparing against previous state. Options: diff against lock file, diff against live Cloudflare state, or diff against previous config snapshot.
2. **Hot-reload granularity** — Config changes can affect multiple Cloudflare resources. The diff engine needs to understand which config changes map to which sync steps.
3. **Process supervision reliability** — Exponential backoff + max_retries + state transitions need careful implementation to avoid zombie processes or restart storms.
4. **Admin UI bundling** — The React SPA needs to be pre-built and embedded in the CLI distribution. Build pipeline for this needs to be established early.
5. **Wrangler compatibility** — Generated wrangler.toml files need to stay compatible with wrangler CLI updates. Pin wrangler version or test against multiple versions.
6. **Pages custom domains** — Attaching custom subdomains to Pages projects requires the domain to be active in Cloudflare and DNS properly configured. The sync engine must handle the ordering (DNS first, then custom domain attachment).

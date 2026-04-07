# Architecture

## System Overview

Flaregun is a Bun-native CLI tool organized as a monorepo containing the CLI application and the admin UI frontend. The CLI is the primary entry point — it parses config, manages Cloudflare state, supervises local processes, serves the admin backend, and orchestrates deployments. The admin UI is a pre-built React SPA that the CLI serves as static assets over a Bun HTTP server.

The system has two operational modes:
1. **Runtime mode** (`flaregun up`) — long-running process that syncs Cloudflare, supervises services, serves the admin UI, and runs the tunnel
2. **One-shot mode** (`flaregun deploy`, `flaregun build`, `flaregun down`, `flaregun destroy`, `flaregun setup`) — executes a task and exits

## Components Affected

### 1. CLI Entry Point

The top-level command dispatcher. Parses the command name and any flags from process arguments, then delegates to the appropriate command handler. Handles `--help` and unknown commands gracefully.

Commands: `up`, `down`, `deploy`, `build`, `setup`, `destroy`.

The `build` and `deploy` commands accept an optional list of service names to operate on a subset (e.g., `flaregun build homepage blog`). When no names are given, they operate on all eligible services.

All commands except `setup` load and validate `flaregun.yml` before proceeding. `setup` generates the initial config file and `.env`, so it operates without them.

### 2. Config Loader

Responsible for reading `flaregun.yml`, parsing the YAML, validating all fields, and producing a strongly-typed config object that the rest of the system consumes.

**Validation rules (eager — collects all errors before failing):**
- Every service must have a unique subdomain
- Every local service must have a unique port
- Services with `dist` are classified as Pages services; services with `command` + `port` are classified as local services
- A service with both `dist` and `command`/`port` is invalid (ambiguous type)
- A service with neither `dist` nor `command`/`port` is invalid (unrecognizable type)
- `database`, `bucket`, and `kv` declarations are only valid on Pages services — error if declared on a local service
- Subdomains `admin` and `down` are reserved — error if a user service uses them
- Auth mode defaults to `admin_only` when not specified
- `users` list is only valid when auth mode is `authorized`
- At least one superuser must be declared in the auth section
- The identity provider field is required in the auth section

**Service type inference:** The config loader determines each service's type purely from its declared properties. It sets an internal classification (Pages vs local) that other components use. The user never sees or sets a "type" field.

**Config diffing:** The config loader also provides a comparison function that takes two parsed configs (old and new) and produces a structured diff describing which services were added, removed, or changed, and what specifically changed on each modified service. This diff drives the hot-reload engine.

### 3. Lock File Manager

Manages `flaregun.lock` — a YAML file tracking all provisioned Cloudflare resource IDs. The lock file is the system's memory of what has been created in Cloudflare.

**Contents tracked:**
- Pages project names (per service)
- D1 database IDs (per service)
- R2 bucket names (per service)
- KV namespace IDs (per service)
- Tunnel ID
- Access application IDs (per service)
- Fallback Worker name

**Operations:**
- Load from disk (or return empty state if file doesn't exist — first run)
- Save to disk after any mutation
- Look up a resource ID by service name and resource type
- Store a newly provisioned resource ID
- Remove entries for deleted services (used by destroy and sync removal)

The lock file is designed to be committed to git. It contains only Cloudflare resource identifiers, never secrets.

### 4. Environment Manager

Loads secrets from the `.env` file co-located with `flaregun.yml`. Validates that all required environment variables are present before any command that needs Cloudflare API access.

**Required variables:**
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_TUNNEL_TOKEN` (required for `up`, not for `deploy`)

Missing variables produce descriptive error messages telling the user exactly which variable is missing and suggesting `flaregun setup` if nothing is configured yet.

### 5. Cloudflare SDK Client

A thin wrapper around the official `cloudflare` npm package that initializes the SDK with credentials from the environment. All Cloudflare API operations go through this client.

The wrapper exposes the raw SDK client to the sync engine and resource provisioner — it does not add its own abstraction layer. Its value is centralizing client initialization and providing a seam for dependency injection in tests.

### 6. Sync Engine

The heart of flaregun's Cloudflare state management. Takes the parsed config, the lock file state, and the Cloudflare SDK client, then ensures Cloudflare's live state matches the config.

**Architecture: step-based, independently testable sync steps.** Each resource type has its own sync function, adapted from the patterns in the existing `personal-homepage` project:

**Step 1 — Access Applications:** For every service with non-public auth, ensure a Cloudflare Access self-hosted application exists for its subdomain. Lists existing applications, creates missing ones, and deletes applications for services that were removed from config. Application IDs are stored in the lock file.

**Step 2 — Access Policies:** For every Access application, ensure a policy exists with the correct set of allowed users. Superusers are always included. For `authorized` services, per-service users (exact emails and wildcard domains) are merged with superusers. Policies are updated when the user list changes. Policies are deleted when their parent application is removed.

**Step 3 — Tunnel Ingress:** Pushes the full set of ingress rules to the tunnel configuration. Every local service gets a rule mapping `subdomain.domain` → `http://localhost:port`. The admin UI gets an implicit rule for `admin.domain` → the admin backend's port. Rules are sorted alphabetically for deterministic ordering. A catch-all 404 rule is always appended. This is a full replacement operation (not incremental) — the entire ingress config is pushed each time.

**Step 4 — DNS Records:** Ensures a wildcard CNAME record exists pointing to the tunnel's `.cfargotunnel.com` address. Ensures per-Pages-service CNAME records exist for their custom domains. Lists existing DNS records before creating to maintain idempotency.

**Step 5 — Redirect Rules:** Ensures a bare-domain-to-www redirect rule (301) exists via the Cloudflare Rulesets API.

**Removal handling (new for flaregun):** The sync engine compares the current config against the lock file to detect services that have been removed. For removed services, it deletes their Access applications/policies and removes their entries from the lock file. Tunnel ingress handles removals implicitly because the entire ingress config is replaced each time. DNS record removal is handled by comparing current CNAME records against the expected set.

**Sync ordering matters:** DNS records must exist before Pages custom domains can be attached. Access applications must be created before policies can be added to them. The sync engine executes steps in a fixed order that respects these dependencies.

### 7. Resource Provisioner

Handles creating and destroying Cloudflare cloud resources (D1 databases, R2 buckets, KV namespaces) via the Cloudflare SDK. Separate from the sync engine because resource provisioning happens at deploy time, not sync time.

**Provisioning flow:** For each Pages service that declares `database`, `bucket`, or `kv`, check the lock file for an existing resource ID. If none exists, create the resource via the API and store the new ID in the lock file. Resources use a naming convention derived from the domain and service name to be human-recognizable in the Cloudflare dashboard.

**Destruction flow:** For `flaregun destroy`, iterate all resource IDs in the lock file and delete them via the API. This includes D1 databases, R2 buckets, KV namespaces, Pages projects, the tunnel, Access applications, and the fallback Worker.

### 8. Deploy Pipeline

Orchestrates the full deployment of Pages services and the fallback Worker. Operates on one or more services specified by the user, or all Pages services if no filter is given.

**Per-service deploy sequence:**
1. Run the service's `build` command (if defined) — fail fast if the build fails
2. Check for `functions/` directory — if cloud resources are declared but no `functions/` exists, run the scaffolder
3. Copy the `functions/` directory into `dist/functions/` — if `functions/` exists (either user-created or just scaffolded)
4. Call the resource provisioner to create any missing D1/R2/KV resources
5. Generate an internal wrangler.toml file in a temporary location, configured with `pages_build_output_dir` pointing to the service's `dist`, and binding declarations for any provisioned resources (using IDs from the lock file)
6. Run `wrangler pages deploy` using the generated wrangler.toml
7. Attach the custom subdomain to the Pages project if not already attached

**Fallback Worker deploy:** Separately from Pages services, the deploy pipeline generates the fallback Worker source and wrangler.toml from templates (with the domain name injected), then runs `wrangler deploy`. If the config specifies a custom `down_page` HTML file, its contents are embedded in the generated Worker source.

**Parallelism:** Service deploys are independent and can run concurrently. The fallback Worker deploy is also independent. The deploy pipeline should run them in parallel where possible.

### 9. Functions Scaffolder

Creates a starter `functions/` directory for Pages services that declare cloud resources but don't have a `functions/` directory yet.

**Scaffold contents:**
- An example API handler file that demonstrates usage of the declared bindings (only the bindings that the service actually declared — e.g., if only `database: true`, the example only shows the database binding)
- A tsconfig.json that references the `@cloudflare/workers-types` package

**Trigger:** Scaffolding runs during `flaregun build` or `flaregun deploy`, after the build step but before the functions-copy step. It only scaffolds if the `functions/` source directory does not exist — it never overwrites existing files.

**Scaffolding location:** The scaffold creates the `functions/` directory at the path specified by the service's `functions` config field (defaulting to `functions/` relative to the project). This is the source directory, not inside `dist/`.

### 10. Wrangler Config Generator

Generates temporary wrangler.toml files for Pages projects and the fallback Worker. These files are internal artifacts — never placed in user-visible locations.

**For Pages projects:** Generates a wrangler.toml with the project name (derived from domain + service name), `pages_build_output_dir` pointing to the service's `dist` directory, and binding declarations for D1/R2/KV using the resource IDs from the lock file. Binding names use the conventions: `DB` for D1, `BUCKET` for R2, `KV` for KV.

**For the fallback Worker:** Generates a wrangler.toml with the Worker name (derived from domain), the wildcard route pattern for the domain, and the Worker's compatibility date.

Generated files are placed in a temporary directory and cleaned up after deployment.

### 11. Fallback Worker Generator

Produces the fallback Worker's TypeScript source code from a template. The template contains the routing logic (passthrough for root/www, serve down page for the `down` subdomain, proxy-with-fallback for all other subdomains) with the domain name injected as a variable rather than hardcoded.

If the config specifies a `down_page` custom HTML file, the generator reads that file and embeds its contents in the Worker source. Otherwise, it uses the built-in default down page HTML with the domain name substituted in.

The generated Worker source and wrangler.toml are written to a temporary directory, deployed via `wrangler deploy`, and cleaned up.

### 12. Process Supervisor

Manages the lifecycle of local services during `flaregun up`. Each local service runs as a child process spawned by the supervisor.

**Process lifecycle states:** starting → running → crashed → restarting → stopped

**Spawn behavior:** The supervisor spawns each service's `command` as a child process. After spawning, it waits briefly for an immediate crash (process exits within a short window after start). If the process survives the initial window, it transitions to `running`.

**Crash handling:** When a running process exits unexpectedly, the supervisor transitions it to `crashed`, then `restarting`. It re-spawns the process after an exponential backoff delay. The backoff resets when a process runs successfully for a sustained period. If `max_retries` is configured and exceeded, the service transitions to `stopped` and is not restarted again.

**Log capture:** The supervisor captures stdout and stderr streams from every child process. Captured output is stored in a rolling buffer (bounded size to prevent unbounded memory growth) and streamed to any connected WebSocket clients from the admin UI.

**Shutdown:** On `flaregun down` or SIGINT/SIGTERM, the supervisor sends termination signals to all child processes, waits for graceful exit (with a timeout), and force-kills any processes that don't exit in time.

**The admin UI is also a supervised process** — the admin backend server is started as part of `flaregun up` and managed by the same supervisor (though it's not user-configurable and always restarts).

### 13. Admin UI Backend

A Bun HTTP server that provides the admin UI's API and serves the pre-built frontend SPA.

**Responsibilities:**
- Serve the pre-built React SPA as static files (index.html, JS bundles, CSS)
- REST endpoints for config CRUD: read current config, validate proposed config changes, write config to disk
- REST endpoints for service management: list service statuses, restart a service, stop a service
- WebSocket endpoint for real-time log streaming: clients subscribe to one or more services and receive log lines as they're captured by the process supervisor
- Trigger hot-reload when config is saved: after writing the new config to disk, compute the diff between old and new config, then apply changes (start/stop services, re-sync Cloudflare state) via the sync engine and process supervisor

**Port selection:** The admin backend picks an available port at startup. This port is registered in the tunnel ingress rules for the `admin` subdomain. The port is not user-configurable — it's an implementation detail.

**Authentication:** The admin UI relies on Cloudflare Access for authentication. The admin backend itself does not implement auth — it's only accessible via the tunnel, which is behind the Cloudflare Access application for the `admin` subdomain with `admin_only` policy.

### 14. Admin UI Frontend

A React single-page application using Zustand for state management and Material UI for the component library.

**Views/features:**
- **Config editor:** A YAML text editor with live validation. Shows validation errors inline as the user types. A save button writes changes and triggers hot-reload. Shows a diff or summary of what will change before saving.
- **Service dashboard:** A list of all services (both Pages and local) showing their current status. Local services show state (running/crashed/stopped), uptime, and restart count. Pages services show deploy status from the lock file. Action buttons for restart and stop on local services.
- **Log viewer:** Real-time log output from local services. Connects via WebSocket. Supports switching between services or viewing a combined stream. Auto-scrolls to the bottom with a pause mechanism.
- **Tunnel status:** Shows whether the cloudflared tunnel connection is active or disconnected.

**Bundling:** The frontend is built at development/packaging time (not at runtime). The build output is embedded within the CLI package so that `flaregun up` can serve it without any build step. The build tooling for the frontend lives in the repository but is separate from the CLI's runtime.

### 15. Orchestrator (`up` command)

The `up` command's orchestration logic, responsible for sequencing the startup of all subsystems.

**Startup sequence:**
1. Load and validate config
2. Load the lock file (or initialize empty state)
3. Validate prerequisites: check that `cloudflared` is installed and on PATH, check that required environment variables are set
4. Run the sync engine (all 5 steps) to ensure Cloudflare state matches config
5. Start the admin UI backend (pick a port, begin serving)
6. Start all local services via the process supervisor
7. Start the cloudflared tunnel daemon (with the admin UI's port included in ingress rules)
8. Block on the tunnel process — when it exits or a signal is received, begin shutdown

**Shutdown sequence (on SIGINT/SIGTERM or `flaregun down`):**
1. Stop the cloudflared tunnel daemon
2. Stop all local services via the process supervisor (graceful with timeout, then force kill)
3. Stop the admin UI backend
4. Exit

**Signal handling:** The orchestrator installs handlers for SIGINT and SIGTERM that trigger the shutdown sequence. Multiple signals force an immediate exit.

### 16. Build Command

Runs build commands for specified (or all) Pages services without deploying.

**Sequence per service:**
1. Run the service's `build` command in the service's working directory
2. Check for `functions/` — scaffold if cloud resources declared but no `functions/` exists
3. Copy `functions/` into `dist/functions/`

Reports build success/failure per service. Exits with a non-zero code if any build fails.

### 17. Setup Wizard

An interactive terminal-based guide for first-time Cloudflare configuration. Walks the user through steps sequentially, prompting for input at each stage.

**Step 1 — API Token:** Displays instructions for creating a Cloudflare API token, including the exact permissions needed and a direct URL to the token creation page. Prompts the user to paste the token. Validates the token by making a test API call.

**Step 2 — Identity Provider:** Displays instructions for configuring an identity provider (Google OAuth, GitHub, etc.) in Cloudflare Access. Provides direct links to the relevant portal pages. This step requires manual portal configuration and cannot be fully automated.

**Step 3 — Tunnel Creation:** Uses the validated API token to programmatically create a Cloudflare Tunnel via the SDK. Stores the tunnel ID and token.

**Step 4 — Environment File:** Writes the `.env` file with all collected credentials (API token, account ID, zone ID, tunnel token).

**Step 5 — Starter Config:** Generates a minimal `flaregun.yml` with the user's domain, a basic auth section, and one example homepage service.

### 18. Destroy Command

Tears down all Cloudflare resources managed by flaregun.

**Safety:** Requires explicit confirmation from the user (e.g., typing the domain name) before proceeding. This is destructive and irreversible.

**Teardown sequence:**
1. Delete all Access applications and their policies
2. Delete the tunnel configuration and the tunnel itself
3. Delete all DNS records managed by flaregun (wildcard CNAME, per-service CNAMEs, redirect rules)
4. Delete the fallback Worker
5. Delete all Pages projects
6. Delete all D1 databases, R2 buckets, KV namespaces
7. Clear the lock file

Deletion failures for individual resources are logged but do not abort the overall teardown — the command attempts to clean up as much as possible.

### 19. Hot-Reload Engine

Handles config changes made via the admin UI's save action. When the admin backend receives a config save request, the hot-reload engine computes the impact and applies changes without a full restart.

**Diff-driven approach:** The engine compares the old config (before save) against the new config (after save) and categorizes changes:

- **Service added:** If it's a local service, start it via the process supervisor. Update tunnel ingress rules. Create Access application/policy if auth is non-public.
- **Service removed:** If it's a local service, stop it via the process supervisor. Remove its Access application/policy. Update tunnel ingress rules.
- **Service modified (auth changed):** Update or create/delete the Access application and policy.
- **Service modified (port changed):** Restart the local service on the new port. Update tunnel ingress rules.
- **Service modified (command changed):** Restart the local service with the new command.
- **Service modified (users changed):** Update the Access policy with the new user list.
- **Global auth changed (superusers, provider):** Update all Access policies.
- **Pages-only changes (dist, build, functions, database/bucket/kv):** These do not affect the running system — they only affect the next `flaregun deploy`. The engine takes no runtime action for these changes.

After applying all changes, the engine saves the lock file if any Cloudflare resources were modified.

## New Entities

### Config Object

The parsed representation of `flaregun.yml`. Contains the domain name, auth configuration (provider, superusers), optional custom down page path, and a map of service definitions. Each service definition carries its name, subdomain, inferred type (Pages or local), and all type-specific fields. The config object is immutable once parsed — modifications go through the config file, not the object.

### Lock File State

The in-memory representation of `flaregun.lock`. A structured object mapping service names to their provisioned resource IDs, plus top-level entries for the tunnel and fallback Worker. The lock file manager serializes/deserializes this to YAML on disk.

### Service State (runtime)

The process supervisor maintains runtime state for each local service: current lifecycle state, the child process handle, restart count, last crash timestamp, accumulated log buffer, and the backoff delay for the next restart. This state exists only in memory during `flaregun up` — it is not persisted.

### Config Diff

The output of comparing two config objects. Describes additions, removals, and modifications at the service level, with granular change descriptions (which fields changed) for modified services. Used by the hot-reload engine to determine the minimal set of actions needed.

## Integration Points

### CLI → Config Loader → All Commands

Every command (except `setup`) begins by invoking the config loader to parse and validate `flaregun.yml`. The resulting config object is passed into the command handler. Validation failures abort the command with all collected error messages.

### Config Loader → Sync Engine

The sync engine receives the parsed config and the lock file state. It reads the config to determine what Cloudflare resources should exist, reads the lock file to know what resources already exist, and interacts with the Cloudflare SDK to reconcile the two. After each sync step, it updates the lock file state and persists it.

### Sync Engine → Cloudflare SDK Client

All Cloudflare API operations flow through the SDK client. The sync engine calls the SDK for listing, creating, updating, and deleting resources. The SDK client handles authentication via the API token from the environment.

### Deploy Pipeline → Resource Provisioner → Lock File

During deploy, the pipeline calls the resource provisioner for each service that needs cloud resources. The provisioner checks the lock file, creates missing resources via the SDK, and updates the lock file with new IDs. The deploy pipeline then reads the lock file to get resource IDs for wrangler.toml generation.

### Deploy Pipeline → Wrangler Config Generator → wrangler CLI

The deploy pipeline calls the config generator to produce temporary wrangler.toml files, then shells out to `wrangler pages deploy` (for Pages) or `wrangler deploy` (for the fallback Worker) using those generated files. Wrangler is invoked as a child process via the process utility's command runner.

### Process Supervisor → Admin UI Backend (log streaming)

The process supervisor captures stdout/stderr from child processes and pushes log lines to the admin UI backend. The admin backend maintains a set of WebSocket connections from frontend clients. When log lines arrive, the backend broadcasts them to all subscribed WebSocket clients.

### Admin UI Backend → Config Loader + Hot-Reload Engine

When the admin UI saves config changes, the backend calls the config loader to validate the new YAML. If valid, it writes the file to disk, calls the config loader again on the new file, computes the diff between old and new configs, and passes the diff to the hot-reload engine for application.

### Admin UI Backend → Process Supervisor

The admin backend delegates service management actions (restart, stop) to the process supervisor. It queries the supervisor for current service states to serve status information to the frontend.

### Orchestrator → cloudflared tunnel

The orchestrator spawns `cloudflared tunnel run` as a child process with the tunnel token from the environment. The tunnel process runs for the lifetime of `flaregun up`. The orchestrator monitors this process and initiates shutdown if the tunnel process exits unexpectedly.

### Admin UI Frontend → Admin UI Backend

The frontend communicates with the backend over HTTP (REST for config and service management) and WebSocket (for log streaming). The frontend is served by the same Bun HTTP server that hosts the API, so all requests go to the same origin — no CORS configuration needed.

## Directory and File Layout

The flaregun project is organized as follows:

- `src/` — CLI source code (entry point, command handlers, all core modules)
- `src/cli/` — CLI entry point and command dispatcher
- `src/config/` — Config loader, validator, differ
- `src/sync/` — Sync engine (one file per sync step, following the existing pattern)
- `src/deploy/` — Deploy pipeline, resource provisioner, wrangler config generator, functions scaffolder
- `src/process/` — Process supervisor, log capture, process utilities
- `src/admin/` — Admin UI backend (HTTP server, REST routes, WebSocket handler)
- `src/worker/` — Fallback Worker generator (templates and generation logic)
- `src/setup/` — Setup wizard logic
- `src/lock/` — Lock file manager
- `src/env/` — Environment variable loader and validator
- `admin-ui/` — Admin UI frontend React application (separate build, output embedded in CLI)
- `templates/` — Templates for the fallback Worker source and wrangler.toml files
- `tests/` — Test files mirroring the src structure

**User's project directory (when using flaregun):**
- `flaregun.yml` — Config file
- `.env` — Secrets (gitignored)
- `flaregun.lock` — Provisioned resource state (committed to git)
- `projects/*/` — Individual service project directories
- `projects/*/functions/` — Pages Functions source (per service, if applicable)
- `projects/*/dist/` — Build output (per service, gitignored)

## Failure Modes

### Config validation failure

**Trigger:** Invalid YAML syntax, missing required fields, duplicate subdomains/ports, reserved subdomain conflict, invalid auth mode, cloud resources on local services, ambiguous service type.

**Handling:** The config loader collects all errors and reports them together. The command exits with a non-zero code and a complete error list. No partial operations are performed.

### Missing prerequisites

**Trigger:** `cloudflared` or `wrangler` not found on PATH, required environment variables missing.

**Handling:** Descriptive error message naming the missing prerequisite. Suggests `flaregun setup` if environment variables are missing. Command exits without performing any operations.

### Cloudflare API errors

**Trigger:** Invalid API token, expired token, insufficient permissions, rate limiting, network failures, Cloudflare service outages.

**Handling:** API errors from the SDK are caught and reported with context about which operation failed (e.g., "Failed to create Access application for service 'photos': 403 Forbidden"). Rate limit errors should trigger a retry with backoff. Network errors should retry a limited number of times before failing. The sync engine should not leave the system in a half-synced state — if a step fails, the lock file is saved with whatever was successfully provisioned, so the next sync can resume from where it left off.

### Build failures

**Trigger:** A service's build command exits with a non-zero code.

**Handling:** The deploy pipeline reports the build failure with the service name and the build command's stderr output. If deploying multiple services, a build failure for one service does not abort the deployment of other services — each service is deployed independently. The overall command exits with a non-zero code if any service failed.

### wrangler deploy failures

**Trigger:** wrangler command exits with a non-zero code (deployment errors, Pages project issues, Worker upload failures).

**Handling:** Report the failure with the service name and wrangler's error output. Other service deployments continue independently. The lock file already has the resource IDs from provisioning, so the next deploy can retry without re-provisioning.

### Process crash (local services)

**Trigger:** A child process exits unexpectedly during `flaregun up`.

**Handling:** The process supervisor detects the exit, transitions the service to `crashed`, waits for the exponential backoff period, then transitions to `restarting` and re-spawns. If `max_retries` is exceeded, the service transitions to `stopped` and is not restarted. The admin UI reflects the current state. The tunnel and other services continue operating.

### Immediate crash on spawn

**Trigger:** A service's command fails immediately (bad command, missing binary, permission denied).

**Handling:** The supervisor detects exits within the initial window after spawn and counts them toward the retry limit. Exponential backoff still applies. If the command is fundamentally broken (e.g., binary not found), retries will quickly exhaust `max_retries`.

### Tunnel disconnection

**Trigger:** The cloudflared process exits or loses its connection to Cloudflare's edge.

**Handling:** If the tunnel process exits, the orchestrator logs the event and optionally attempts a restart. All local services become unreachable from the internet, but continue running locally. The fallback Worker's proxy-with-fallback behavior kicks in — requests to tunnel-backed subdomains fail at the origin fetch and get redirected to the down page.

### Hot-reload failures

**Trigger:** Config save via admin UI triggers a re-sync that fails (e.g., Cloudflare API error while updating Access policies).

**Handling:** The hot-reload engine reports the error to the admin UI frontend (via the REST response to the save request). The new config has already been written to disk. The system continues running with whatever changes were successfully applied. The user can retry the save or manually run `flaregun up` to do a full re-sync.

### Lock file corruption or deletion

**Trigger:** The lock file is manually edited incorrectly, deleted, or lost.

**Handling:** If the lock file is missing, flaregun treats all resources as unprovisioned and re-provisions them on the next deploy. This may create duplicate resources in Cloudflare (e.g., a second D1 database) — the old ones would need manual cleanup in the Cloudflare dashboard. If the lock file has invalid YAML, flaregun reports the parse error and exits.

### .env file missing

**Trigger:** `.env` file doesn't exist or is missing required variables.

**Handling:** Commands that need Cloudflare access report which variables are missing and suggest running `flaregun setup`. The `build` command does not need Cloudflare credentials (it only runs build commands locally), so it works without `.env`.

### Destroy partial failure

**Trigger:** Some Cloudflare resources fail to delete during `flaregun destroy` (e.g., a D1 database is in use, API permissions insufficient for certain operations).

**Handling:** The destroy command logs each failure but continues attempting to delete remaining resources. After all deletion attempts, it reports a summary of what was successfully deleted and what failed. The lock file is updated to remove only successfully deleted entries, leaving failed entries for a retry.

### Concurrent flaregun instances

**Trigger:** Two instances of `flaregun up` or `flaregun deploy` running against the same config simultaneously.

**Handling:** This is not explicitly guarded against. The lock file provides some natural coordination (both instances will try to provision the same resources, and the idempotency checks will prevent double-creation for most resource types). However, race conditions are possible. This is an acceptable limitation for a single-user tool — documenting "don't run two instances simultaneously" is sufficient.

### Admin UI port conflict

**Trigger:** The port selected by the admin backend is already in use.

**Handling:** The admin backend should try multiple ports if the first choice is unavailable, similar to how dev servers handle port conflicts. If no port is available after reasonable attempts, report an error.

### Functions copy conflicts

**Trigger:** The `dist/functions/` directory already exists (from a previous build or a framework that generates its own functions).

**Handling:** The functions copy step overwrites `dist/functions/` entirely — it deletes the directory and copies fresh from the source `functions/` directory. This is safe because `dist/` is a build artifact. The source `functions/` directory is never modified.

### Custom down page file missing

**Trigger:** Config specifies `down_page: ./path.html` but the file doesn't exist.

**Handling:** Config validation catches this and reports an error. The Worker generator is never called with a missing file.

# Requirements

## Problem Statement

Managing a personal domain on Cloudflare is painful. Setting up tunnels, DNS records, access policies, Pages deployments, and serverless resources requires navigating a confusing portal, remembering obscure API token permissions, and manually configuring OAuth providers. There is no single tool that lets you declare your entire domain infrastructure in one config file and have it all provisioned, deployed, and managed with simple commands.

An existing personal-homepage project at `../personal-homepage` has proven the concept — it manages a single domain's Cloudflare stack (tunnels, DNS, Access, Pages, Workers) from a `config.yaml` file using TypeScript scripts. But it's tightly coupled to one specific domain, hardcodes project-specific details (video file copying, domain names in Worker source), and lacks an admin interface. Flaregun extracts and productizes this into a general-purpose tool that anyone can use for their own domain.

## Success Criteria

### CLI Foundation

- [ ] `flaregun up` syncs all Cloudflare state, starts local services with process supervision, starts the built-in admin UI, starts the cloudflared tunnel, and blocks until SIGINT/SIGTERM
- [ ] `flaregun down` gracefully stops all local service processes, the admin UI, and the tunnel — Cloudflare state (DNS, Access, Pages, Workers) remains in place so the down page handles unavailable services
- [ ] `flaregun deploy` builds all Pages projects (running their build commands), copies functions into dist directories, provisions any missing cloud resources (D1/R2/KV), generates internal wrangler configs, and deploys all Pages projects and the fallback Worker to Cloudflare
- [ ] `flaregun build` builds all (or specified) projects locally without deploying — useful for CI and pre-deploy validation
- [ ] `flaregun setup` provides a guided interactive walkthrough for first-time Cloudflare configuration (API token creation, identity provider setup, tunnel creation, generating .env and starter flaregun.yml)
- [ ] `flaregun destroy` tears down all Cloudflare resources (DNS records, Access applications/policies, tunnel config, Pages projects, D1 databases, R2 buckets, KV namespaces, the fallback Worker) with a confirmation prompt
- [ ] All commands read configuration from a single `flaregun.yml` file and secrets from a co-located `.env` file

### Configuration

- [ ] A single `flaregun.yml` file is the source of truth for one domain's entire infrastructure
- [ ] Services are defined by their properties with no explicit type field — flaregun infers behavior: presence of `dist` means a Pages service, presence of `command` + `port` means a local service
- [ ] Each service declares a unique subdomain and an auth mode (defaulting to `admin_only`)
- [ ] Pages services support optional cloud resource declarations: `database: true` (D1), `bucket: true` (R2), `kv: true` (KV)
- [ ] Pages services support a `functions` field pointing to the Pages Functions source directory, defaulting to `functions/` relative to the project
- [ ] Local services support `command`, `port`, optional `build`, and optional `max_retries` for process supervision
- [ ] Auth configuration declares an identity provider and a list of superuser emails
- [ ] Per-service auth supports `admin_only` (superusers only), `authorized` (superusers plus a per-service user list supporting exact emails and wildcard domains), and `public` (no auth)
- [ ] An optional `down_page` field points to a custom HTML file for the down page — if omitted, a sensible built-in default is used
- [ ] Config validation catches errors eagerly: missing required fields, duplicate subdomains, duplicate ports, invalid auth modes, and reserved subdomain conflicts (`admin`, `down`)

### State Management

- [ ] A `flaregun.lock` file tracks all provisioned Cloudflare resource IDs (D1 database IDs, R2 bucket names, KV namespace IDs, Pages project names, Access application IDs, tunnel ID)
- [ ] The lock file is safe to commit to git — it contains no secrets
- [ ] Secrets (API token, account ID, zone ID, tunnel token) live in the `.env` file which is gitignored
- [ ] Deploys are idempotent: flaregun checks the lock file before provisioning and only creates resources that don't already exist

### Pages Services and Serverless

- [ ] Each Pages service gets an internally-generated wrangler.toml with `pages_build_output_dir`, resource bindings, and naming conventions — the user never writes or sees this file
- [ ] During deploy, flaregun copies the service's `functions/` directory into `dist/functions/` before running wrangler pages deploy, so that build output wipes don't destroy function source code
- [ ] Cloud resources (D1/R2/KV) are provisioned via the Cloudflare API and their IDs stored in the lock file
- [ ] Bindings use conventional names: `DB` for D1, `BUCKET` for R2, `KV` for KV — accessible in Pages Functions via `context.env`
- [ ] When a service declares `database`, `bucket`, or `kv` but has no `functions/` directory, flaregun scaffolds a starter `functions/` directory with an example handler that uses the declared bindings and a tsconfig referencing the Cloudflare Workers types — this scaffolding happens during `flaregun build` or `flaregun deploy`
- [ ] Scaffolding only happens once — if `functions/` already exists, flaregun does not overwrite it
- [ ] All serverless code is TypeScript only

### Local Services and Process Supervision

- [ ] Local services are spawned as child processes by `flaregun up`
- [ ] Crashed services are automatically restarted with exponential backoff up to a configurable `max_retries` limit per service
- [ ] Services transition through states: starting, running, crashed, restarting, stopped (when max retries exceeded)
- [ ] stdout and stderr from all services are captured for log tailing
- [ ] `flaregun down` and SIGINT/SIGTERM gracefully kill all child processes

### Cloudflare Sync Engine

- [ ] Sync is idempotent: creates resources if missing, updates if changed, and handles removals when services are deleted from config
- [ ] DNS: creates a wildcard CNAME pointing to the tunnel, per-Pages custom domain CNAMEs, and manages the www CNAME for the root page
- [ ] Tunnel: pushes ingress rules mapping subdomains to localhost ports for all local services (plus the admin UI), with a catch-all 404 rule
- [ ] Access: creates a Cloudflare Access application and policy for every service with non-public auth, merging superusers with per-service user lists, supporting both exact email and wildcard domain selectors
- [ ] Redirect rules: creates a bare domain to www redirect (301)
- [ ] The sync engine handles both additions and removals — deleting a service from config should clean up its Access application/policy and tunnel ingress rule

### Fallback Worker (Down Page)

- [ ] A domain-specific fallback Worker is auto-generated and deployed by flaregun
- [ ] The Worker intercepts all subdomain traffic via a wildcard route pattern
- [ ] For the root domain and www subdomain, the Worker passes through to Pages
- [ ] For the `down` subdomain, the Worker serves the down page HTML directly
- [ ] For all other subdomains, the Worker proxies the request to the origin — if the origin returns a 5xx error or the fetch fails (tunnel down), the Worker redirects to the down page
- [ ] The down page uses a built-in default HTML template themed with the domain name, or a custom HTML file if `down_page` is specified in the config
- [ ] The Worker source code and wrangler config are generated from templates — no hardcoded domain names

### Admin UI

- [ ] A built-in web dashboard is served at `admin.yourdomain.com` with `admin_only` auth enforced via Cloudflare Access
- [ ] The admin UI runs as an implicit local service during `flaregun up` — it is not declared in the user's config but is automatically included in tunnel ingress and Access policies
- [ ] The admin UI provides a YAML config editor with live validation that shows errors inline before saving
- [ ] Saving config changes writes to disk and triggers an automatic Cloudflare re-sync (hot-reload) — the sync engine diffs old config vs new config and applies changes granularly (start/stop services, update Access policies, update tunnel ingress, etc.)
- [ ] The admin UI shows service health status for local services: current state (running, crashed, stopped), uptime, restart count
- [ ] The admin UI provides restart and stop controls for individual local services
- [ ] The admin UI provides live log tailing for local services via WebSocket — streaming stdout/stderr in real time
- [ ] The admin UI shows tunnel connection status (connected/disconnected)
- [ ] The admin UI backend is a Bun HTTP server with both REST endpoints (config CRUD, service management) and WebSocket support (log streaming)
- [ ] The admin UI frontend is a React single-page application using Zustand for state management and Material UI for components, pre-built and embedded/bundled with the CLI

### Guided Setup

- [ ] `flaregun setup` walks the user through first-time Cloudflare configuration step by step
- [ ] Step 1: Guide the user through creating a Cloudflare API token with the correct permissions — provide direct links to the correct portal pages and list exactly which permissions are needed
- [ ] Step 2: Guide the user through setting up an identity provider (Google OAuth, GitHub, etc.) in Cloudflare Access — provide links and step-by-step instructions for the portal configuration
- [ ] Step 3: Create a Cloudflare Tunnel programmatically via the Cloudflare SDK (this step can be fully automated once the API token is available)
- [ ] Step 4: Generate the `.env` file with all collected credentials
- [ ] Step 5: Generate a starter `flaregun.yml` with a minimal homepage service configuration

### Special Pages

- [ ] The root page (`www.` subdomain and bare domain) is deployed as a Cloudflare Pages project with the bare domain 301-redirecting to `www.` via a Cloudflare redirect rule
- [ ] The `admin` subdomain is reserved for the built-in admin UI
- [ ] The `down` subdomain is reserved for the down page served by the fallback Worker
- [ ] Validation rejects user services that attempt to use the reserved subdomains `admin` or `down`

## Constraints

- **Runtime**: Bun-native CLI — all code runs on Bun, no Node.js compatibility required
- **Cloudflare SDK**: Uses the official `cloudflare` TypeScript SDK for API operations
- **CLI tools**: Requires `wrangler` (for Pages/Worker deployments) and `cloudflared` (for tunnel daemon) to be installed on the system
- **Single domain**: One `flaregun.yml` manages exactly one domain — no multi-domain support
- **Single config file**: No multi-config merging or satellite configs — one file is the complete source of truth
- **TypeScript only**: All serverless functions (Pages Functions) are TypeScript — no Python, Rust, or other Worker languages
- **Pages-only deployment**: All deployed services are Cloudflare Pages projects — no standalone Worker deployments for user services (the fallback Worker is internal only)
- **No pure serverless**: Every deployed service must have static content (a `dist` directory) — pure API endpoints without static content are not a supported use case
- **Cloud resources for Pages only**: `database`, `bucket`, and `kv` declarations are only valid on Pages services, not on local services

## Non-Goals

- **Multi-domain management**: Flaregun manages one domain per config file — managing multiple domains from a single config is out of scope
- **Domain purchasing/registration**: While `flaregun setup` guides portal configuration, it does not automate buying or transferring domains
- **Cloudflare resource metrics in admin UI**: The admin dashboard does not show D1 usage, R2 storage, KV key counts, or other Cloudflare-side metrics — that's the Cloudflare dashboard's job
- **Advanced Worker features**: No support for Queues, Durable Objects, cron triggers, or multi-worker-per-service architectures — keep it simple
- **Non-Cloudflare providers**: Flaregun is Cloudflare-only — no abstraction layer for other DNS/hosting providers
- **Custom wrangler.toml**: Users never write or maintain wrangler.toml files — flaregun generates them internally
- **Local development server**: Flaregun is not a local dev server — use framework-specific dev servers (Next.js dev, Vite, etc.) for local development

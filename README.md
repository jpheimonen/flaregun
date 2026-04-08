# flaregun

Manage your entire Cloudflare domain stack from a single config file. Flaregun provisions tunnels, DNS records, Access policies, Pages deployments, Workers, and serverless resources (D1, R2, KV) — all declared in one `flaregun.yml`.

## Prerequisites

- [Bun](https://bun.sh) runtime
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI (for Pages/Worker deployments)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (for tunnel daemon)
- A Cloudflare account with a registered domain

## Quick Start

```bash
# Install dependencies
bun install

# Run the guided setup wizard
bun run src/cli/index.ts setup

# Start everything — sync Cloudflare, launch services, open tunnel
bun run src/cli/index.ts up
```

The setup wizard walks you through creating a Cloudflare API token, configuring an identity provider for Access, creating a tunnel, and generating your `.env` and starter `flaregun.yml`.

## Commands

| Command | Description |
|---------|-------------|
| `flaregun up` | Sync Cloudflare state, start local services with process supervision, start the admin UI, start the tunnel, and block until interrupted |
| `flaregun down` | Gracefully stop all local services, the admin UI, and the tunnel |
| `flaregun deploy [services...]` | Build, provision cloud resources, and deploy Pages projects and the fallback Worker |
| `flaregun build [services...]` | Build services locally without deploying (useful for CI) |
| `flaregun setup` | Interactive guided setup for first-time Cloudflare configuration |
| `flaregun destroy` | Tear down all Cloudflare resources (with confirmation prompt) |

The `deploy` and `build` commands accept optional service names to operate on a subset. When no names are given, they operate on all eligible services.

## Configuration

All infrastructure is declared in a single `flaregun.yml` file:

```yaml
domain: example.com

auth:
  provider: google
  superusers:
    - admin@example.com

services:
  homepage:
    subdomain: www
    dist: ./projects/homepage/dist
    build: cd projects/homepage && npm run build

  blog:
    subdomain: blog
    dist: ./projects/blog/dist
    build: cd projects/blog && npm run build
    database: true
    functions: ./projects/blog/functions

  api:
    subdomain: api
    command: bun run projects/api/server.ts
    port: 3001
    auth: authorized
    users:
      - dev@example.com
      - "*@mycompany.com"

  grafana:
    subdomain: metrics
    command: grafana-server
    port: 3000
    max_retries: 5
```

### Service Types

Flaregun infers service type from the declared properties — no explicit `type` field needed:

- **Pages services**: Have a `dist` field. Deployed to Cloudflare Pages. Support optional `build`, `functions`, `database`, `bucket`, and `kv` fields.
- **Local services**: Have `command` and `port` fields. Run as supervised child processes during `flaregun up`. Support optional `build` and `max_retries`.

### Auth Modes

Each service has an auth mode (defaults to `admin_only`):

- **`admin_only`** — Only superusers can access (via Cloudflare Access)
- **`authorized`** — Superusers plus a per-service `users` list (supports exact emails and `*@domain.com` wildcards)
- **`public`** — No Cloudflare Access policy; open to everyone

### Cloud Resources

Pages services can declare serverless resources that are automatically provisioned:

```yaml
services:
  app:
    subdomain: app
    dist: ./projects/app/dist
    database: true   # Provisions a D1 database (binding: DB)
    bucket: true     # Provisions an R2 bucket (binding: BUCKET)
    kv: true         # Provisions a KV namespace (binding: KV)
```

Resources are accessible in Pages Functions via `context.env.DB`, `context.env.BUCKET`, and `context.env.KV`. If a service declares cloud resources but has no `functions/` directory, flaregun scaffolds a starter one with example handlers.

## State Management

- **`flaregun.lock`** — Tracks all provisioned Cloudflare resource IDs (safe to commit to git)
- **`.env`** — Stores secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_TUNNEL_TOKEN` (gitignored)

Deploys are idempotent — flaregun checks the lock file before provisioning and only creates resources that don't already exist.

## Admin UI

When running `flaregun up`, a built-in admin dashboard is served at `admin.yourdomain.com` (protected by `admin_only` Cloudflare Access). It provides:

- **Config editor** — Edit `flaregun.yml` with live YAML validation; saving triggers automatic hot-reload
- **Service dashboard** — View service health (running/crashed/stopped), uptime, restart counts, with restart/stop controls
- **Log viewer** — Real-time log tailing via WebSocket for all local services
- **Tunnel status** — Shows whether the cloudflared connection is active

### Hot Reload

Saving config changes in the admin UI triggers a diff-driven re-sync. The hot-reload engine compares old and new configs and applies only the necessary changes: starting/stopping services, updating Access policies, updating tunnel ingress — without a full restart.

## Reserved Subdomains

- **`www`** — Root page (Pages project, with bare domain redirecting to `www` via 301)
- **`admin`** — Built-in admin UI (auto-configured, not declared in user config)
- **`down`** — Down page served by the fallback Worker

User services cannot use `admin` or `down` as subdomains.

## Fallback Worker

Flaregun auto-generates and deploys a domain-wide fallback Worker that:

- Passes through requests to `www` and the bare domain to Pages
- Serves a down page at the `down` subdomain
- Proxies all other subdomain requests to the origin — if the origin returns 5xx or the fetch fails (e.g., tunnel is down), redirects to the down page

Customize the down page by setting `down_page: ./path/to/custom.html` in your config, or use the built-in default.

## Development

```bash
# Run tests
bun test

# Run a specific test file
bun test tests/config.test.ts
```

### Project Structure

```
src/
  cli/        # CLI entry point and command dispatcher
  config/     # Config loader, validator, differ
  sync/       # Cloudflare sync engine (Access, DNS, tunnel, redirects)
  deploy/     # Deploy pipeline, resource provisioner, wrangler config generator
  process/    # Process supervisor with lifecycle state machine
  admin/      # Admin UI backend (REST + WebSocket)
  worker/     # Fallback Worker generator
  setup/      # Interactive setup wizard
  lock/       # Lock file manager
  env/        # Environment variable loader
admin-ui/     # React SPA (Zustand + Material UI)
tests/        # Test files mirroring src/ structure
```

## Constraints

- **Bun-native** — All code runs on Bun; no Node.js compatibility required
- **Single domain** — One `flaregun.yml` manages exactly one domain
- **TypeScript only** — All serverless functions are TypeScript
- **Pages-only deployment** — User services deploy as Cloudflare Pages projects (the fallback Worker is internal only)
- **No pure serverless** — Every deployed service must have static content (`dist` directory)

## License

Private

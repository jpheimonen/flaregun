# flaregun

Put a local port on your own domain behind Cloudflare Zero Trust login, with one command:

```bash
flaregun expose 3000
# ✓ Added to flaregun.yml: https://3000.example.com → localhost:3000 (login required)
```

The first run sets everything up. flaregun clicks through the Cloudflare dashboard in your own browser, then does the rest through the API: it creates its API token, switches on Zero Trust with email one-time-PIN login, creates a tunnel and the DNS records, and starts `cloudflared`. You only need to be logged in to Cloudflare and have a domain on it.

flaregun can also run your local services under supervision, deploy Pages sites with D1/R2/KV, and serve an admin UI. All of it is declared in one `flaregun.yml`.

## Install

You need [Bun](https://bun.sh) and a Cloudflare account with a domain on it.

```bash
git clone https://github.com/jpheimonen/flaregun && cd flaregun
bun install && (cd admin-ui && bun install && bun run build)
bun link          # puts `flaregun` on your PATH
```

If `cloudflared` isn't installed, `flaregun up` offers to download it into `~/.local/share/flaregun/bin` (Linux and macOS). Deploying Pages sites also needs [wrangler](https://developers.cloudflare.com/workers/wrangler/).

## Quick start

Run these in the folder where you want flaregun's files (`flaregun.yml`, `.env`, `flaregun.lock`):

```bash
flaregun expose 3000                  # https://3000.example.com, login required
flaregun expose 8080 grafana          # https://grafana.example.com
flaregun expose 5173 demo --public    # https://demo.example.com, open to anyone
```

The first `expose` runs `flaregun setup` and then `flaregun up`, which keeps the tunnel open until you press Ctrl+C. While `up` is running, `flaregun expose` in another terminal adds the new address to it right away.

People listed as admins in `flaregun.yml` can open protected addresses. Cloudflare asks for their email and sends a one-time code.

## What setup does

`flaregun setup` asks as little as it can and is safe to run again; every step reuses what already exists.

1. **API token.** Cloudflare's API can't create your first token, so flaregun opens the API tokens page in your default browser and clicks through the **Create Additional Tokens** template: *Create Token → Use template → Continue to summary → Create Token*. It reads the new token from the page. It uses this token once to create its own token with exactly the permissions it needs, then deletes it.
2. **Account and domain.** Picked automatically when there's only one; otherwise you choose from a list.
3. **Zero Trust.** flaregun switches it on through the API and adds One-time PIN login if there's no login method yet. If Cloudflare insists on the dashboard (for example to choose a plan), flaregun opens it and waits. You pick the team name and the Free plan; flaregun never clicks plan or billing pages.
4. **Admins.** Defaults to your Cloudflare account email. Press Enter to accept it.
5. **Tunnel.** Reuses the domain's tunnel or creates one, and fetches its token.
6. **Files.** Writes `.env` (secrets, mode 600), a starter `flaregun.yml` (only if missing) and `flaregun.lock`.

### How flaregun uses your browser

flaregun works like factory-vm: it drives the browser you already use and are logged in to, rather than starting a separate one. It supports Chrome, Brave, Edge, Chromium and Vivaldi.

- The first time, flaregun opens `<browser>://inspect/#remote-debugging` (for example `brave://inspect/#remote-debugging`). Switch remote debugging on there; flaregun notices it within a couple of seconds.
- Your browser then asks whether to allow the connection. Click **Allow**.
- flaregun opens its own tab. If you're logged out, log in there; flaregun carries on afterwards.

If a step goes wrong (Cloudflare changed a button, you press Enter to skip, or the browser isn't supported), flaregun leaves the tab open and tells you what to click and where to paste the token. Use `--no-browser` to always do these clicks yourself. Set `FLAREGUN_BROWSER_PROFILE` to a profile folder to use a browser other than your default one.

## Commands

| Command | Description |
|---------|-------------|
| `flaregun setup [--no-browser]` | Connect flaregun to Cloudflare (see above) |
| `flaregun expose <port> [subdomain] [--public] [--no-browser]` | Add a local port to `flaregun.yml` and put it online. The subdomain defaults to the port number |
| `flaregun up` | Sync Cloudflare, start supervised services and the admin UI, run the tunnel, and block until Ctrl+C. Runs setup first in a folder that isn't set up |
| `flaregun down` | Stop a running `flaregun up` |
| `flaregun deploy [services...]` | Build, provision cloud resources, and deploy Pages projects and the fallback Worker |
| `flaregun build [services...]` | Build services locally without deploying (useful for CI) |
| `flaregun destroy` | Tear down all Cloudflare resources (with confirmation prompt) |

## Configuration

All infrastructure is declared in a single `flaregun.yml` file:

```yaml
domain: example.com

auth:
  provider: onetimepin
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
- **Local services**: Have a `port`. With a `command`, flaregun runs it as a supervised child process during `flaregun up` (with optional `build` and `max_retries`). Without one, flaregun only tunnels to a port that's already served, which is what `flaregun expose` adds.

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

If a Cloudflare Access app for a hostname already exists and flaregun didn't create it (for example, one set up from another machine), flaregun reuses it and adds its own policy after the app's existing policies. It leaves the app out of `flaregun.lock` and doesn't touch the other policies, so removing the service or running `flaregun destroy` never deletes that app.

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

# Also drive a real headless Chrome through a local copy of the token pages
FLAREGUN_TEST_CHROME=/path/to/chrome bun test tests/browser
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
  setup/      # Setup: token creation, Zero Trust, tunnel, files
  browser/    # Finding and driving the person's own browser (DevTools protocol)
  expose/     # `flaregun expose`
  tunnel/     # Finding and downloading cloudflared
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

# Step 012: Admin UI Backend

## Files Created
- `src/admin/types.ts` — Types and interfaces (IHotReloadEngine, HotReloadResult, AdminServerDeps, WebSocket message types, PagesServiceInfo)
- `src/admin/server.ts` — AdminServer class with Bun.serve(), HTTP routes, WebSocket log streaming, static file serving
- `src/admin/index.ts` — Barrel re-exports
- `tests/admin.test.ts` — 36 integration tests using real HTTP server on random port

## Key Design Decisions
- **Port selection**: `Bun.serve({ port: 0 })` gives a random available port. For explicit port, tries preferredPort + attempt offset.
- **Static file serving**: Uses `fs.readFileSync` + `fs.statSync` with MIME type lookup. SPA fallback returns `index.html` for unmatched non-API routes.
- **WebSocket**: Uses Bun's native `websocket` handler in `Bun.serve()`. Client sends `{ type: "subscribe", service: "name" }` or `{ type: "subscribe", service: "__all__" }`.
- **Dependency injection**: All deps injected via `AdminServerDeps` interface (supervisor, hotReloadEngine, cloudflareClient, lockState, configPath, spaDir, pagesServices).
- **IHotReloadEngine interface**: Defined in types.ts for step 013 to implement. Takes (oldConfig, newConfig, client, lockState, supervisor) → HotReloadResult.

## API Endpoints
- `GET /api/config` — Returns raw YAML content
- `POST /api/config/validate` — Validates YAML without writing (body: `{ content: "..." }`)
- `POST /api/config/save` — Validates, writes, triggers hot-reload (body: `{ content: "..." }`)
- `GET /api/services` — Lists all services with states
- `POST /api/services/:name/restart` — Restart a local service
- `POST /api/services/:name/stop` — Stop a local service
- `ws://host/api/logs` — WebSocket for log streaming

## Testing Pattern
Tests create a real Bun HTTP server on port 0, use `fetch()` for REST and `new WebSocket()` for WS testing. Temp directories with dummy SPA files. Mock hot-reload engine records calls for assertions.
# E2E / Integration Test Commands

## Backend Integration Tests (Bun)
- Command: `bun test tests/admin.test.ts`
- Run from: project root `/home/jp/projects/personal/flaregun`
- Tests: Admin server REST API, WebSocket logs, static file serving (36 tests)
- No services need to be started — tests start their own server on a random port

## Frontend E2E-Style Tests (Vitest + React Testing Library)
- Command: `cd admin-ui && npx vitest run`
- Run from: `admin-ui/` directory
- Tests: ConfigEditor, ServiceDashboard, LogViewer, TunnelStatus, stores, build (87 tests across 8 files)
- No services needed — uses mocked API client

## Notes
- No browser automation (Playwright/Cypress) is used
- The `act(...)` warnings in ConfigEditor tests are benign — all tests pass
- Root `bun test` runs ALL backend tests (scoped to `tests/` directory via bunfig.toml)
- To run a single backend test: `bun test tests/<filename>.test.ts`
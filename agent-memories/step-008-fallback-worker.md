# Step 008: Fallback Worker Generator

## Files Created
- `src/worker/handler.ts` — Routing logic module with `handleRequest(request, domain, downPageHtml, originFetch)`. Directly importable and testable, no code generation needed.
- `src/worker/down-page.ts` — `defaultDownPageHtml(domain)` function producing dark-themed offline page with domain injected.
- `src/worker/generate.ts` — `generateWorkerSource(options)` and `writeWorkerSource(targetDir, options)`. Produces self-contained Worker source with domain and HTML baked in as constants. Inlines the routing logic (does NOT import handler.ts at runtime — the generated source is standalone).
- `src/worker/index.ts` — Barrel file re-exporting all worker module exports.
- `tests/worker/handler.test.ts` — 21 tests covering all routing rules (passthrough, offline fallback, down page serving, route safety, unified failure handling, domain parameterization).
- `tests/worker/generate.test.ts` — 25 tests covering domain embedding, HTML embedding (default + custom), source structure, HTML escaping, file writing, resolveDownPageHtml, and default template.

## Key Design Decisions
- **Separation of concerns**: handler.ts is a testable module; generate.ts produces deployable source that inlines the same logic with baked-in constants.
- **The generated source is self-contained** — it doesn't import handler.ts. The routing logic is duplicated in the template string so the deployed Worker has zero dependencies.
- **HTML escaping**: backticks, backslashes, and `${` are escaped when embedding HTML in template literals.
- **WORKER_SOURCE_FILENAME** = "index.ts" — must match the `main` field in wrangler.toml from step 007's `FALLBACK_WORKER_ENTRY`.
- **DownPageNotFoundError** thrown when custom down_page file doesn't exist.

## Integration Points
- `src/deploy/wrangler.ts` already generates fallback Worker wrangler.toml with `main = "index.ts"`.
- Step 009 (deploy pipeline) will use `writeWorkerSource()` to write to the same temp dir as the wrangler.toml.
- Config's `down_page` field feeds into `GenerateWorkerOptions.downPagePath`.

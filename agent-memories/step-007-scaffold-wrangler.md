# Step 007: Functions Scaffolder & Wrangler Config Generator

## Files Created
- `src/deploy/tmp.ts` - Temp directory create/cleanup utilities
- `src/deploy/scaffold.ts` - Functions directory scaffolder for Pages services
- `src/deploy/wrangler.ts` - Wrangler config generators (Pages + fallback Worker)
- `src/deploy/index.ts` - Re-exports for the deploy module
- `tests/deploy/tmp.test.ts` - 5 tests
- `tests/deploy/scaffold.test.ts` - 12 tests
- `tests/deploy/wrangler.test.ts` - 19 tests

## Key Patterns
- The scaffolder uses `resolve()` (not `join()`) to normalize paths with trailing slashes (the config loader sets `functions: "functions/"` with a trailing slash)
- The `pagesService()` fixture helper sets `functions: "functions/"` by default
- `resourceName(domain, serviceName)` from `src/naming.ts` is reused for Pages project names
- Fallback Worker name: `resourceName(domain, "fallback")` → e.g., "example-com-fallback"
- Lock file resource IDs are accessed via `lookupResource()` from `src/lock/index.ts`
- `MissingResourceError` thrown when a declared resource has no lock file entry
- Wrangler configs are written to OS temp directories (prefixed with "flaregun-")

## Binding Naming
- D1 → binding name `DB`, database_id from lock file
- R2 → binding name `BUCKET`, bucket_name from lock file
- KV → binding name `KV`, id from lock file

## Test Count
36 new tests, 261 total across 16 files (all passing)
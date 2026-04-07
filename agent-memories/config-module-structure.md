# Config Module (Step 002)

## Location
- Source: `src/config/index.ts`
- Tests: `tests/config.test.ts`

## Key Exports
- **Types**: `FlaregunConfig`, `AuthConfig`, `ServiceConfig`, `AuthMode` ("admin_only" | "authorized" | "public"), `ServiceType` ("pages" | "local"), `AccessSelector`, `ConfigDiff`, `ServiceDiff`
- **Parsing**: `parseConfig(yaml: string)` (pure, no filesystem), `loadConfig(configPath?: string)` (reads file, validates filesystem constraints like down_page existence)
- **Validation**: `ConfigValidationError` class with `errors: string[]` array, `validateConfig(raw: unknown)` for raw YAML validation
- **Access Selectors**: `isWildcard()`, `extractWildcardDomain()`, `mergeUsers()`, `toAccessSelectors()`, `buildServiceSelectors(service, superusers)`
- **Diffing**: `diffConfigs(oldConfig, newConfig)` returns `ConfigDiff` with added/removed/modified services and globalAuthChanged flag

## Patterns
- Eager error collection: all validation errors collected in array, thrown at end as `ConfigValidationError`
- Service type inferred from properties: `dist` → pages, `command` + `port` → local
- Auth defaults to `admin_only` when not specified
- Functions defaults to `functions/` for Pages services
- Three-tier auth: admin_only (superusers only), authorized (superusers + users), public (no restrictions)
- Reserved subdomains: "admin" and "down"
- Test helper: `expectValidationErrors(yaml)` returns error strings array

## Test Patterns
- Uses Bun test runner (`bun:test`)
- YAML template literal constants as fixtures
- Keyword matching for error assertions (e.g., `msg.includes("domain")`)
- Temp directories for filesystem tests (`mkdtempSync`)

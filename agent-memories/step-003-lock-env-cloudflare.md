# Step 003: Lock File, Env Manager, SDK Client

## Lock File Manager (`src/lock/index.ts`)
- Manages `flaregun.lock` YAML file tracking Cloudflare resource IDs
- **Types**: `LockState`, `PagesEntry`, `TunnelEntry`, `AccessEntry`, `WorkerEntry`, `ResourceType`
- **Functions**: `loadLockFile(path)`, `saveLockFile(path, state)`, `lookupResource(state, service, type)`, `storeResource(state, service, type, id)`, `removeService(state, service)`, `clearState(state)`, `emptyState()`
- **Error**: `LockFileParseError` for invalid YAML
- ResourceType: `"pages_project" | "d1_database" | "r2_bucket" | "kv_namespace" | "access_app"`
- Lock file includes auto-generated header comment
- Missing file returns empty state (no error)

## Environment Manager (`src/env/index.ts`)
- Loads `.env` file co-located with `flaregun.yml`, validates Cloudflare credentials
- **Types**: `EnvContext` = `"deploy" | "up" | "sync" | "destroy" | "setup"`, `CloudflareCredentials`
- **Functions**: `loadEnvFile(configPath)`, `validateEnv(context, envFileLoaded?)`, `loadAndValidateEnv(configPath, context)`
- **Error**: `EnvValidationError` with `missing: string[]` array
- `CLOUDFLARE_TUNNEL_TOKEN` only required for `up` context
- Eager error collection (all missing vars reported at once)
- Suggests `flaregun setup` when no .env and no vars set

## SDK Client Wrapper (`src/cloudflare/index.ts`)
- **Functions**: `createClient(credentials)`, `createClientFromToken(apiToken)`
- **Type**: `CloudflareClient` = re-exported Cloudflare type
- Dependency injection seam: components accept client as parameter, tests substitute mock

## Tests
- `tests/lock.test.ts` - 15 tests covering load/save/roundtrip/lookup/store/remove/clear
- `tests/env.test.ts` - 15 tests with beforeEach/afterEach save/restore of process.env
- `tests/cloudflare.test.ts` - 4 tests covering client creation and DI seam

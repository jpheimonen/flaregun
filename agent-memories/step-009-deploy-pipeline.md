# Step 009: Deploy Pipeline and Deploy Command

## Files Created
- `src/deploy/copy-functions.ts` — `copyFunctionsToDistDir(functionsSrcPath, distPath)` recursively copies functions/ into dist/functions/, replacing existing contents.
- `src/deploy/build.ts` — `buildScaffoldCopy(serviceName, service, projectRoot, lockState, runner)` shared function: build → scaffold → copy-functions. Returns `BuildResult` with success/error/built/scaffolded/functionsCopied flags.
- `src/deploy/pipeline.ts` — Core pipeline: `deployService()`, `deployFallbackWorker()`, `deployPipeline()`, `formatDeploySummary()`.
- `src/deploy/command.ts` — `handleDeploy(filters, configPath, deps)` command handler with full DI via `DeployCommandDeps`.
- `src/deploy/index.ts` — Updated barrel file re-exporting all deploy module exports.
- `tests/deploy/copy-functions.test.ts` — 5 tests for functions copy utility.
- `tests/deploy/build.test.ts` — 10 tests for shared build-scaffold-copy function.
- `tests/deploy/pipeline.test.ts` — 19 tests for per-service deploy, fallback Worker deploy, pipeline orchestrator, summary formatting.
- `tests/deploy/command.test.ts` — 12 tests for deploy command handler.

## Files Modified
- `tests/helpers/mock-client.ts` — Added `MockPagesDomain` type, `pages.projects.domains.get/create` mock methods, `setPagesDomains/getPagesDomains` state manipulation. The `get` method throws when domain not found (used for idempotent domain attachment check).

## Key Design Decisions
- **buildScaffoldCopy is a shared function** — Used by both deploy pipeline (step 009) and build command (step 010). Takes serviceName, service, projectRoot, lockState, runner as params.
- **CommandRunner injection throughout** — All wrangler/build commands go through injectable `CommandRunner`. Tests never invoke real wrangler.
- **Project-not-found retry pattern** — `deployService()` detects "could not find" / "not found" / "does not exist" in wrangler output, creates project via `wrangler pages project create`, retries.
- **Custom domain attachment** — Uses `pages.projects.domains.get` to check existence (catch error = not found), then `pages.projects.domains.create` if missing.
- **Fallback Worker deploy** — Creates temp dir, writes both `index.ts` (via writeWorkerSource) and `wrangler.toml` (via generateFallbackWorkerConfig, then copies content), runs `wrangler deploy` from temp dir.
- **Pipeline orchestrator** — Uses `Promise.all` to run service deploys + Worker deploy concurrently. Collects results into summary. Filter errors (nonexistent/non-Pages services) added to summary immediately.
- **Deploy command handler** — Full DI via `DeployCommandDeps` interface: loadConfigFn, loadEnvFn, loadLockFn, saveLockFn, createClientFn, binaryExistsFn, syncFn, deployFn, runner, stdout, stderr.
- **Sync before deploy** — Command handler runs syncFull before deployPipeline. When no tunnel ID in lock file, passes empty string for tunnelId and logs a note.
- **Lock file saved after deploy** — saveLock called after pipeline completes to persist any new resource IDs.

## Integration Points
- Step 010 (build command) will import `buildScaffoldCopy` directly from `src/deploy/build.ts`.
- Step 016 (orchestrator) will wire `handleDeploy` into the CLI command dispatch.
- Step 018 (destroy command) references lock file entries created by this pipeline.

## Test Count
46 new tests in 4 files. 362 total across 22 files (all passing).
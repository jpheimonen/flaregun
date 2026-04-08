# Step 011 - Process Supervisor

## Implementation Summary
- **Main file**: `src/process/supervisor.ts` — Contains `Supervisor` class, `RollingLogBuffer`, and all types
- **Re-exports**: `src/process/index.ts` re-exports everything from supervisor.ts
- **Tests**: `tests/supervisor.test.ts` — 43 tests covering lifecycle, backoff, log capture, subscriptions, management API, concurrency, shutdown, and timing configurability

## Key Design Decisions
- Commands are spawned via `sh -c <command>` to handle shell syntax (quotes, pipes, semicolons) — naive whitespace splitting doesn't work for complex commands
- **Generation counter** pattern prevents race conditions: each spawn/stop/restart increments a generation counter; exit handlers check the generation before acting. This prevents stale exit handlers from firing after intentional stops/restarts
- Process handle is nulled before termination in stop/restart to ensure exit handlers don't interfere
- `terminateProcessHandle(proc)` takes a raw `Subprocess` handle (not a `ManagedService`) to decouple termination from state management
- `startService` resets lifecycle counters (`restartCount`, `consecutiveCrashes`, `lastCrashReason`) when re-starting a stopped service — prevents stale counters from a previous session causing immediate max_retries exhaustion

## Timing Configuration
All timing constants are injectable via `SupervisorTimingConfig` for fast tests:
- `stabilityWindowMs`: 500ms default, 10-50ms in tests
- `backoffResetMs`: 30s default, 50-200ms in tests
- `gracefulShutdownMs`: 5s default, 50-500ms in tests
- `initialBackoffMs`: 1s default, 10-50ms in tests
- `maxBackoffMs`: 30s default, 20-400ms in tests

## Test Patterns
- `afterEach` shuts down all supervisors to prevent orphan processes
- `waitFor()` helper polls a condition with timeout for async state transitions
- Commands like `echo X; sleep 60` produce output while surviving the stability window
- `exit 1` reliably crashes immediately (via sh -c)
- `trap '' TERM; sleep 60` creates a process that ignores SIGTERM for force-kill testing

## API Surface (consumed by steps 012, 013, 016)
- `startService(config)` / `stopService(name)` / `restartService(name)`
- `getServiceState(name)` / `getAllServiceStates()`
- `getLogBuffer(name)` / `subscribeToLogs(name, cb)` / `subscribeToAllLogs(cb)`
- `shutdown()`

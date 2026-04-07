# AI Spec Review

## Overall Assessment
High-quality specs with excellent detail and traceability, but there is one critical gap (missing `deploy` command handler), one dependency ordering issue, and several ambiguities that would cause the autonomous builder to stall or guess.

## Critical Issues

### 1. Missing `deploy` command handler — no step wires sync + deploy pipeline into a CLI command

Step 009's context section explicitly states: "The `flaregun deploy` command calls both — first sync, then deploy — but this orchestration lives in the command handler (step 016), not in the pipeline itself." However, step 016 is titled "Orchestrator: up and down commands" and only delivers `up` and `down` command handlers. Nobody implements the `deploy` command handler that:
1. Loads and validates config
2. Loads environment variables
3. Loads the lock file
4. Initializes the SDK client
5. Runs the sync engine
6. Runs the deploy pipeline

Step 009 delivers the deploy pipeline as a function that accepts all dependencies as parameters. Step 010 delivers the build command handler (including config loading). Step 016 delivers up/down. Step 018 delivers destroy. The `deploy` command handler is orphaned. The builder of step 009 will create the pipeline function but not the command handler, and the builder of step 016 will only implement up/down per the spec. The user runs `flaregun deploy` and gets "not yet implemented."

**Fix:** Either add the deploy command handler to step 009 (it belongs there — the step already has prerequisite checking) or add it to step 016 (rename the step). Also clarify whether `flaregun deploy` should run sync before deploying — requirements.md doesn't mention sync as part of deploy, but step 009's context says it should.

### 2. Step 005 depends on the naming convention from step 006

Step 005 (DNS sync) needs to create per-Pages-service CNAME records pointing to `project-name.pages.dev`. The project name is "derived from the domain and service name using the same naming convention as the resource provisioner — step 006." But step 006 comes after step 005. The naming convention utility ("A utility function that derives human-readable resource names from the domain and service name") is a deliverable of step 006, not step 005.

The builder of step 005 will either need to invent their own naming convention (hoping step 006 matches), hardcode something, or skip per-Pages CNAME creation.

**Fix:** Extract the naming convention utility into step 003 or step 005 as a shared utility. Step 006 then reuses it rather than defining it.

### 3. `flaregun down` communication mechanism is underspecified

Step 016 says: "The exact mechanism for how `flaregun down` communicates with a running `flaregun up` instance is an implementation detail. Options include: Sending a signal... A more sophisticated IPC mechanism..." and then "The simplest approach: `flaregun down` finds the running `flaregun up` process and sends it a termination signal, triggering the signal handler's shutdown sequence."

This leaves the builder guessing on a critical design question. PID file management (where to write it, how to discover it, cleanup on abnormal exit) is non-trivial. Without a clear specification, the builder might implement something that doesn't work reliably, or might waste significant time exploring options.

**Fix:** Pick a concrete mechanism. PID file at a known path (e.g., `.flaregun/pid`) is the simplest. Specify: write PID on `up` startup, read PID on `down`, send SIGTERM, handle stale PID files.

### 4. Frontend test runner ambiguity (steps 014, 015)

Steps 014 and 015 say "Frontend tests use a component testing approach (e.g., React Testing Library with a test runner compatible with the chosen bundler)" and acceptance criteria say "`bun test` (or the frontend test runner) passes all tests."

Bun's test runner does not natively support JSDOM or browser-like DOM environments needed for React Testing Library. The builder would need to set up vitest + jsdom/happy-dom (or another approach) for the frontend tests. This non-trivial configuration choice and its implications for the monorepo test setup are not addressed. The parenthetical "or the frontend test runner" is vague.

**Fix:** Specify the frontend test runner explicitly. Vitest + jsdom is the standard choice for React component testing in a Vite-based frontend project. Alternatively, if using Bun for everything, specify happy-dom integration.

### 5. Step 008 routing tests — unclear how to test behavior of generated source code

Step 008 says tests have "two concerns: testing the generator itself (does it produce correct source?) and testing the generated Worker's routing logic (does the Worker behave correctly?)." The generator produces TypeScript source as a string. Testing the routing logic requires executing that code.

The step doesn't explain how the builder should make the routing logic testable. Options: (a) implement `handleRequest` as a standalone importable module that the generator wraps into the full Worker source, (b) write generated source to a temp file and dynamically import it, (c) use `eval`. Only option (a) is clean, but the step doesn't say to do it.

**Fix:** Explicitly state that the routing logic (`handleRequest` and its helpers) should be implemented as a regular TypeScript module in `src/worker/` that is testable via direct import. The generator then composes the full Worker source by importing or inlining this logic with the domain name and down page HTML injected. Tests import the module directly and pass the domain as a parameter.

## Suggestions

### Step size concerns

- **Step 009 (deploy pipeline) is the largest step** — it covers build execution, scaffolding integration, functions copy utility, resource provisioning integration, wrangler config generation, wrangler deployment with retry, custom domain attachment, fallback Worker deployment, pipeline orchestration, and parallel execution. This is 5-8 files. Consider splitting into two steps: (a) per-service deploy function + functions copy utility, and (b) pipeline orchestrator + fallback Worker deploy.

- **Step 018 (destroy command) has 8 deletion sub-steps** — but they are all part of one cohesive command, so the size is justified. No change needed.

### Step 010's shared function should be anticipated in step 009

Step 010 introduces a "shared build-scaffold-copy function" that both the build command and deploy pipeline use. It says: "Whether it is factored out during step 009 and reused by step 010, or factored out during step 010 as a refactor, is an implementation detail." This is risky — if the step 009 builder doesn't anticipate the shared function, the step 010 builder will need to refactor step 009's code. Better to specify the shared function as a deliverable of step 009 so it exists before step 010.

### Step 012 → 013 dependency should be more explicit

Step 012 (admin backend) accepts the hot-reload engine as an injected dependency, but step 013 (hot-reload engine) doesn't exist yet. The step 012 spec mentions this injection pattern but doesn't explicitly say "create an interface/type for the hot-reload engine that step 013 will implement." The builder might define a minimal interface that doesn't match what step 013 needs. Consider specifying the hot-reload engine interface shape in step 012.

### Config validation of `down_page` path is filesystem-dependent

Step 002 says config validation should check that `down_page` points to a file that exists on disk. But `parseConfig()` is supposed to accept a YAML string and be testable without filesystem access. The file-existence check can't work in `parseConfig()` without a filesystem. This creates a contradiction: either `parseConfig()` needs a filesystem dependency (breaking its design as a pure string parser), or the file-existence check needs to happen in `loadConfig()` (which wraps `parseConfig()`). The spec should clarify where this validation happens.

### No step covers wiring placeholder command handlers to real implementations

Step 001 creates placeholder handlers for all commands. Steps 009, 010, 016, 017, 018 implement the real handlers. But there's no explicit instruction for _replacing_ the placeholder handlers. The builder of each step needs to understand they should update the CLI dispatcher to call their real handler instead of the placeholder. This is probably obvious but could cause confusion.

### `build` command eligibility for local services is inconsistent

Step 010 says: "A local service with a `build` field is eligible for building when named explicitly." But the architecture and requirements don't mention running build commands for local services — `build` is described as a local-service field for "optional build" in the context of process supervision. The build command was designed around Pages services. This edge case could confuse builders.

## Per-File Notes

### requirements.md
No issues. Comprehensive, well-structured. Success criteria are specific and verifiable.

### architecture.md
- The "Admin UI is also a supervised process" statement (section 12, Process Supervisor) contradicts the admin backend description (section 13) which says it's a Bun HTTP server started directly. Step 016's startup sequence starts the admin backend separately from the process supervisor. Clarify: is the admin backend a supervised child process or a directly managed server?
- Section 15 (Orchestrator) step 7 says "Start the cloudflared tunnel daemon (with the admin UI's port included in ingress rules)" — but the tunnel ingress was synced in step 4 before the admin backend port was known (step 5). Step 016 handles this correctly by re-running ingress sync after the admin port is known, but the architecture description doesn't mention this re-sync.

### testing.md
- The "Deploy Pipeline" test section doesn't include a test for the deploy command handler (loading config, env, calling sync, then calling the pipeline). This reinforces the missing deploy command handler gap.
- The "Build Command" test at line 283 says "Building only operates on Pages services (local services with a `build` field are also built, but local services without `build` are skipped)" — the parenthetical contradicts the first clause. Should say "primarily operates on Pages services but also builds named local services that have a build field."

### overview.md
No issues. The step table accurately summarizes each step.

### 001.md
No issues. Well-scoped, clear deliverables, testable criteria.

### 002.md
- The `down_page` file-existence validation in `parseConfig()` contradicts the design of `parseConfig()` as a pure string-to-config parser. See suggestion above.
- Acceptance criterion for `functions` defaulting: "The `functions` field defaults to `functions/` relative to the service's directory" — but what is "the service's directory"? The config doesn't specify a service directory explicitly; services have a `dist` path. The relative base for the `functions` default is ambiguous.

### 003.md
No issues. Clean scope, clear deliverables, well-defined test plan.

### 004.md
- The "removal handling" behavior says "Compare the set of services in the current config against the services tracked in the lock file." But the sync function signature described takes "the parsed config, credentials, and the lock file state as parameters." It doesn't take the _previous_ config. How does it detect removals? It compares config services against lock file entries — lock file entries without matching config services are removals. This is clear enough on close reading but could be stated more explicitly.

### 005.md
- Dependency on step 006's naming convention (critical issue #2 above).
- The tunnel ingress sync function needs the admin port as a parameter, but step 005 doesn't mention this. Step 016 handles it by re-running ingress sync. Step 005's tunnel ingress function should accept the admin port (or a list of additional implicit services) as a parameter.

### 006.md
No issues. Clean scope, well-defined idempotency model.

### 007.md
No issues. Clear deliverables and test plan.

### 008.md
- Routing test approach is unclear (critical issue #5 above).
- Minor: the step says the generated source file's "filename must match what step 007's wrangler config generator sets as the `main` entry point." But the filename used by step 007 is not specified anywhere — it's an implementation detail of step 007. Cross-step coupling without a shared constant.

### 009.md
- Missing deploy command handler (critical issue #1).
- Large step — consider splitting (suggestion above).
- The "custom domain attachment" sub-step (step 7 of per-service deploy) references "the Pages project domains API" — should this use wrangler or the Cloudflare SDK? The spec doesn't specify.

### 010.md
No issues beyond the shared function timing concern (suggestion above).

### 011.md
- Tests require spawning real child processes with timing-dependent behavior (500ms stability window, exponential backoff). These tests may be flaky. Consider specifying that timing constants should be configurable/injectable for tests to use shorter values.
- The "backoff reset after sustained period" (e.g., 30 seconds) makes testing difficult. The test would need to wait 30+ seconds or mock time. Specify that the sustained period should be injectable for tests.

### 012.md
- Depends on hot-reload engine (step 013) — see suggestion above about defining the interface.
- Depends on frontend assets (steps 014/015) for static file serving tests. The step should clarify that tests use a dummy SPA directory with placeholder files.

### 013.md
No issues. Well-structured change categories with clear action mappings.

### 014.md
- Frontend test runner ambiguity (critical issue #4).
- The "build output embedding" mechanism is left as an implementation detail: "The exact embedding mechanism — file copying into a known path, or bundling into the package — is an implementation detail." The builder of step 012 needs to know where to find these files. There should be a shared, specified path.

### 015.md
- Frontend test runner ambiguity (critical issue #4).
- No issues otherwise. Well-specified WebSocket behavior and auto-scroll mechanics.

### 016.md
- Missing deploy command handler (critical issue #1).
- `flaregun down` mechanism underspecified (critical issue #3).
- Step 9 of the startup sequence says "Update tunnel ingress with admin port" — this is a good solution to the admin-port-not-known-at-sync-time problem. But it means calling `syncTunnelIngress` twice during startup (once during full sync in step 6, once in step 9). The first call doesn't have the admin port. Specify that the full sync in step 6 should skip or use a placeholder for the admin ingress rule, or that the first tunnel ingress sync is expected to be incomplete.

### 017.md
- The setup wizard creates a tunnel (step 3) which requires the account ID from step 1. But step 1 says "prompt for or automatically determine the account ID." If the user enters it manually, how does the wizard validate it? No validation is specified for the account ID itself (unlike the API token which has a test call).
- Minor: Step 2 says "Prompt for the identity provider name that the user configured." The config loader expects `auth.provider` as a string, but it's never validated against Cloudflare — any string is accepted. This is fine but could confuse users who enter something like "Google" vs "google".

### 018.md
- The lock file handling in step 6 (delete Pages projects) has a confusing self-correction: "Actually, since step 7 handles D1/R2/KV via the resource provisioner's destruction function which reads from its own section of the lock file..." This internal deliberation should be cleaned up into a clear directive. The current text reads like stream-of-consciousness and could confuse the builder.
- Good that it specifies saving the lock file after each deletion category (not just at the end) for crash resilience.

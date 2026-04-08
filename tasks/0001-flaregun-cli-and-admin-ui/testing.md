# Testing Plan

All tests run via Bun's built-in test runner (`bun test`). The existing personal-homepage project establishes the core testing patterns: mock Cloudflare SDK client with call tracking and in-memory state stores, dependency injection for testability, separate step functions mirroring production code, and async iterable pagination mocking.

## Unit Tests

### Config Loader

- [ ] A valid config with a Pages service (has `dist`) is parsed successfully and the service is classified as a Pages service
- [ ] A valid config with a local service (has `command` + `port`) is parsed successfully and the service is classified as a local service
- [ ] A config with a service that has both `dist` and `command`/`port` produces a validation error for ambiguous type
- [ ] A config with a service that has neither `dist` nor `command`/`port` produces a validation error for unrecognizable type
- [ ] Duplicate subdomains across services produce a validation error listing all duplicates
- [ ] Duplicate ports across local services produce a validation error listing all duplicates
- [ ] A service using the reserved subdomain `admin` produces a validation error
- [ ] A service using the reserved subdomain `down` produces a validation error
- [ ] Auth mode defaults to `admin_only` when not explicitly set on a service
- [ ] A `users` list on a service with auth mode `admin_only` produces a validation error
- [ ] A `users` list on a service with auth mode `public` produces a validation error
- [ ] A `users` list on a service with auth mode `authorized` is accepted
- [ ] A local service with `database: true` produces a validation error (cloud resources only for Pages)
- [ ] A local service with `bucket: true` produces a validation error
- [ ] A local service with `kv: true` produces a validation error
- [ ] A Pages service with `database: true`, `bucket: true`, and `kv: true` is accepted
- [ ] A config missing the `domain` field produces a validation error
- [ ] A config missing the `auth` section produces a validation error
- [ ] A config with an empty `superusers` list produces a validation error
- [ ] A config missing the identity `provider` field produces a validation error
- [ ] A config with a `down_page` path pointing to a non-existent file produces a validation error
- [ ] A config with a `down_page` path pointing to an existing file is accepted
- [ ] Multiple validation errors are collected and reported together (eager error collection)
- [ ] The `functions` field defaults to `functions/` relative to the service when not explicitly set on a Pages service
- [ ] The `max_retries` field is accepted on local services
- [ ] The `max_retries` field on a Pages service produces a validation error
- [ ] A config with zero services is accepted (valid but empty)
- [ ] Invalid YAML syntax produces a parse error
- [ ] A YAML file that parses to a non-object (e.g., a string or array) produces a validation error

### Config Differ

- [ ] Comparing two identical configs produces an empty diff (no additions, removals, or modifications)
- [ ] Adding a new service to the config produces a diff with that service listed as added
- [ ] Removing a service from the config produces a diff with that service listed as removed
- [ ] Changing a service's auth mode produces a diff with that service listed as modified with the auth field changed
- [ ] Changing a service's port produces a diff with that service listed as modified with the port field changed
- [ ] Changing a service's command produces a diff with that service listed as modified with the command field changed
- [ ] Changing the users list on a service produces a diff with that service listed as modified with the users field changed
- [ ] Changing the global superusers list produces a diff indicating a global auth change
- [ ] Changing only Pages-specific fields (dist, build, database, bucket, kv) produces a diff marking those as Pages-only changes
- [ ] Multiple services changed simultaneously are all represented in the diff
- [ ] Adding and removing services in the same diff are both captured

### Lock File Manager

- [ ] Loading a lock file that does not exist returns empty state (no error)
- [ ] Loading a valid lock file returns all tracked resource IDs
- [ ] Saving a lock file writes valid YAML to disk
- [ ] Saving and re-loading a lock file roundtrips all data correctly
- [ ] Looking up a resource ID for a service that exists returns the correct ID
- [ ] Looking up a resource ID for a service that does not exist returns nothing
- [ ] Storing a new resource ID updates the in-memory state
- [ ] Removing entries for a deleted service clears all that service's resource IDs
- [ ] Loading a lock file with invalid YAML produces a parse error
- [ ] The lock file never contains any environment variable values or secrets

### Environment Manager

- [ ] All four required variables present results in successful validation
- [ ] Missing `CLOUDFLARE_API_TOKEN` produces an error naming that specific variable
- [ ] Missing `CLOUDFLARE_ACCOUNT_ID` produces an error naming that specific variable
- [ ] Missing `CLOUDFLARE_ZONE_ID` produces an error naming that specific variable
- [ ] Missing `CLOUDFLARE_TUNNEL_TOKEN` produces an error when required (for `up` command)
- [ ] Missing `CLOUDFLARE_TUNNEL_TOKEN` does not produce an error when not required (for `deploy` command)
- [ ] Missing `.env` file produces a descriptive error suggesting `flaregun setup`
- [ ] Multiple missing variables are all reported in a single error message
- [ ] Variables are loaded from the `.env` file co-located with `flaregun.yml`

### Sync Engine — Access Applications

- [ ] A service with `admin_only` auth results in an Access application being created for its subdomain
- [ ] A service with `authorized` auth results in an Access application being created for its subdomain
- [ ] A service with `public` auth does not result in an Access application being created
- [ ] If an Access application already exists for the subdomain, no new application is created (idempotency)
- [ ] Running sync twice with the same config makes zero create calls on the second run
- [ ] The `admin` subdomain always gets an Access application with admin_only policy (implicit service)
- [ ] A service removed from config results in its Access application being deleted
- [ ] Application IDs are stored in the lock file after creation
- [ ] A service that changes from `authorized` to `public` results in its Access application being deleted
- [ ] A service that changes from `public` to `authorized` results in a new Access application being created

### Sync Engine — Access Policies

- [ ] An `admin_only` service gets a policy with only the superuser emails as allowed selectors
- [ ] An `authorized` service gets a policy combining superuser emails with per-service user emails
- [ ] Wildcard domain users (e.g., `*@family.com`) are converted to email_domain selectors in the policy
- [ ] Exact email users are converted to email selectors in the policy
- [ ] If a policy already exists for an Access application, no new policy is created (idempotency)
- [ ] When the user list changes for a service, the existing policy is updated with the new selectors
- [ ] When a service is removed, its policy is deleted along with its Access application
- [ ] Superusers are always included in every non-public policy regardless of the service's own user list

### Sync Engine — Tunnel Ingress

- [ ] Each local service produces an ingress rule mapping its subdomain to its localhost port
- [ ] The admin UI produces an implicit ingress rule for the `admin` subdomain
- [ ] Ingress rules are sorted alphabetically by subdomain for deterministic ordering
- [ ] A catch-all 404 rule is always appended as the last rule
- [ ] The entire ingress configuration is pushed as a full replacement (not incremental)
- [ ] Pages-only services do not appear in the tunnel ingress rules
- [ ] Removing a local service results in its rule being absent from the next ingress push

### Sync Engine — DNS Records

- [ ] A wildcard CNAME record is created pointing to the tunnel's cfargotunnel.com address
- [ ] If the wildcard CNAME already exists, no new record is created (idempotency)
- [ ] Per-Pages-service CNAME records are created for custom domain attachment
- [ ] DNS records for services removed from config are deleted
- [ ] The www CNAME for the root page is created

### Sync Engine — Redirect Rules

- [ ] A bare-domain-to-www 301 redirect rule is created via the Rulesets API
- [ ] If the redirect rule already exists, no new rule is created (idempotency)
- [ ] The redirect uses the correct domain name from the config

### Sync Engine — Full Sync

- [ ] A full sync with a multi-service config creates all expected resources (Access apps, policies, ingress rules, DNS records, redirect rules)
- [ ] A full sync run twice with the same config makes zero create calls on the second run (full idempotency)
- [ ] A full sync after adding a new service creates only the new service's resources
- [ ] A full sync after removing a service deletes that service's Access resources and updates ingress/DNS
- [ ] Sync steps execute in the correct dependency order (DNS before Pages custom domains, Access apps before policies)
- [ ] The lock file is updated after each successful sync step

### Resource Provisioner

- [ ] A service with `database: true` and no existing D1 database in the lock file results in a D1 database being created
- [ ] A service with `database: true` and an existing D1 database ID in the lock file does not create a new database (idempotency)
- [ ] A service with `bucket: true` results in an R2 bucket being created when not in the lock file
- [ ] A service with `kv: true` results in a KV namespace being created when not in the lock file
- [ ] A service with all three (`database`, `bucket`, `kv`) results in all three resources being created
- [ ] A service with no cloud resource declarations results in no provisioning calls
- [ ] Newly created resource IDs are stored in the lock file immediately after creation
- [ ] Resource names follow the convention derived from domain and service name
- [ ] Provisioning a resource that already exists in Cloudflare but not in the lock file creates a new resource (lock file is the source of truth)
- [ ] Destroying resources iterates all entries in the lock file and deletes each via the API
- [ ] Destroy continues even if individual deletions fail, logging each failure

### Deploy Pipeline

- [ ] Deploying a Pages service runs the service's build command first
- [ ] A build failure (non-zero exit code) prevents the deploy for that service but not others
- [ ] Functions are copied from the source directory into dist/functions/ before deployment
- [ ] If the service has cloud resources and functions/ exists, the copy happens
- [ ] If the service has cloud resources and functions/ does not exist, the scaffolder runs first, then the copy happens
- [ ] Resource provisioning runs after the build step and before wrangler deploy
- [ ] A wrangler.toml is generated with the correct project name, dist path, and resource bindings
- [ ] The generated wrangler.toml includes D1 binding with name `DB` when `database: true`
- [ ] The generated wrangler.toml includes R2 binding with name `BUCKET` when `bucket: true`
- [ ] The generated wrangler.toml includes KV binding with name `KV` when `kv: true`
- [ ] A service with no cloud resources gets a wrangler.toml with no bindings
- [ ] The fallback Worker is deployed separately from Pages services
- [ ] The fallback Worker wrangler.toml has a wildcard route pattern matching the domain
- [ ] Deploying a filtered subset of services only deploys the named services
- [ ] Deploying with no filter deploys all Pages services
- [ ] The `flaregun deploy` command handler loads config, environment, and lock file before deploying
- [ ] The deploy command handler runs the full sync engine before the deploy pipeline
- [ ] The deploy command handler validates environment variables (API token, account ID, zone ID) but does not require the tunnel token
- [ ] The build-scaffold-copy sequence is factored as a shared function reusable by the build command

### Functions Scaffolder

- [ ] When the functions source directory does not exist and the service declares `database: true`, a functions directory is created with an example handler referencing the database binding
- [ ] When the functions source directory does not exist and the service declares `bucket: true`, the example handler references the bucket binding
- [ ] When the functions source directory does not exist and the service declares `kv: true`, the example handler references the KV binding
- [ ] When the service declares multiple cloud resources, the scaffolded example references all declared bindings
- [ ] A tsconfig.json referencing `@cloudflare/workers-types` is created in the scaffolded directory
- [ ] When the functions source directory already exists, no scaffolding occurs (never overwrites)
- [ ] Scaffolding creates the directory at the path specified by the service's `functions` config field
- [ ] Scaffolding creates the directory at the default `functions/` path when no `functions` field is specified

### Wrangler Config Generator

- [ ] Generated Pages wrangler.toml contains the correct `pages_build_output_dir` pointing to the service's dist directory
- [ ] The project name follows the naming convention derived from domain and service name
- [ ] D1 bindings use the resource ID from the lock file and the binding name `DB`
- [ ] R2 bindings use the bucket name from the lock file and the binding name `BUCKET`
- [ ] KV bindings use the namespace ID from the lock file and the binding name `KV`
- [ ] A service with no cloud resources produces a wrangler.toml with no binding sections
- [ ] Generated fallback Worker wrangler.toml contains the correct Worker name derived from the domain
- [ ] Generated fallback Worker wrangler.toml contains the wildcard route pattern for the domain
- [ ] Generated files are placed in a temporary directory, not in user-visible locations

### Fallback Worker Generator

- [ ] The generated Worker source contains the domain name from config (not hardcoded)
- [ ] Requests to the bare domain are passed through to the origin
- [ ] Requests to the www subdomain are passed through to the origin
- [ ] Requests to the `down` subdomain serve the down page HTML directly
- [ ] Requests to other subdomains that return a successful response are passed through
- [ ] Requests to other subdomains where the origin returns a 5xx response redirect to the down page
- [ ] Requests to other subdomains where the fetch fails (network error) redirect to the down page
- [ ] When no custom down_page is specified, the built-in default HTML is used with the domain name substituted
- [ ] When a custom down_page HTML file is specified, its contents are embedded in the generated Worker source
- [ ] The generated Worker source is valid TypeScript

### Process Supervisor

- [ ] Starting a service transitions it from `starting` to `running` after surviving the initial window
- [ ] A process that exits immediately after spawn transitions to `crashed`
- [ ] A crashed service is restarted after an exponential backoff delay
- [ ] The backoff delay increases with each consecutive crash (exponential)
- [ ] The backoff resets after a service runs successfully for a sustained period
- [ ] When `max_retries` is configured and exceeded, the service transitions to `stopped` and is not restarted
- [ ] When `max_retries` is not configured, the service restarts indefinitely
- [ ] Stdout from a child process is captured in the rolling log buffer
- [ ] Stderr from a child process is captured in the rolling log buffer
- [ ] The log buffer does not grow beyond its bounded size (oldest entries are evicted)
- [ ] Shutdown sends a termination signal to all child processes
- [ ] Processes that do not exit within the graceful timeout are force-killed
- [ ] Multiple services can be supervised concurrently and independently
- [ ] Stopping a specific service transitions it to `stopped` and kills its process
- [ ] Restarting a specific service kills the current process and spawns a new one, resetting the restart count
- [ ] Service state queries return the current lifecycle state, uptime, and restart count

### Admin UI Backend

- [ ] Serving a request for the root path returns the index.html of the pre-built SPA
- [ ] Serving a request for a static asset (JS, CSS) returns the correct file with appropriate content type
- [ ] The config read endpoint returns the current contents of flaregun.yml
- [ ] The config validate endpoint accepts valid YAML and returns no errors
- [ ] The config validate endpoint rejects invalid config and returns the validation errors
- [ ] The config save endpoint writes the new YAML content to disk
- [ ] The config save endpoint rejects invalid YAML without writing to disk
- [ ] After a successful config save, the hot-reload engine is triggered
- [ ] The service list endpoint returns all services with their current states (running, crashed, stopped for local; deploy info for Pages)
- [ ] The service restart endpoint triggers a restart via the process supervisor and returns success
- [ ] The service stop endpoint triggers a stop via the process supervisor and returns success
- [ ] A WebSocket connection for log streaming receives log lines in real time as they are captured
- [ ] A WebSocket client can subscribe to logs for a specific service
- [ ] A WebSocket client can subscribe to a combined log stream for all services
- [ ] Disconnecting a WebSocket client does not affect other connected clients
- [ ] The backend selects an available port automatically at startup
- [ ] If the preferred port is unavailable, the backend tries additional ports

### Hot-Reload Engine

- [ ] Adding a local service to the config starts that service via the process supervisor
- [ ] Adding a local service with non-public auth creates an Access application and policy
- [ ] Adding a local service updates the tunnel ingress rules to include the new subdomain
- [ ] Removing a local service stops it via the process supervisor
- [ ] Removing a service with an Access application deletes the application and policy
- [ ] Removing a local service updates the tunnel ingress rules to exclude the old subdomain
- [ ] Changing a service's port restarts the service and updates ingress rules
- [ ] Changing a service's command restarts the service with the new command
- [ ] Changing a service's auth mode from `public` to `authorized` creates an Access application and policy
- [ ] Changing a service's auth mode from `authorized` to `public` deletes the Access application and policy
- [ ] Changing the users list on an `authorized` service updates its Access policy
- [ ] Changing the global superusers list updates all non-public Access policies
- [ ] Changes to Pages-only fields (dist, build, functions, database, bucket, kv) do not trigger any runtime actions
- [ ] The lock file is saved after any Cloudflare resources are modified
- [ ] A hot-reload failure reports the error but does not crash the running system

### CLI Entry Point

- [ ] Running `flaregun up` dispatches to the orchestrator
- [ ] Running `flaregun down` dispatches to the down handler
- [ ] Running `flaregun deploy` dispatches to the deploy pipeline
- [ ] Running `flaregun build` dispatches to the build command
- [ ] Running `flaregun setup` dispatches to the setup wizard
- [ ] Running `flaregun destroy` dispatches to the destroy command
- [ ] Running `flaregun --help` displays help text with all available commands
- [ ] Running `flaregun` with no arguments displays help text
- [ ] Running `flaregun invalidcommand` displays an error and help text
- [ ] `flaregun build homepage blog` passes the service name filter to the build command
- [ ] `flaregun deploy homepage` passes the service name filter to the deploy pipeline

### Build Command

- [ ] Building all services runs each service's build command
- [ ] Building a filtered subset of services only builds the named services
- [ ] A service with no build command is skipped without error
- [ ] A build failure for one service does not prevent building other services
- [ ] The command exits with a non-zero code if any build fails
- [ ] After building, functions/ is copied into dist/functions/ for services that have a functions directory
- [ ] After building, scaffolding runs for services with cloud resources but no functions directory
- [ ] Building primarily operates on Pages services; local services with a `build` field are also built when explicitly named, but local services without `build` are skipped

### Setup Wizard

- [ ] An API token entered by the user is validated by making a test API call to the Cloudflare SDK
- [ ] An invalid API token produces a descriptive error and re-prompts
- [ ] A tunnel is created programmatically via the Cloudflare SDK when a valid token is provided
- [ ] The generated `.env` file contains all four required environment variables
- [ ] The generated `flaregun.yml` contains the user's domain, auth section, and a homepage service
- [ ] Setup does not overwrite an existing `.env` file without confirmation
- [ ] Setup does not overwrite an existing `flaregun.yml` without confirmation

### Destroy Command

- [ ] Destroy requires explicit confirmation before proceeding
- [ ] Without confirmation, destroy exits without deleting anything
- [ ] Destroy deletes all Access applications and policies listed in the lock file
- [ ] Destroy deletes the tunnel
- [ ] Destroy deletes all DNS records managed by flaregun
- [ ] Destroy deletes the fallback Worker
- [ ] Destroy deletes all Pages projects
- [ ] Destroy deletes all D1 databases, R2 buckets, and KV namespaces listed in the lock file
- [ ] Destroy clears the lock file after successful deletion
- [ ] If an individual deletion fails, destroy continues with remaining resources and reports the failures
- [ ] The lock file retains entries for resources that failed to delete

### Access Selector Utilities

- [ ] An exact email string is identified as a non-wildcard
- [ ] A wildcard domain string (e.g., `*@family.com`) is identified as a wildcard
- [ ] Extracting the domain from a wildcard selector returns the domain portion
- [ ] Merging superusers with a service's user list produces a deduplicated combined list
- [ ] Converting a list of users to Access selectors produces email selectors for exact emails and email_domain selectors for wildcard domains

### Process Utilities

- [ ] Checking for a binary that exists on PATH returns true
- [ ] Checking for a binary that does not exist on PATH returns false
- [ ] Running a command that succeeds returns exit code 0 and captured stdout
- [ ] Running a command that fails returns a non-zero exit code and captured stderr
- [ ] Running a command respects the specified working directory

## Integration Tests

### Config → Sync → Lock File Flow

- [ ] Loading a config, running a full sync against the mock Cloudflare SDK, and saving the lock file results in a lock file with all expected resource IDs
- [ ] Loading the lock file from the previous sync, running the same config through sync again, and verifying zero create/delete calls are made (end-to-end idempotency)
- [ ] Loading a config with a new service, running sync, and verifying only the new service's resources are created (incremental sync)
- [ ] Loading a config with a removed service, running sync, and verifying that service's Access resources are deleted and the lock file no longer contains its entries

### Config → Deploy → Lock File Flow

- [ ] Loading a config with cloud resources, running the deploy pipeline with the mock SDK and a mock command runner, and verifying that resources are provisioned, wrangler.toml is generated with correct bindings, and the lock file is updated
- [ ] Running deploy twice with the same config verifies that resources are not re-provisioned on the second run

### Config Save → Hot-Reload → Process Supervisor Flow

- [ ] Saving a new config via the admin backend endpoint that adds a local service results in the process supervisor spawning that service
- [ ] Saving a new config via the admin backend endpoint that removes a local service results in the process supervisor stopping that service
- [ ] Saving a new config via the admin backend endpoint that changes a service's auth mode results in the correct Access application create/delete calls

### Orchestrator Startup → Shutdown Flow

- [ ] The orchestrator validates prerequisites, runs sync, starts the admin UI, starts local services, and starts the tunnel in the correct order (using injected dependencies to verify call order)
- [ ] The orchestrator writes a PID file after all subsystems start
- [ ] Sending a termination signal to the orchestrator stops the tunnel, then local services, then the admin UI in the correct order, and deletes the PID file
- [ ] The `down` command reads the PID file and sends SIGTERM to the running process
- [ ] The `down` command detects and cleans up a stale PID file
- [ ] A missing prerequisite (e.g., cloudflared not on PATH) aborts startup before any services are started

### Build → Functions Scaffold → Functions Copy Flow

- [ ] Running the build command on a service with `database: true` and no functions/ directory scaffolds the directory, then copies it into dist/functions/
- [ ] Running the build command on a service with an existing functions/ directory copies it into dist/functions/ without scaffolding
- [ ] Running the build command on a service with no cloud resources and no functions/ directory does not scaffold or copy anything

### Admin UI Backend → WebSocket → Log Streaming Flow

- [ ] A WebSocket client connecting to the log endpoint and subscribing to a service receives log lines that the process supervisor captures from that service's stdout/stderr
- [ ] Multiple WebSocket clients subscribed to different services each receive only their subscribed service's logs
- [ ] A combined stream subscription delivers logs from all services

### Fallback Worker → Custom Down Page Flow

- [ ] Generating the fallback Worker with no custom down_page produces a Worker that serves the built-in default HTML (containing the domain name)
- [ ] Generating the fallback Worker with a custom down_page path reads the file and embeds its HTML in the Worker source

## Browser/E2E Tests

### Config Editor

- [ ] The config editor loads and displays the current flaregun.yml content
- [ ] Editing the YAML to introduce a validation error shows the error inline without saving
- [ ] Editing the YAML to valid content and clicking save writes the changes and shows a success confirmation
- [ ] After a successful save, the service dashboard reflects any service additions or removals from the config change

### Service Dashboard

- [ ] The service dashboard shows all services from the config with their current status
- [ ] A running local service displays its state as "running" with an uptime counter
- [ ] A crashed local service displays its state as "crashed" with the restart count
- [ ] Clicking the restart button on a local service transitions it through restarting → running
- [ ] Clicking the stop button on a local service transitions it to stopped

### Log Viewer

- [ ] Selecting a service in the log viewer displays its log output
- [ ] New log lines appear in real time as the service produces output (WebSocket streaming)
- [ ] The log viewer auto-scrolls to the bottom as new lines arrive
- [ ] Switching between services in the log viewer shows each service's logs independently

### Tunnel Status

- [ ] When the tunnel is connected, the status indicator shows connected
- [ ] When the tunnel disconnects, the status indicator updates to show disconnected

## Manual Testing

**None** — all verification must be automated.

# Step 006: Resource Provisioner

## What was implemented
- `src/sync/provision.ts` — provisioning and destruction functions for D1/R2/KV resources
- Extended `tests/helpers/mock-client.ts` with D1, R2, KV mock methods
- `tests/sync/provision.test.ts` — 34 tests covering all acceptance criteria

## Key patterns
- Provisioner uses dependency-injected Cloudflare SDK client (same as sync engine)
- Idempotency via lock file: `lookupResource()` before create, `storeResource()` after create
- Lock file is sole source of truth — no remote state verification
- Resource naming: `resourceName(domain, service)` from `src/naming.ts` + type suffix (`-db`, `-bucket`, `-kv`)
- Destruction continues on individual failures; successful deletes removed from lock state, failed ones remain

## SDK method signatures used
- D1: `client.d1.database.create({ account_id, name })` → `{ uuid, name }`
- D1: `client.d1.database.delete(databaseId, { account_id })`
- R2: `client.r2.buckets.create({ account_id, name })` → `{ name }`
- R2: `client.r2.buckets.delete(bucketName, { account_id })`
- KV: `client.kv.namespaces.create({ account_id, title })` → `{ id, title }`
- KV: `client.kv.namespaces.delete(namespaceId, { account_id })`

## Mock client extensions
Added to `createMockClient()`:
- State stores: `d1Databases`, `r2Buckets`, `kvNamespaces`
- Mock types: `MockD1Database`, `MockR2Bucket`, `MockKVNamespace`
- Tracked methods: `d1.database.create/delete`, `r2.buckets.create/delete`, `kv.namespaces.create/delete`
- State manipulation: `setDatabases/getDatabases`, `setBuckets/getBuckets`, `setNamespaces/getNamespaces`

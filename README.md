# pi-durable-couchdb

Experimental CouchDB storage for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable). An **SDK library**, not a Pi Coding Agent extension: install with your application's package manager, not `pi install`.

Initial implementation inspired by the PostgreSQL backend's standalone package layout and Pi's JSONL backend's prepare/persist/publish/replay design. No upstream source code is copied.

## Status and compatibility

- Alpha; not yet published to npm. Package name is provisional.
- Pi Durable and Chord **1.3.0**, pinned because the storage API is experimental.
- Node.js **22.19+**; development verified on Node 24.
- CouchDB **3.5.0**, verified with a single-node Docker instance.
- Full committed history is loaded into memory. No snapshots, garbage collection, or bounded-memory reads yet.
- One externally coordinated Harness owner per database. **No ownership election or distributed lock is implemented.**
- Cluster partitions, active-active replication, failover between independently writable replicas, and power-loss durability have not been validated. Do not treat `_rev` as a global distributed lock.

## Install locally

```sh
npm ci
npm run check
npm pack
# In the host application, install the generated tarball:
npm install /path/to/pi-durable-couchdb-0.1.0-alpha.0.tgz
npm install @earendil-works/pi-durable@1.3.0 @earendil-works/chord@1.3.0 @earendil-works/pi-ai@1.3.0
```

The package builds ESM JavaScript, declarations, and source maps. `npm pack` and `npm publish` build through `prepack`; nothing has been published automatically.

## Use

Provision an **existing, dedicated database** first. The adapter does not create databases, change server settings, or write indexes/design documents. The application must register providers and select a model before submitting model input.

```typescript
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { openCouchDbStorage } from 'pi-durable-couchdb';

const storage = await openCouchDbStorage({
  url: 'http://127.0.0.1:5984/agent_state',
  headers: { Authorization: `Basic ${Buffer.from(process.env.COUCHDB_AUTH!).toString('base64')}` },
  timeoutMs: 30_000,
});
try {
  const harness = await Harness.open(storage, {
    models: createModels(),
    registry: createRegistry(),
  }, context);
  try {
    const root = await harness.root(context);
    harness.resume();
    console.log(root.id);
  } finally {
    await harness.close(context);
  }
} finally {
  // Also handles failed Harness.open(); repeat close is safe.
  await storage.close(context);
}
```

Use TLS and application-specific credentials outside local development. Credentials in URLs and redirects are rejected. The HTTP client applies a per-request timeout and does not retry writes. Cancellation of a caller must not be interpreted as rollback of an admitted write.

`CouchDbStorage.open(database)` accepts a minimal `CouchDatabase` transport (`get` and revision-checked `put`) for alternative clients and testing. It must provide read-after-write access to the authoritative database, return document revisions, reject stale writes, and never silently resolve conflicts. Custom transports must reject replicated conflicts too.

## Application-layer atomicity

CouchDB's `_bulk_docs` is not a transaction. This backend does not use it.

1. Validate and detach the batch using upstream `MemoryStorage.prepareCommit()`.
2. Store the entire batch in a new immutable `pi:commit:<uuid>` document, including its parent ID and sequence.
3. Update `pi:head` using its expected `_rev`.
4. Only after successful publication apply the batch to in-memory state and resolve the commit.

The head update is the logical commit point. Readers use only the local committed view; reopening reads the head and walks exact commit IDs, validates ancestry, and replays the journal. No Mango/view index or search visibility is involved. All public storage operations are serialized within the instance.

Batches are stored as JSON-encoded strings (`writesJson`) inside the journal envelope. This preserves JavaScript strings with lone UTF-16 surrogates, which CouchDB rejects if decoded directly as JSON strings/keys.

### Failure semantics

| Failure | Behavior |
| --- | --- |
| Batch validation fails | No persistent write; instance remains usable |
| Journal write fails | Fail closed; reopen before further use |
| Head publication fails or times out | Outcome uncertain; fail closed and reopen |
| Journal exists but head was not published | Ignore unreachable journal document |
| Head published but response lost | Reopening recovers the committed batch |
| Published journal data missing or invalid | Opening fails; never serve partial state |
| Stale head revision | Fail closed, rather than rebasing unknown Harness state |

After an I/O failure, even reads reject because the in-memory view may be stale. `close()` remains available. Stop the Harness and open a new storage/Harness pair; do not reuse cached handles. There is no automatic storage-write retry or transaction receipt API. Pi submission `requestId` is the input-deduplication boundary, not a guarantee about arbitrary external effects.

ID allocations are persisted by updating the head counter **before returning an ID**, including allocations not subsequently used in a commit. Gaps are valid.

### Operational boundaries

- Do not mutate journal/head documents outside the adapter, or let TTL/retention jobs remove them.
- Unpublished documents currently accumulate. There is no safe cleanup/export/import tool yet.
- CouchDB `_rev` is a concurrency token, not retained application history. Explicit journal documents carry history.
- Replication does not atomically copy head and dependencies. Recover only from a complete authoritative copy; missing dependencies fail closed. HTTP reads request conflict metadata and reject conflicting revisions.
- A second owner can read stale state until its next write conflicts. Prevent concurrent owners externally; CAS is a publication guard, not ownership management.
- One Pi commit must fit one CouchDB document/request. Tune deployment limits or reject oversized workloads; there is no chunking.
- Acknowledged-write durability depends on CouchDB topology/configuration and infrastructure. Tests cover application restart and ambiguous responses, not power loss.
- Forks share Pi's logical history semantics through the upstream memory implementation; the storage journal itself is linear.
- Storage schema `format: 1` is recognized; unknown formats are rejected. No migration tooling yet.

## Tests

```sh
npm run check                         # types, fake transport tests, build

docker compose up -d --wait
COUCHDB_TEST_URL=http://127.0.0.1:15984 npm run check
docker compose down
```

Compose binds CouchDB to loopback only, with disposable local-test credentials. Tests create and delete only uniquely named `pi_durable_test_*` databases. Never point integration tests at production. Set `COUCHDB_TEST_AUTH=user:password` for another test server. Without `COUCHDB_TEST_URL`, integration tests are explicitly skipped.

Tests include:
- All 24 upstream storage conformance cases against a deterministic fake transport.
- The same 24 cases with recovery after **every commit**.
- All 24 cases against real CouchDB.
- Reopening, persistent unused IDs, simultaneous allocations, publication conflicts, validation-before-write, missing published data, journal-write failure, and response loss before/after publication.

## References

- [PostgreSQL adapter](https://github.com/j-koester/pi-durable-postgres)
- [Pi JSONL implementation](https://github.com/earendil-works/pi/blob/main/packages/durable/src/storage/jsonl/storage.ts)
- [Pi storage documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#storage)
- [CouchDB bulk transaction semantics](https://docs.couchdb.org/en/stable/api/database/bulk-api.html)

## License

MIT. See LICENSE. Upstream packages retain their own licenses.

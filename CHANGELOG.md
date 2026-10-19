# Changelog

Subsequent releases are generated from `.changeset/*.md` using Changesets. The initial release entry is maintained manually until publication.

## 0.0.1

Initial experimental release, prepared for manual publication. This entry does not indicate that the package has already been published.

### Features

- CouchDB storage for Pi Durable and Chord 1.3.0, using an immutable commit journal and revision-checked head publication for application-layer atomicity.
- Replay recovery, persistent unused ID allocations, serialized operations, and fail-closed handling of failed or ambiguous writes.
- ESM JavaScript, TypeScript declarations, source maps, and MIT licensing.
- Upstream conformance and recovery tests, real CouchDB 3.5.0 Testcontainers coverage, and an isolated consumer tarball smoke test.

### Limitations

- One externally coordinated Harness owner per database; no distributed ownership lock.
- Entire committed history is loaded into memory; no snapshots, garbage collection, or chunked commits.
- Active-active replication, cluster partitions, and power-loss durability are not validated.
- Strict consumer compilation may require the upstream Google SDK's optional MCP peer; see README.

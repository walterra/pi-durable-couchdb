# Changesets

For a user-visible change, run `npm run changeset`, select the bump, and write a concise summary of the behavior and any compatibility changes. Commit the generated Markdown file with the change. Tests/docs-only maintenance does not always need a release.

After merging to `main`, the enabled release workflow collects changesets into a version PR. It updates `package.json`, `package-lock.json`, and `CHANGELOG.md`. Review and merge that PR to publish after verification. Do not manually bump versions for normal releases.

Breaking changes must be clearly described; choose version bumps deliberately, especially before 1.0. Changesets does not check API compatibility. Keep exact upstream peer pins until conformance and consumer tests validate an update.

The initial `0.0.1` is manually bootstrapped with a hand-written changelog entry; it deliberately has no initial changeset. The first subsequent patch changeset will prepare `0.0.2`.

See [the release guide](../docs/releasing.md) for one-time setup, publishing, and recovery. Never run `npm run release` casually: it can publish to npm and create local tags.

# Releasing

- Source: https://github.com/walterra/pi-durable-couchdb
- npm: `pi-durable-couchdb`
- Package manager: npm; commit `package-lock.json`.
- Initial `0.0.1`: manual publish, tag, and GitHub release.
- Later versions: Changesets release PR, verified publication via npm OIDC, GitHub release.

## Safety boundaries

No publication happens from pull requests. The release workflow runs only on `main` and only when repository variable `RELEASE_AUTOMATION` is exactly `true`. It requires the reusable check matrix (Node 22/24, unit/integration tests, build, strict tarball consumer test) to pass for the release commit. Publication is serialized without canceling in-progress releases. It also verifies that the manual `0.0.1` exists on npm before running Changesets.

The `npm-publish` GitHub environment applies to both release-PR preparation and publication. If it requires approval, approve either kind of run deliberately. Review that environment's allowed branches and reviewer rules. GitHub branch protection should require checks for normal and generated release PRs.

Never reuse an npm version. npm publication, Git tags, and GitHub releases are separate operations; failure does not imply that none succeeded. Inspect all three before retrying.

## Initial 0.0.1: manual bootstrap

Automation must remain disabled until this section and the one-time setup below are complete. Do not create an initial patch changeset: that would bump the prepared `0.0.1` to `0.0.2`.

### 1. Confirm identity and availability

```sh
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm view pi-durable-couchdb --registry=https://registry.npmjs.org
```

For a new package, only an actual registry E404 establishes absence; authentication or network failures do not. If the name is owned by someone else, stop and choose another name/scope before proceeding. Do not publish over an unrelated package. Confirm your npm account has permission and 2FA configured as required by npm.

### 2. Prepare and verify

Update the initial CHANGELOG entry to describe the actual release, removing the "prepared for manual publication" disclaimer. Add the actual date if desired. Review README compatibility and all limitations. Then:

```sh
npm ci
npm run check
npm run test:package
npm audit
npm pack --dry-run
npm publish --dry-run --access public --registry=https://registry.npmjs.org --provenance=false
```

Docker must be running. The pack must contain runtime JS, declarations, sources, license, changelog, README, and release guide, but no credentials or test data. The manual bootstrap disables provenance because a local shell does not have GitHub Actions' OIDC identity. Automated publication retains provenance.

Commit and push the reviewed release preparation (through a PR if branch policy requires it). Publish only from its clean checkout after CI is green:

```sh
git switch main
git pull --ff-only
git status --short                  # must be empty
node -p "require('./package.json').version"  # must be 0.0.1
npm publish --access public --registry=https://registry.npmjs.org --provenance=false
```

Authenticate/approve 2FA when npm requests it. Nothing in this repository publishes merely by running `npm install`, `npm test`, or `npm pack`.

### 3. Verify npm, then tag the exact release commit

```sh
npm view pi-durable-couchdb@0.0.1 version dist.integrity gitHead --registry=https://registry.npmjs.org
git rev-parse HEAD                   # compare with gitHead when present

git tag -a v0.0.1 -m "Release v0.0.1"
git push origin v0.0.1
```

Create GitHub release `v0.0.1` using only the `0.0.1` CHANGELOG section as notes. For example, save that section (without the unreleased disclaimer) to a temporary file and run:

```sh
gh release create v0.0.1 --verify-tag --title "v0.0.1" --notes-file /path/to/0.0.1-notes.md
```

Do not create a new commit between publishing and tagging.

## One-time GitHub/npm setup for later releases

1. Install/authorize the existing release GitHub App on `walterra/pi-durable-couchdb`. It needs repository contents and pull-request write permissions. Set repository variable `APP_ID` and secret `APP_PRIVATE_KEY`; never commit credentials. App-created release PRs should trigger normal CI, unlike many operations performed with the default Actions token.
2. Create GitHub environment **`npm-publish`**, restricted to `main`, with the desired required reviewers. Enable Actions' ability to create PRs and check branch rules permit the release App's normal workflow; do not bypass review requirements casually.
3. On npm, after `0.0.1` exists, configure a **GitHub Actions trusted publisher** for this package:
   - Owner: `walterra`
   - Repository: `pi-durable-couchdb`
   - Workflow filename: **`release.yml`**
   - Environment: **`npm-publish`**
4. The workflow grants `id-token: write`, uses a hosted Ubuntu runner, and installs npm **11.19.1** (trusted-publishing capable). `publishConfig.provenance` is true. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` should be supplied for publication. The GitHub App token authenticates GitHub operations, not npm.
5. Once settings and the manual release are verified, enable automation:

```sh
gh variable set RELEASE_AUTOMATION --body true --repo walterra/pi-durable-couchdb
```

The next push to `main` runs it; `gh workflow run release.yml --ref main` can also trigger it deliberately. Disable via the same variable with `--body false`. A variable change does not cancel an already running publication; inspect active runs before emergency intervention.

## Normal releases

1. For user-visible changes, run `npm run changeset`. Select this package, the appropriate patch/minor/major bump, and write release notes including any migration or compatibility requirements. Commit the generated file with the change.
2. Merge the reviewed feature PR. On `main`, Changesets creates or updates `changeset-release/main` with package version, lockfile, and generated CHANGELOG changes. It does not publish pending unversioned changesets.
3. Review the release PR: version, notes, exact upstream compatibility pins, lockfile changes, and CI. Merging it is the release decision.
4. The release workflow verifies that merge commit, then `changeset publish` publishes versions absent from npm. The action pushes tags and creates GitHub releases. For a single package, expect `vX.Y.Z`; confirm the actual output.
5. Verify registry version/integrity, Git tag, and GitHub release. Never assume a green PR alone means publication happened.

`npm run version-packages` runs Changesets then synchronizes `package-lock.json` with scripts disabled. The version command is for automation/release preparation, not ordinary feature development. `npm run release` is a real publish command; do not use it as a dry run.

## Recovery

- **Tests fail:** no release job should run. Fix and repeat through reviewed changes.
- **npm authentication fails:** verify trusted-publisher repository, workflow filename, environment, npm version, permissions, and package ownership. Do not introduce a long-lived token just to bypass a mismatch.
- **Publish times out:** query npm for the exact version and inspect its metadata before retrying. If it exists, confirm it belongs to the expected release commit/artifact; never overwrite or accept an unrelated version.
- **npm succeeded but tag/release failed:** Changesets may skip an already published package on rerun, so rerunning does not guarantee missing GitHub artifacts are repaired. Identify the published source commit, verify npm `gitHead` when available, then create only the missing tag/release for that commit. If a tag exists, inspect its target first; do not move release tags casually.
- **Bad contents were published:** fix and publish a new version with a changeset. Deprecate the bad version if appropriate. Do not reuse the version or rely on unpublishing as rollback.

## Compatibility maintenance

Pi Durable is experimental. Keep the exact Pi Durable and Chord peer pins aligned with tested development versions. Re-run all conformance/recovery tests and the consumer smoke test before claiming another version is supported. Include compatibility changes in a changeset; changing a range is not evidence of compatibility.

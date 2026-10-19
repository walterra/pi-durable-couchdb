import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'pi-durable-couchdb-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd, stdio: 'inherit', timeout: 180_000,
    shell: process.platform === 'win32',
  });
}
function write(name, value) {
  writeFileSync(join(work, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

try {
  // Exercise prepack and the actual published file allowlist, not a source alias.
  run(npm, ['pack', '--pack-destination', work], root);
  const tarballs = readdirSync(work).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'Expected exactly one packed tarball');
  write('package.json', {
    private: true,
    type: 'module',
    dependencies: {
      [manifest.name]: `file:${join(work, tarballs[0])}`,
      // Exact tested peers, never whatever npm happens to resolve as latest.
      ...manifest.peerDependencies,
    },
    devDependencies: {
      typescript: manifest.devDependencies.typescript,
      '@types/node': manifest.devDependencies['@types/node'],
      // Upstream @google/genai declarations reference this optional peer even
      // without Gemini usage. Same fixture-only workaround as the PG adapter.
      '@modelcontextprotocol/sdk': '^1.25.2',
    },
  });
  // Separate directory: repository devDependencies cannot satisfy imports here.
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund'], work);
  const installed = JSON.parse(readFileSync(join(work, 'node_modules', manifest.name, 'package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version);
  for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/client.js', 'dist/client.d.ts', 'LICENSE', 'README.md']) {
    assert.ok(readFileSync(join(work, 'node_modules', manifest.name, file)).length, `Missing packed file: ${file}`);
  }
  write('smoke.ts', `
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, type Storage, type HarnessOptions } from '@earendil-works/pi-durable';
import {
  CouchDbStorage, CouchHttpError, couchDatabase, openCouchDbStorage,
  type CouchDatabase, type CouchDocument, type HttpOptions,
} from '${manifest.name}';

assert.equal(typeof CouchDbStorage.open, 'function');
assert.equal(typeof openCouchDbStorage, 'function');
assert.equal(typeof couchDatabase, 'function');
assert.equal(new CouchHttpError(409).status, 409);
const options: HttpOptions = { url: 'https://example.invalid/agent_state' };
// This creates a client but does not make a network request.
const database: CouchDatabase = couchDatabase(options);
assert.equal(typeof database.get, 'function');
assert.equal(typeof database.put, 'function');
const document: CouchDocument = { _id: 'example', content: 'consumer type check' };
void document;

// Compile real integration types; do not contact CouchDB or a model provider.
async function example(database: CouchDatabase, options: HarnessOptions) {
  const storage: Storage = await CouchDbStorage.open(database);
  const harness = await Harness.open(storage, options, context);
  try { return await harness.root(context); }
  finally { await harness.close(context); }
}
void example;
console.log('Package smoke test passed: installed tarball, public imports, strict consumer types');
`);
  write('tsconfig.json', {
    compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      skipLibCheck: false, outDir: 'out', types: ['node'],
    },
    include: ['smoke.ts'],
  });
  run(process.execPath, [join(work, 'node_modules/typescript/bin/tsc')], work);
  run(process.execPath, [join(work, 'out/smoke.js')], work);
} finally {
  rmSync(work, { recursive: true, force: true });
}

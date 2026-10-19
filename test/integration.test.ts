import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { ConversationId } from '@earendil-works/pi-durable';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { openCouchDbStorage, couchDatabase, CouchDbStorage } from '../src/index.js';

const server = process.env.COUCHDB_TEST_URL;
const headers = { Authorization: `Basic ${Buffer.from(process.env.COUCHDB_TEST_AUTH ?? 'durable:local-test-only').toString('base64')}` };
async function fixture(use: (url: string) => Promise<void>) {
  const url = `${server!.replace(/\/$/, '')}/pi_durable_test_${randomUUID().replaceAll('-', '')}`;
  const created = await fetch(url, { method: 'PUT', headers });
  if (!created.ok) throw new Error(`Test database creation failed: ${created.status}`);
  try { await use(url); }
  finally {
    const deleted = await fetch(url, { method: 'DELETE', headers });
    if (!deleted.ok) throw new Error(`Test database cleanup failed: ${deleted.status}`);
  }
}
const runner = { describe: server ? describe : describe.skip, it, expect };
registerStorageConformance(runner, 'real CouchDB conformance', async (use) => {
  await fixture(async (url) => {
    const storage = await openCouchDbStorage({ url, headers });
    try { await use(storage); } finally { await storage.close(context); }
  });
});
(server ? describe : describe.skip)('real CouchDB recovery', () => {
  it.each([false, true])('reconciles a head response failure (published=%s)', async (published) => {
    await fixture(async (url) => {
      const database = couchDatabase({ url, headers });
      let fail = false;
      const storage = await CouchDbStorage.open({
        get: (id) => database.get(id),
        put: async (doc) => {
          if (fail && doc._id === 'pi:head') {
            if (published) await database.put(doc);
            throw new Error('Injected connection loss');
          }
          return database.put(doc);
        },
      });
      const id = await storage.mintId<ConversationId>();
      fail = true;
      await expect(storage.commit([{ type: 'conversation', value: { id } }], context)).rejects.toThrow('close and reopen');
      await expect(storage.conversation(id, context)).rejects.toThrow('close and reopen');
      await storage.close(context);
      const recovered = await openCouchDbStorage({ url, headers });
      try { expect(Boolean(await recovered.conversation(id, context))).toBe(published); }
      finally { await recovered.close(context); }
    });
  });
  it('reopens the journal and preserves unused allocations', async () => {
    await fixture(async (url) => {
      const storage = await openCouchDbStorage({ url, headers });
      const id = await storage.mintId<ConversationId>();
      await storage.commit([{ type: 'conversation', value: { id } }], context);
      const unused = await storage.mintId();
      await storage.close(context);
      const recovered = await openCouchDbStorage({ url, headers });
      try {
        expect((await recovered.conversation(id, context))?.id).toBe(id);
        expect(await recovered.mintId()).toBeGreaterThan(unused);
      } finally { await recovered.close(context); }
    });
  });
});

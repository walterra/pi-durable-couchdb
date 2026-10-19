import { describe, it, expect } from 'vitest';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { ConversationId, StorageWrite } from '@earendil-works/pi-durable';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { CouchDbStorage, CouchHttpError, type CouchDatabase, type CouchDocument } from '../src/index.js';

class FakeDatabase implements CouchDatabase {
  docs = new Map<string, CouchDocument>();
  fail: 'before-head' | 'after-head' | 'commit' | undefined;
  async get(id: string) { return structuredClone(this.docs.get(id)); }
  async put(doc: CouchDocument) {
    if (doc._id.startsWith('pi:commit:') && this.fail === 'commit') throw new Error('write failure');
    const current = this.docs.get(doc._id);
    if (current ? current._rev !== doc._rev : doc._rev !== undefined) throw new CouchHttpError(409);
    if (doc._id === 'pi:head' && this.fail === 'before-head') throw new Error('disconnected');
    const rev = `${Number(String(current?._rev ?? '0').split('-')[0]) + 1}-test`;
    this.docs.set(doc._id, structuredClone({ ...doc, _rev: rev }));
    if (doc._id === 'pi:head' && this.fail === 'after-head') throw new Error('response lost');
    return { rev };
  }
}
registerStorageConformance({ describe, it, expect }, 'CouchDB journal', async (use) => {
  const storage = await CouchDbStorage.open(new FakeDatabase());
  try { await use(storage); } finally { await storage.close(context); }
});

registerStorageConformance({ describe, it, expect }, 'CouchDB replay after every commit', async (use) => {
  const db = new FakeDatabase();
  let storage = await CouchDbStorage.open(db);
  const handle = new Proxy(storage, {
    get(_target, key) {
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(Reflect.get(storage, key) as (...args: unknown[]) => unknown, storage, args);
        if (key === 'commit') {
          await storage.close(context);
          storage = await CouchDbStorage.open(db);
        }
        return result;
      };
    },
  });
  try { await use(handle); } finally { await storage.close(context); }
});

// The fixture shape follows the published StorageWrite union, not a model call.
function conversation(id: ConversationId): StorageWrite {
  return { type: 'conversation', value: { id } };
}

describe('publication recovery', () => {
  it('persists allocated but unused IDs across reopen', async () => {
    const db = new FakeDatabase();
    const storage = await CouchDbStorage.open(db);
    const first = await storage.mintId();
    await storage.close(context);
    const reopened = await CouchDbStorage.open(db);
    expect(await reopened.mintId()).toBeGreaterThan(first);
  });
  it('replays published batches after reopening', async () => {
    const db = new FakeDatabase();
    const storage = await CouchDbStorage.open(db);
    const id = await storage.mintId<ConversationId>();
    await storage.commit([conversation(id)], context);
    await storage.close(context);
    const reopened = await CouchDbStorage.open(db);
    expect((await reopened.conversation(id, context))?.id).toBe(id);
  });
  it.each(['before-head', 'after-head'] as const)('fails closed on %s and reconciles on reopen', async (failure) => {
    const db = new FakeDatabase();
    const storage = await CouchDbStorage.open(db);
    const id = await storage.mintId<ConversationId>();
    db.fail = failure;
    await expect(storage.commit([conversation(id)], context)).rejects.toThrow('close and reopen');
    await expect(storage.conversation(id, context)).rejects.toThrow('close and reopen');
    await storage.close(context);
    db.fail = undefined;
    const reopened = await CouchDbStorage.open(db);
    expect(Boolean(await reopened.conversation(id, context))).toBe(failure === 'after-head');
  });
  it('leaves a failed journal write unpublished', async () => {
    const db = new FakeDatabase();
    const storage = await CouchDbStorage.open(db);
    const id = await storage.mintId<ConversationId>();
    db.fail = 'commit';
    await expect(storage.commit([conversation(id)], context)).rejects.toThrow('close and reopen');
    db.fail = undefined;
    const reopened = await CouchDbStorage.open(db);
    expect(await reopened.conversation(id, context)).toBeUndefined();
  });
  it('serializes simultaneous allocations', async () => {
    const storage = await CouchDbStorage.open(new FakeDatabase());
    const ids = await Promise.all(Array.from({ length: 20 }, () => storage.mintId()));
    expect(new Set(ids).size).toBe(20);
  });
  it('rejects a stale owner on its next publication', async () => {
    const db = new FakeDatabase();
    const first = await CouchDbStorage.open(db);
    const second = await CouchDbStorage.open(db);
    await first.mintId();
    await expect(second.mintId()).rejects.toThrow('close and reopen');
  });
  it('fails recovery if published data is missing', async () => {
    const db = new FakeDatabase();
    const storage = await CouchDbStorage.open(db);
    await storage.commit([], context);
    const head = db.docs.get('pi:head')!;
    db.docs.delete(head.commitId as string);
    await expect(CouchDbStorage.open(db)).rejects.toThrow('Missing or corrupt');
  });
  it('validates before writing anything', async () => {
    const db = new FakeDatabase();
    const storage = await CouchDbStorage.open(db);
    const before = db.docs.size;
    await expect(storage.commit([{ type: 'invalid' } as unknown as StorageWrite], context)).rejects.toThrow();
    expect(db.docs.size).toBe(before);
  });
});

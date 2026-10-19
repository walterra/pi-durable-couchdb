import { randomUUID } from 'node:crypto';
import type { Context } from '@earendil-works/chord';
import type { Id, Seq, StorageWrite } from '@earendil-works/pi-durable';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { couchDatabase, CouchHttpError, type CouchDatabase, type CouchDocument, type HttpOptions } from './client.js';
export { couchDatabase, CouchHttpError, type CouchDatabase, type CouchDocument, type HttpOptions } from './client.js';

interface Head extends CouchDocument {
  format: 1;
  commitId: string | null;
  sequence: number;
  nextId: number;
}
interface Journal extends CouchDocument {
  format: 1;
  parent: string | null;
  sequence: number;
  writesJson: string;
}
const HEAD = 'pi:head';
const WRITE_TYPES = new Set(['conversation', 'entry', 'task', 'submission',
  'document.create', 'document.copy', 'document.change', 'document.retire']);
function validateWriteTypes(writes: readonly StorageWrite[]) {
  for (const write of writes) {
    if (!write || !WRITE_TYPES.has(write.type)) throw new Error('Unknown journal write type');
  }
}
function validHead(value: CouchDocument): asserts value is Head {
  if ((Array.isArray(value._conflicts) && value._conflicts.length > 0) ||
      value.format !== 1 || typeof value._rev !== 'string' ||
      !(value.commitId === null || typeof value.commitId === 'string') ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 ||
      !Number.isSafeInteger(value.nextId) || Number(value.nextId) < 2 ||
      ((value.sequence === 0) !== (value.commitId === null))) {
    throw new Error('Invalid or unsupported CouchDB journal head');
  }
}

/** Single-owner storage. Full committed history is materialized in memory. */
export class CouchDbStorage extends MemoryStorage {
  private head!: Head;
  private stopped = false;
  private failure?: Error;
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly database: CouchDatabase) { super(); }

  static async open(database: CouchDatabase): Promise<CouchDbStorage> {
    const storage = new CouchDbStorage(database);
    await storage.recover();
    // All public storage operations share one queue. Methods run against the raw
    // target so internal calls do not recursively acquire that queue.
    const methods = new Set([
      'commit', 'mintId', 'conversation', 'scanConversations', 'entry',
      'findLatestHeadMarker', 'scanEntries', 'task', 'scanTasks', 'submission',
      'scanSubmissions', 'submissionByRequest', 'findDocument', 'document',
      'scanDocuments', 'close',
    ]);
    return new Proxy(storage, {
      get(target, property) {
        if (property === 'prepareCommit') return () => { throw new Error('Use commit(), not prepareCommit()'); };
        const value: unknown = Reflect.get(target, property, target);
        if (typeof property !== 'string' || !methods.has(property) || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const operation = target.queue.then(() => {
            if (property !== 'close') target.assertHealthy();
            return Reflect.apply(value, target, args) as unknown;
          });
          target.queue = operation.catch(() => undefined);
          return operation;
        };
      },
    });
  }

  private assertHealthy() {
    if (this.stopped) throw new Error('CouchDB storage is closed');
    if (this.failure) throw this.failure;
  }
  private poison(cause: unknown): never {
    this.failure = new Error('CouchDB storage failed; close and reopen to reconcile the publication outcome', { cause });
    throw this.failure;
  }
  private async recover() {
    let head = await this.database.get(HEAD);
    if (!head) {
      const initial: Head = { _id: HEAD, format: 1, commitId: null, sequence: 0, nextId: 2 };
      try {
        const result = await this.database.put(initial);
        head = { ...initial, _rev: result.rev };
      } catch (error) {
        if (!(error instanceof CouchHttpError) || error.status !== 409) throw error;
        head = await this.database.get(HEAD);
        if (!head) throw new Error('Head disappeared during initialization');
      }
    }
    validHead(head);
    const commits: Journal[] = [];
    let id = head.commitId;
    let expected = head.sequence;
    while (id !== null) {
      const record = await this.database.get(id);
      if (!record || record._id !== id || record.format !== 1 || record.sequence !== expected ||
          typeof record.writesJson !== 'string' || !(record.parent === null || typeof record.parent === 'string') || expected < 1) {
        throw new Error(`Missing or corrupt published commit at sequence ${expected}`);
      }
      commits.push(record as Journal);
      id = record.parent as string | null;
      expected--;
    }
    if (expected !== 0) throw new Error('Incomplete published commit ancestry');
    for (const commit of commits.reverse()) {
      const writes: unknown = JSON.parse(commit.writesJson);
      if (!Array.isArray(writes)) throw new Error('Invalid journal batch');
      validateWriteTypes(writes as StorageWrite[]);
      super.prepareCommit(writes as StorageWrite[], commit.sequence as Seq).apply();
    }
    this.head = structuredClone(head);
  }

  private async publish(change: Pick<Head, 'commitId' | 'sequence' | 'nextId'>) {
    const next = { ...this.head, ...change };
    try {
      const { rev } = await this.database.put(next);
      this.head = { ...next, _rev: rev };
    } catch (error) {
      // Includes 409 and ambiguous network failures: never continue serving a
      // possibly stale in-memory view. Recovery decides what was published.
      this.poison(error);
    }
  }

  override async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    validateWriteTypes(writes);
    const prepared = super.prepareCommit(writes);
    const record: Journal = {
      _id: `pi:commit:${randomUUID()}`, format: 1,
      parent: this.head.commitId, sequence: prepared.seq,
      // Outer JSON escapes the inner JSON's surrogate escapes; CouchDB never
      // has to decode invalid Unicode, while replay preserves JS strings.
      writesJson: JSON.stringify(prepared.writes),
    };
    try { await this.database.put(record); } catch (error) { this.poison(error); }
    await this.publish({ commitId: record._id, sequence: prepared.seq, nextId: this.head.nextId });
    return prepared.apply();
  }

  override async mintId<I extends Id<string>>(): Promise<I> {
    const candidate = Math.max(Number(await super.mintId()), this.head.nextId);
    if (!Number.isSafeInteger(candidate + 1)) throw new Error('ID space exhausted');
    await this.publish({ commitId: this.head.commitId, sequence: this.head.sequence, nextId: candidate + 1 });
    return candidate as I;
  }
  override async close(context: Context): Promise<void> {
    this.stopped = true;
    await super.close(context);
  }
}

export async function openCouchDbStorage(options: HttpOptions): Promise<CouchDbStorage> {
  return CouchDbStorage.open(couchDatabase(options));
}

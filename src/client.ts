/** Minimal transport seam for deterministic fault injection and alternate HTTP clients. */
export interface CouchDocument {
  _id: string;
  _rev?: string;
  [key: string]: unknown;
}
export interface CouchDatabase {
  get(id: string): Promise<CouchDocument | undefined>;
  put(document: CouchDocument): Promise<{ rev: string }>;
}
export class CouchHttpError extends Error {
  constructor(public readonly status: number) {
    super(`CouchDB request failed (HTTP ${status})`);
  }
}
export interface HttpOptions {
  /** Existing, dedicated database URL; credentials belong in headers, not the URL. */
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}
export function couchDatabase(options: HttpOptions): CouchDatabase {
  const base = new URL(options.url.endsWith("/") ? options.url : `${options.url}/`);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Use an HTTP(S) database URL without credentials, query, or fragment');
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  async function request(id: string, document?: CouchDocument) {
    const url = new URL(encodeURIComponent(id), base);
    if (!document) url.searchParams.set('conflicts', 'true');
    const response = await fetcher(url, {
      method: document ? 'PUT' : 'GET',
      headers: { ...options.headers, 'Content-Type': 'application/json' },
      body: document ? JSON.stringify(document) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      redirect: 'error',
    });
    if (!document && response.status === 404) return undefined;
    if (!response.ok) throw new CouchHttpError(response.status);
    const result = await response.json() as Record<string, unknown>;
    if (Array.isArray(result._conflicts) && result._conflicts.length > 0) {
      throw new Error('Replicated CouchDB conflicts are not supported');
    }
    return result;
  }
  return {
    get: async (id) => await request(id) as CouchDocument | undefined,
    put: async (document) => {
      const result = await request(document._id, document);
      if (typeof result?.rev !== 'string') throw new Error('Invalid CouchDB write response');
      return { rev: result.rev };
    },
  };
}

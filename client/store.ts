// Where productions live: the Drama Club server (signed in), or this browser (IndexedDB).
// Both behave the same, including the version check that stops two tabs overwriting each other.
import type { GraphJSON } from 'mobile-nodemap';
import { api, ApiError, type Production, type ProductionSummary } from './api.ts';

export interface SaveFields {
  graph?: GraphJSON;
  title?: string;
  /** The version being saved over. A newer one stored meanwhile refuses the save (409). */
  version?: number;
  force?: boolean;
}

export interface ProductionStore {
  readonly mode: 'server' | 'local';
  list(): Promise<ProductionSummary[]>;
  get(id: string): Promise<Production>;
  create(title: string, graph: GraphJSON): Promise<Production>;
  update(id: string, fields: SaveFields): Promise<ProductionSummary>;
  remove(id: string): Promise<void>;
}

export const serverStore: ProductionStore = {
  mode: 'server',
  list: async () => (await api.get<{ productions: ProductionSummary[] }>('/productions')).productions,
  get: async (id) => (await api.get<{ production: Production }>(`/productions/${id}`)).production,
  create: async (title, graph) => (await api.post<{ production: Production }>('/productions', { title, graph })).production,
  update: async (id, f) => (await api.put<{ production: ProductionSummary }>(`/productions/${id}`, f)).production,
  remove: (id) => api.del(`/productions/${id}`),
};

// ------------------------------------------------------------------ in this browser

const summary = ({ graph, ...p }: Production): ProductionSummary => ({ ...p, nodeCount: graph.nodes.length });

let dbp: Promise<IDBDatabase> | undefined;
function idb(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser can’t store productions (no IndexedDB)'));
    const req = indexedDB.open('dramaclub', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('productions', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbp = undefined;
      reject(new Error('This browser won’t let Drama Club store productions (private browsing?)'));
    };
  }));
}

/** One transaction on the productions store. `fn` may return a request whose result is resolved. */
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('productions', mode);
    let result: T;
    const req = fn(t.objectStore('productions'));
    if (req) req.onsuccess = () => (result = req.result);
    t.oncomplete = () => resolve(result);
    t.onabort = t.onerror = () => {
      const e = t.error;
      reject(new Error(e?.name === 'QuotaExceededError' ? 'This browser is out of space for productions. Remove some pictures or productions.' : e?.message ?? 'Could not save'));
    };
  });
}

const notFound = () => new ApiError(404, 'No such production');

export const localStore: ProductionStore = {
  mode: 'local',
  async list() {
    const all = await tx<Production[]>('readonly', (s) => s.getAll());
    return all.map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async get(id) {
    const p = await tx<Production | undefined>('readonly', (s) => s.get(id));
    if (!p) throw notFound();
    return p;
  },
  async create(title, graph) {
    const now = new Date().toISOString();
    const p: Production = { id: crypto.randomUUID(), title, graph, version: 1, createdAt: now, updatedAt: now, nodeCount: graph.nodes.length };
    await tx('readwrite', (s) => s.add(p));
    return p;
  },
  async update(id, f) {
    let out: ProductionSummary | undefined;
    let conflict: ProductionSummary | undefined;
    // Read, check and write in one transaction, so two tabs can't both win.
    await tx('readwrite', (s) => {
      const req = s.get(id);
      req.onsuccess = () => {
        const p = req.result as Production | undefined;
        if (!p) return;
        if (!f.force && p.version !== f.version) return void (conflict = summary(p));
        const next: Production = { ...p, graph: f.graph ?? p.graph, title: f.title ?? p.title, version: p.version + 1, updatedAt: new Date().toISOString() };
        s.put(next);
        out = summary(next);
      };
    });
    if (conflict) throw new ApiError(409, 'This production was changed somewhere else since you opened it', { production: conflict });
    if (!out) throw notFound();
    return out;
  },
  async remove(id) {
    await tx('readwrite', (s) => s.delete(id));
  },
};

/** Is there a Drama Club server behind this page? (Not on GitHub Pages or other static hosting.) */
export async function hasServer(): Promise<boolean> {
  try {
    const res = await fetch('api/health', { credentials: 'same-origin' });
    return res.ok && (res.headers.get('content-type') ?? '').includes('json') && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

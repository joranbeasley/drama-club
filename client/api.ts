import type { GraphJSON } from 'mobile-nodemap';

export interface User {
  id: number;
  email: string;
  name: string;
  picture: string | null;
}
export interface ProductionSummary {
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}
export interface Production extends ProductionSummary {
  graph: GraphJSON;
}

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** `raw` sends a body that is already JSON text (a production's map), without re-encoding it. */
async function call<T>(method: string, path: string, body?: unknown, raw?: { text: string; headers?: Record<string, string> }): Promise<T> {
  let res: Response;
  try {
    res = await fetch('api' + path, {
      method,
      credentials: 'same-origin',
      headers: raw ? { 'Content-Type': 'application/json', ...raw.headers } : body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: raw ? raw.text : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Can’t reach the server. Check your connection.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `${res.status} ${res.statusText}`, data);
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T = unknown>(path: string, body: unknown) => call<T>('POST', path, body),
  put: <T = unknown>(path: string, body: unknown) => call<T>('PUT', path, body),
  patch: <T = unknown>(path: string, body: unknown) => call<T>('PATCH', path, body),
  /** Send a map as the body. */
  send: <T = unknown>(method: string, path: string, graph: GraphJSON) =>
    call<T>(method, path, undefined, { text: JSON.stringify(graph), headers: { 'X-Node-Count': String(graph.nodes.length) } }),
  del: (path: string) => call<void>('DELETE', path),
};

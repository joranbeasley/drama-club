// Pictures in productions: kept inline (data: URLs) while editing, stored in R2 when saved to
// the server (the saved map holds links), and put back inline for downloads, so a downloaded
// production works anywhere.
import type { GraphJSON } from 'mobile-nodemap';
import { ApiError } from './api.ts';

/** Photos worth moving out. SVG drawings stay inline: they're tiny, and unsafe to serve from our domain. */
const RASTER = /^data:image\/(png|jpe?g|webp|gif)[;,]/i;
const LINK = /^api\/images\/[0-9a-f]{64}\.(jpg|png|webp|gif)$/;
/**
 * Pictures made by Meshy or fal, still on their servers: their links expire (Meshy's within days),
 * so they're copied into R2 too. Pictures only (a fal clip link is kept by the clip keeper).
 */
const REMOTE = /^https:\/\/(assets\.meshy\.ai|([a-z0-9-]+\.)*fal\.media)\/[^\s?#]+\.(png|jpe?g|webp|gif)([?#]\S*)?$/i;

/** Every string in a map's node params (pictures sit in images lists, storyboards, last frames…). */
function mapStrings(json: GraphJSON, fn: (s: string) => string): GraphJSON {
  const walk = (v: unknown): unknown =>
    typeof v === 'string' ? fn(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return { ...json, nodes: json.nodes.map((n) => ({ ...n, params: walk(n.params) as Record<string, unknown> })) };
}
function strings(json: GraphJSON): string[] {
  const out: string[] = [];
  mapStrings(json, (s) => (out.push(s), s));
  return out;
}

/** Does this map still carry photos inline (made before pictures moved to R2, or just added)? */
export const hasInlinePhotos = (json: GraphJSON) => strings(json).some((s) => RASTER.test(s) || (REMOTE.test(s) && !gone.has(s)));

const uploaded = new Map<string, Promise<string>>();
/** Service links that couldn't be copied (expired): left as they are, not tried again on this page. */
const gone = new Set<string>();

async function copy(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch('api/images/copy', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  } catch {
    throw new ApiError(0, 'Can’t reach the server. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data.url as string;
  // The service no longer has it (or won't give it): keep the link rather than fail the save.
  if (res.status === 502 || res.status === 400 || res.status === 415 || res.status === 413) {
    gone.add(url);
    return url;
  }
  throw new ApiError(res.status, data.error ?? `Copying a picture failed (${res.status})`, data);
}

async function upload(dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  let res: Response;
  try {
    res = await fetch('api/images', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
  } catch {
    throw new ApiError(0, 'Can’t reach the server. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Picture upload failed (${res.status})`, data);
  return data.url as string;
}

/** The map with its photos uploaded (each once per page) and replaced by links. */
export async function withPhotosStored(json: GraphJSON): Promise<GraphJSON> {
  const todo = [...new Set(strings(json).filter((s) => RASTER.test(s) || (REMOTE.test(s) && !gone.has(s))))];
  // A few at a time: a production can have dozens on its first save.
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(
      todo.slice(i, i + 4).map((d) => {
        if (!uploaded.has(d)) uploaded.set(d, (RASTER.test(d) ? upload(d) : copy(d)).catch((err) => (uploaded.delete(d), Promise.reject(err))));
        return uploaded.get(d)!;
      }),
    );
  }
  const urls = new Map<string, string>();
  for (const d of todo) urls.set(d, await uploaded.get(d)!);
  return todo.length ? mapStrings(json, (s) => urls.get(s) ?? s) : json;
}

/** The map with linked pictures put back inline, for downloads. */
export async function withPhotosInline(json: GraphJSON): Promise<GraphJSON> {
  const links = [...new Set(strings(json).filter((s) => LINK.test(s)))];
  const data = new Map<string, string>();
  await Promise.all(
    links.map(async (url) => {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) return; // keep the link: better than losing the reference
      const blob = await res.blob();
      data.set(url, await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      }));
    }),
  );
  return links.length ? mapStrings(json, (s) => data.get(s) ?? s) : json;
}

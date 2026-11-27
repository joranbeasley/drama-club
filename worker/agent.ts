// The agent API: production-level actions on a production's boards (cast, places, props, episodes,
// scenes, shots, wardrobe), for agents and scripts with an API token. It edits the stored Drama
// boards map (mobile-nodemap "drama2" GraphJSON) directly: the same shapes the app's editor writes.
//
//   GET    /api/productions/:id/outline
//   POST   /api/productions/:id/scenes          set up a scene: shots, cast, place, outfits (by name)
//   POST   /api/productions/:id/characters | locations | props | episodes | shots
//   PATCH  /api/productions/:id/items/:itemId
//   DELETE /api/productions/:id/items/:itemId
//   PUT    /api/productions/:id/wardrobe
import type { User } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, json, readJson } from './http.ts';
import { loadProduction, saveProduction, type Summary } from './productions.ts';

export const T = {
  character: 'drama2/character',
  location: 'drama2/location',
  prop: 'drama2/prop',
  shot: 'drama2/shot',
  scene: 'drama2/scene',
  episode: 'drama2/episode',
} as const;
export const FRAMINGS = ['Wide', 'Full', 'Medium', 'Close-up', 'Extreme close-up', 'Two-shot', 'Over the shoulder', 'Point of view', 'Insert'];
export const MOVES = ['Static', 'Pan', 'Tilt', 'Dolly', 'Tracking', 'Handheld', 'Crane', 'Zoom'];
export const TIMES = ['DAY', 'NIGHT', 'MORNING', 'EVENING', 'CONTINUOUS', 'LATER'];

interface Node {
  id: string;
  type: string;
  x: number;
  y: number;
  label?: string;
  params: Record<string, any>;
}
interface Board {
  version: number;
  type: string;
  nodes: Node[];
  edges: unknown[];
  meta?: Record<string, unknown>;
}

/** A small editable view of a board, with lookups. */
class Production {
  board: Board;
  created: Record<'characters' | 'locations' | 'props' | 'episodes', { id: string; name: string }[]> = { characters: [], locations: [], props: [], episodes: [] };
  constructor(text: string) {
    const b = JSON.parse(text) as Board;
    if (!b || !Array.isArray(b.nodes)) throw new HttpError(500, 'This production could not be read');
    this.board = { ...b, version: b.version ?? 1, edges: b.edges ?? [], type: 'drama2' };
  }
  get nodes() {
    return this.board.nodes;
  }
  get(id: string) {
    return this.nodes.find((n) => n.id === id);
  }
  of(type: string) {
    return this.nodes.filter((n) => n.type === type);
  }
  newId(prefix: string) {
    let id: string;
    do id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    while (this.get(id));
    return id;
  }
  add(type: string, prefix: string, params: Record<string, any>, label?: string): Node {
    const n: Node = { id: this.newId(prefix), type, x: 0, y: 0, params, ...(label ? { label } : {}) };
    this.nodes.push(n);
    return n;
  }
  /** Find an item of a type by id, or by name (title), ignoring case. */
  find(type: string, ref: unknown): Node | undefined {
    if (typeof ref !== 'string' || !ref.trim()) return undefined;
    const r = ref.trim();
    const byId = this.get(r);
    if (byId?.type === type) return byId;
    return this.of(type).find((n) => (n.label ?? '').trim().toLowerCase() === r.toLowerCase());
  }
  /** Find, or (when allowed) create by name. */
  resolve(type: string, ref: unknown, what: string, create: boolean, make: (name: string) => Node): Node {
    const n = this.find(type, ref);
    if (n) return n;
    if (typeof ref !== 'string' || !ref.trim()) throw new HttpError(400, `Give the ${what} as an id or a name`);
    if (!create) throw new HttpError(400, `No ${what} "${ref}" in this production`);
    return make(ref.trim());
  }
  sceneOf(shotId: string) {
    return this.of(T.scene).find((sc) => (sc.params.shots ?? []).includes(shotId));
  }
  episodeOf(sceneId: string) {
    return this.of(T.episode).find((ep) => (ep.params.scenes ?? []).includes(sceneId));
  }
  get text() {
    return JSON.stringify(this.board);
  }
}

// ------------------------------------------------------------------ making items

const str = (v: unknown, max = 4000) => (v === undefined || v === null ? undefined : String(v).slice(0, max));
const oneOf = (v: unknown, options: string[], what: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const hit = options.find((o) => o.toLowerCase() === String(v).trim().toLowerCase());
  if (!hit) throw new HttpError(400, `${what} must be one of: ${options.join(', ')}`);
  return hit;
};
const seconds = (v: unknown) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 600) throw new HttpError(400, 'duration is seconds, 0 to 600');
  return Math.round(n);
};
const name = (v: unknown, what: string) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new HttpError(400, `Give the ${what} a name`);
  return s.slice(0, 200);
};

function makeCharacter(p: Production, b: Record<string, unknown>): Node {
  const n = p.add(T.character, 'char', { description: str(b.description) ?? '', appearance: str(b.appearance) ?? '', images: [], actor: str(b.actor, 200) ?? '' }, name(b.name, 'character'));
  p.created.characters.push({ id: n.id, name: n.label! });
  return n;
}
function makeLocation(p: Production, b: Record<string, unknown>): Node {
  const n = p.add(T.location, 'loc', { setting: oneOf(b.setting, ['INT', 'EXT'], 'setting') ?? 'INT', description: str(b.description) ?? '', images: [] }, name(b.name, 'location'));
  p.created.locations.push({ id: n.id, name: n.label! });
  return n;
}
function makeProp(p: Production, b: Record<string, unknown>): Node {
  const kind = oneOf(b.kind, ['Object', 'Outfit'], 'kind') ?? 'Object';
  const wearer = b.usuallyWornBy !== undefined && b.usuallyWornBy !== null && b.usuallyWornBy !== '' ? p.resolve(T.character, b.usuallyWornBy, 'character', false, () => undefined as never) : undefined;
  const n = p.add(T.prop, kind === 'Outfit' ? 'outfit' : 'prop', { kind, wornBy: kind === 'Outfit' ? (wearer?.id ?? '') : '', description: str(b.description) ?? '', images: [] }, name(b.name, kind === 'Outfit' ? 'outfit' : 'prop'));
  p.created.props.push({ id: n.id, name: n.label! });
  return n;
}
const nextNumber = (nums: unknown[]) => Math.max(0, ...nums.map((v) => Number.parseInt(String(v ?? ''), 10) || 0)) + 1;
function makeEpisode(p: Production, b: Record<string, unknown>): Node {
  const number = b.number !== undefined ? Number(b.number) || 1 : nextNumber(p.of(T.episode).map((e) => e.params.number));
  const n = p.add(
    T.episode,
    'ep',
    { number, scenes: [], description: str(b.description) ?? '', wardrobe: {}, images: [], style: str(b.style) ?? '', aspect: 'inherit', maxImages: 0, maxClip: 0 },
    name(b.title ?? b.name, 'episode'),
  );
  p.created.episodes.push({ id: n.id, name: n.label! });
  return n;
}

/** Characters, location and props for a shot, by id or name (created when allowed). */
function castFor(p: Production, b: Record<string, unknown>, create: boolean, fallbackLocation?: Node) {
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const characters = list(b.characters).map((c) => p.resolve(T.character, c, 'character', create, (nm) => makeCharacter(p, { name: nm })).id);
  const location = b.location !== undefined && b.location !== null && b.location !== '' ? p.resolve(T.location, b.location, 'location', create, (nm) => makeLocation(p, { name: nm })).id : (fallbackLocation?.id ?? '');
  const props = list(b.props).map((x) => {
    const n = p.resolve(T.prop, x, 'prop', create, (nm) => makeProp(p, { name: nm }));
    if (n.params.kind === 'Outfit') throw new HttpError(400, `"${n.label}" is an outfit: dress people with wardrobe, not props`);
    return n.id;
  });
  return { characters: [...new Set(characters)], location, props: [...new Set(props)] };
}

/** A wardrobe ({ character: outfit | "usual" }) resolved to ids: '' means usual clothes. */
function wardrobeFor(p: Production, w: unknown, create: boolean): Record<string, string> {
  if (w === undefined || w === null) return {};
  if (typeof w !== 'object' || Array.isArray(w)) throw new HttpError(400, 'wardrobe is { "<character>": "<outfit>" | "usual" }');
  const out: Record<string, string> = {};
  for (const [who, what] of Object.entries(w as Record<string, unknown>)) {
    const c = p.resolve(T.character, who, 'character', create, (nm) => makeCharacter(p, { name: nm }));
    if (what === null || what === '' || String(what).toLowerCase() === 'usual') out[c.id] = '';
    else out[c.id] = p.resolve(T.prop, what, 'outfit', create, (nm) => makeProp(p, { name: nm, kind: 'Outfit', usuallyWornBy: c.id })).id;
  }
  return out;
}

function makeShot(p: Production, scene: Node, b: Record<string, unknown>, create: boolean, fallbackLocation?: Node): Node {
  const cast = castFor(p, b, create, fallbackLocation);
  const shots: string[] = scene.params.shots ?? (scene.params.shots = []);
  const n = p.add(T.shot, 'shot', {
    number: b.number !== undefined ? String(b.number) : String(nextNumber(shots.map((id) => p.get(id)?.params.number))),
    framing: oneOf(b.framing, FRAMINGS, 'framing') ?? 'Medium',
    location: cast.location,
    characters: cast.characters,
    props: cast.props,
    wardrobe: wardrobeFor(p, b.wardrobe, create),
    description: str(b.description) ?? '',
    images: [],
    continues: b.continues === true,
    lastFrame: '',
    movement: oneOf(b.movement, MOVES, 'movement') ?? 'Static',
    duration: seconds(b.duration) ?? 5,
  });
  shots.push(n.id);
  return n;
}

// ------------------------------------------------------------------ the outline

const ref = (p: Production, id: string) => {
  const n = id ? p.get(id) : undefined;
  return n ? { id: n.id, name: n.label ?? n.id } : null;
};
const wardrobeOut = (p: Production, w: Record<string, string> | undefined) =>
  Object.entries(w ?? {}).map(([c, o]) => ({ character: ref(p, c), outfit: o ? ref(p, o) : 'usual clothes' }));

/** What wears what in a shot, after episode → scene → shot overrides (as the app resolves it). */
function dressed(p: Production, shot: Node) {
  const sc = p.sceneOf(shot.id);
  const ep = sc && p.episodeOf(sc.id);
  const out: { character: ReturnType<typeof ref>; outfit: ReturnType<typeof ref>; from: string }[] = [];
  for (const c of shot.params.characters ?? []) {
    for (const [lvl, n] of [['shot', shot], ['scene', sc], ['episode', ep]] as const) {
      const w = n?.params.wardrobe ?? {};
      if (Object.prototype.hasOwnProperty.call(w, c)) {
        if (w[c]) out.push({ character: ref(p, c), outfit: ref(p, w[c]), from: lvl });
        break;
      }
    }
  }
  return out;
}

const shotOut = (p: Production, s: Node) => ({
  id: s.id,
  number: s.params.number,
  framing: s.params.framing,
  movement: s.params.movement,
  duration: s.params.duration,
  location: ref(p, s.params.location),
  characters: (s.params.characters ?? []).map((c: string) => ref(p, c)).filter(Boolean),
  props: (s.params.props ?? []).map((c: string) => ref(p, c)).filter(Boolean),
  wearing: dressed(p, s),
  wardrobe: wardrobeOut(p, s.params.wardrobe),
  description: s.params.description ?? '',
  continuesPreviousShot: !!s.params.continues,
  frames: (s.params.images ?? []).length,
  hasClip: !!s.params.lastFrame,
});
const sceneOut = (p: Production, sc: Node) => {
  const ep = p.episodeOf(sc.id);
  return {
    id: sc.id,
    number: sc.params.number,
    time: sc.params.time,
    description: sc.params.description ?? '',
    episode: ep ? { id: ep.id, number: ep.params.number, title: ep.label ?? '' } : null,
    wardrobe: wardrobeOut(p, sc.params.wardrobe),
    shots: (sc.params.shots ?? []).map((id: string) => p.get(id)).filter(Boolean).map((s: Node) => shotOut(p, s)),
  };
};

export function outline(p: Production) {
  const pics = (n: Node) => (n.params.images ?? []).length;
  const episodes = p.of(T.episode).sort((a, b) => Number(a.params.number) - Number(b.params.number));
  const inEpisodes = new Set(episodes.flatMap((e) => e.params.scenes ?? []));
  return {
    characters: p.of(T.character).map((n) => ({ id: n.id, name: n.label ?? '', actor: n.params.actor ?? '', description: n.params.description ?? '', appearance: n.params.appearance ?? '', pictures: pics(n) })),
    locations: p.of(T.location).map((n) => ({ id: n.id, name: n.label ?? '', setting: n.params.setting, description: n.params.description ?? '', pictures: pics(n) })),
    props: p.of(T.prop).map((n) => ({ id: n.id, name: n.label ?? '', kind: n.params.kind, description: n.params.description ?? '', usuallyWornBy: ref(p, n.params.wornBy), pictures: pics(n) })),
    episodes: episodes.map((e) => ({
      id: e.id,
      number: e.params.number,
      title: e.label ?? '',
      description: e.params.description ?? '',
      style: e.params.style ?? '',
      wardrobe: wardrobeOut(p, e.params.wardrobe),
      scenes: (e.params.scenes ?? []).map((id: string) => p.get(id)).filter(Boolean).map((sc: Node) => sceneOut(p, sc)),
    })),
    scenesWithoutEpisode: p
      .of(T.scene)
      .filter((sc) => !inEpisodes.has(sc.id))
      .map((sc) => sceneOut(p, sc)),
    shotsWithoutScene: p
      .of(T.shot)
      .filter((s) => !p.sceneOf(s.id))
      .map((s) => shotOut(p, s)),
  };
}

// ------------------------------------------------------------------ editing

const EDITABLE: Record<string, string[]> = {
  [T.character]: ['name', 'description', 'appearance', 'actor'],
  [T.location]: ['name', 'setting', 'description'],
  [T.prop]: ['name', 'kind', 'description', 'usuallyWornBy'],
  [T.episode]: ['title', 'number', 'description', 'style'],
  [T.scene]: ['number', 'time', 'description', 'episode'],
  [T.shot]: ['number', 'framing', 'movement', 'duration', 'location', 'characters', 'props', 'description', 'continuesPreviousShot'],
};

function edit(p: Production, n: Node, b: Record<string, unknown>) {
  const allowed = EDITABLE[n.type] ?? [];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new HttpError(400, `Can't change ${unknown.join(', ')} here. Editable: ${allowed.join(', ')}`);
  for (const [k, v] of Object.entries(b)) {
    if (k === 'name' || k === 'title') n.label = name(v, 'item');
    else if (k === 'description' || k === 'appearance' || k === 'style') n.params[k] = str(v) ?? '';
    else if (k === 'actor') n.params.actor = str(v, 200) ?? '';
    else if (k === 'setting') n.params.setting = oneOf(v, ['INT', 'EXT'], 'setting') ?? n.params.setting;
    else if (k === 'kind') {
      n.params.kind = oneOf(v, ['Object', 'Outfit'], 'kind') ?? n.params.kind;
      if (n.params.kind === 'Object') n.params.wornBy = '';
    } else if (k === 'usuallyWornBy') n.params.wornBy = v ? p.resolve(T.character, v, 'character', false, () => undefined as never).id : '';
    else if (k === 'time') n.params.time = oneOf(v, TIMES, 'time') ?? n.params.time;
    else if (k === 'framing') n.params.framing = oneOf(v, FRAMINGS, 'framing') ?? n.params.framing;
    else if (k === 'movement') n.params.movement = oneOf(v, MOVES, 'movement') ?? n.params.movement;
    else if (k === 'duration') n.params.duration = seconds(v) ?? n.params.duration;
    else if (k === 'number') n.params.number = n.type === T.shot ? String(v) : Number(v) || n.params.number;
    else if (k === 'continuesPreviousShot') n.params.continues = v === true;
    else if (k === 'location' || k === 'characters' || k === 'props') {
      const cast = castFor(p, { [k]: v }, false);
      n.params[k] = k === 'location' ? cast.location : cast[k];
    } else if (k === 'episode') {
      for (const ep of p.of(T.episode)) ep.params.scenes = (ep.params.scenes ?? []).filter((id: string) => id !== n.id);
      if (v) (p.resolve(T.episode, v, 'episode', false, () => undefined as never).params.scenes ??= []).push(n.id);
    }
  }
}

/** Remove an item and every reference to it. Removing a scene removes its shots; an episode keeps its scenes. */
function remove(p: Production, n: Node) {
  const gone = new Set([n.id, ...(n.type === T.scene ? (n.params.shots ?? []) : [])]);
  p.board.nodes = p.nodes.filter((x) => !gone.has(x.id));
  for (const x of p.nodes) {
    const ps = x.params;
    for (const k of ['characters', 'props', 'shots', 'scenes']) if (Array.isArray(ps[k])) ps[k] = ps[k].filter((id: string) => !gone.has(id));
    if (gone.has(ps.location)) ps.location = '';
    if (gone.has(ps.wornBy)) ps.wornBy = '';
    if (ps.wardrobe && typeof ps.wardrobe === 'object') {
      for (const [c, o] of Object.entries(ps.wardrobe as Record<string, string>)) {
        if (gone.has(c)) delete ps.wardrobe[c];
        else if (gone.has(o)) delete ps.wardrobe[c];
      }
    }
  }
}

// ------------------------------------------------------------------ routes

/** Load, change, save; on a clash with another save, reload and try once more. */
async function change<R>(env: Env, user: User, id: string, version: number | null, fn: (p: Production) => R): Promise<{ result: R; production: Summary }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded = await loadProduction(env.DB, user.id, id);
    if (!loaded) throw new HttpError(404, 'No such production');
    if (version !== null && loaded.meta.version !== version) {
      throw new HttpError(409, 'This production was changed since that version', { production: loaded.meta });
    }
    const p = new Production(loaded.text);
    const result = fn(p);
    const saved = await saveProduction(env.DB, user.id, id, p.text, p.nodes.length, loaded.meta.version);
    if (saved) return { result, production: saved };
    if (version !== null) break;
  }
  throw new HttpError(409, 'This production is being changed elsewhere right now; try again');
}

const versionOf = (req: Request) => {
  const v = new URL(req.url).searchParams.get('version');
  if (v === null) return null;
  if (!Number.isInteger(Number(v))) throw new HttpError(400, 'version must be a whole number');
  return Number(v);
};

export async function agentRoute(req: Request, env: Env, path: string, user: User): Promise<Response | undefined> {
  const m = /^\/productions\/([0-9a-f-]{36})\/(outline|scenes|characters|locations|props|episodes|shots|wardrobe|items\/([\w-]+))$/.exec(path);
  if (!m) return undefined;
  const [, id, what, itemId] = m;
  const method = req.method;

  if (what === 'outline' && method === 'GET') {
    const loaded = await loadProduction(env.DB, user.id, id);
    if (!loaded) throw new HttpError(404, 'No such production');
    return json({ production: loaded.meta, outline: outline(new Production(loaded.text)) });
  }

  const version = versionOf(req);
  const created = (r: { result: unknown; production: Summary }, p?: Production) => json({ ...(r.result as object), production: r.production, ...(p ? { created: p.created } : {}) }, 201);

  if (method === 'POST' && what !== 'outline' && what !== 'wardrobe' && !itemId) {
    const b = await readJson(req);
    let made: Production | undefined;
    const r = await change(env, user, id, version, (p) => {
      made = p;
      const create = b.createMissing !== false;
      if (what === 'characters') {
        const n = makeCharacter(p, b);
        return { character: outline(p).characters.find((x) => x.id === n.id) };
      }
      if (what === 'locations') {
        const n = makeLocation(p, b);
        return { location: outline(p).locations.find((x) => x.id === n.id) };
      }
      if (what === 'props') {
        const n = makeProp(p, b);
        return { prop: outline(p).props.find((x) => x.id === n.id) };
      }
      if (what === 'episodes') {
        const ep = makeEpisode(p, b);
        return { episode: outline(p).episodes.find((e) => e.id === ep.id) };
      }
      if (what === 'shots') {
        const sc = p.find(T.scene, b.scene);
        if (!sc) throw new HttpError(400, 'Give the scene (its id) to add the shot to');
        const s = makeShot(p, sc, b, create);
        return { shot: shotOut(p, s) };
      }
      // Scenes: one call sets up a scene with its shots, cast, place and outfits.
      const ep = b.episode !== undefined && b.episode !== null && b.episode !== '' ? p.resolve(T.episode, b.episode, 'episode', create, (nm) => makeEpisode(p, { title: nm })) : undefined;
      const siblings = ep ? (ep.params.scenes ?? []).map((sid: string) => p.get(sid)?.params.number) : p.of(T.scene).map((sc) => sc.params.number);
      const sc = p.add(T.scene, 'scene', {
        number: b.number !== undefined ? Number(b.number) || 1 : nextNumber(siblings),
        time: oneOf(b.time, TIMES, 'time') ?? 'DAY',
        shots: [],
        description: str(b.description) ?? '',
        wardrobe: wardrobeFor(p, b.wardrobe, create),
        storyboard: [],
      });
      if (ep) (ep.params.scenes ??= []).push(sc.id);
      const place = b.location !== undefined && b.location !== null && b.location !== '' ? p.resolve(T.location, b.location, 'location', create, (nm) => makeLocation(p, { name: nm })) : undefined;
      const shots = Array.isArray(b.shots) ? b.shots : [];
      if (shots.length > 100) throw new HttpError(400, 'At most 100 shots at a time');
      for (const s of shots) {
        if (!s || typeof s !== 'object') throw new HttpError(400, 'Each shot is an object');
        makeShot(p, sc, s as Record<string, unknown>, create, place);
      }
      return { scene: sceneOut(p, sc) };
    });
    return created(r, made);
  }

  if (what === 'wardrobe' && method === 'PUT') {
    const b = await readJson(req);
    const r = await change(env, user, id, version, (p) => {
      const at = p.get(String(b.at ?? ''));
      if (!at || ![T.episode, T.scene, T.shot].includes(at.type as never)) throw new HttpError(400, 'at is the id of an episode, scene or shot');
      const c = p.resolve(T.character, b.character, 'character', false, () => undefined as never);
      const w: Record<string, string> = (at.params.wardrobe ??= {});
      if (b.outfit === 'inherit') delete w[c.id];
      else if (b.outfit === null || b.outfit === '' || String(b.outfit).toLowerCase() === 'usual') w[c.id] = '';
      else {
        const o = p.resolve(T.prop, b.outfit, 'outfit', false, () => undefined as never);
        if (o.params.kind !== 'Outfit') throw new HttpError(400, `"${o.label}" is an object, not an outfit`);
        w[c.id] = o.id;
      }
      return { wardrobe: wardrobeOut(p, w) };
    });
    return json({ ...r.result, production: r.production });
  }

  if (itemId && (method === 'PATCH' || method === 'DELETE')) {
    const b = method === 'PATCH' ? await readJson(req) : {};
    const r = await change(env, user, id, version, (p) => {
      const n = p.get(itemId);
      if (!n) throw new HttpError(404, 'No such item in this production');
      if (method === 'DELETE') {
        remove(p, n);
        return { deleted: itemId };
      }
      edit(p, n, b);
      const o = outline(p);
      const all = [...o.characters, ...o.locations, ...o.props, ...o.episodes, ...o.episodes.flatMap((e) => e.scenes), ...o.scenesWithoutEpisode];
      const shots = [...all.flatMap((x) => ('shots' in x ? (x.shots as { id: string }[]) : [])), ...o.shotsWithoutScene];
      return { item: [...all, ...shots].find((x) => x.id === itemId) };
    });
    return json({ ...r.result, production: r.production });
  }
  return undefined;
}

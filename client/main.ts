// Drama Club in the browser: sign in, pick a production, edit it as Drama boards, autosave.
import {
  Graph,
  Evaluator,
  NodeEditor,
  drama2Graph,
  setImageGenerators,
  setVideoGenerators,
  meshyImageGenerator,
  falImageGenerator,
  falVideoGenerator,
  setClipKeeper,
  setGenerationLog,
  type GenerationRecord,
  listThemes,
  getTheme,
  GENERATE_EVENT,
  type GraphJSON,
} from 'mobile-nodemap';
import { api, ApiError, type Production, type ProductionSummary, type User } from './api.ts';
import { hasServer, localStore, serverStore, type ProductionStore } from './store.ts';
import { hasInlinePhotos, withPhotosInline } from './media.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const local = {
  get: (k: string) => {
    try {
      return localStorage.getItem('dramaclub:' + k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem('dramaclub:' + k);
      else localStorage.setItem('dramaclub:' + k, v);
    } catch {
      /* private mode */
    }
  },
};

const app = $('#app');
const setState = (s: 'loading' | 'in' | 'out') => (app.dataset.state = s);

// ------------------------------------------------------------------ dialogs

const dlg = $<HTMLDialogElement>('#dlg');
/** A small modal. Resolves with the form's data on OK, or null on cancel. */
function ask(opts: { title: string; body: string | Node; ok?: string; danger?: boolean }): Promise<FormData | null> {
  $('#dlg-title').textContent = opts.title;
  const body = $('#dlg-body');
  body.replaceChildren(typeof opts.body === 'string' ? Object.assign(document.createElement('p'), { textContent: opts.body }) : opts.body);
  const ok = $<HTMLButtonElement>('#dlg-ok');
  ok.textContent = opts.ok ?? 'OK';
  ok.className = `btn ${opts.danger ? 'danger' : 'primary'}`;
  dlg.returnValue = '';
  dlg.showModal();
  (body.querySelector('input') as HTMLInputElement | null)?.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? new FormData($<HTMLFormElement>('#dlg-form')) : null), { once: true });
  });
}
$('#dlg-cancel').addEventListener('click', () => dlg.close('cancel'));

const html = (s: string) => {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  return t.content;
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function banner(message: string, actions: { label: string; primary?: boolean; run: () => void }[] = []) {
  const b = $('#banner');
  b.replaceChildren(Object.assign(document.createElement('p'), { textContent: message }));
  for (const a of [...actions, { label: 'Dismiss', run: () => undefined }]) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: `btn${a.primary ? ' primary' : ''}`, textContent: a.label });
    btn.addEventListener('click', () => {
      b.hidden = true;
      a.run();
    });
    b.append(btn);
  }
  b.hidden = false;
}
const hideBanner = () => ($('#banner').hidden = true);

// ------------------------------------------------------------------ menus

function menu(button: HTMLElement, panel: HTMLElement, onPick: (act: string) => void) {
  const close = () => {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.hidden;
    document.querySelectorAll<HTMLElement>('.menu').forEach((m) => (m.hidden = true));
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector<HTMLElement>('button')?.focus();
  });
  panel.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    close();
    onPick(act);
  });
  document.addEventListener('click', (e) => !panel.contains(e.target as Node) && close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !panel.hidden && (close(), button.focus()));
}

// ------------------------------------------------------------------ AI generation

// Each person's own keys, kept in this browser and sent only to that service. ✨ Generate in
// picture fields offers Meshy and fal (Nano Banana); 🎬 Generate clip on shots uses fal (Seedance).
const falKey = { label: 'fal API key', get: () => local.get('fal-key'), set: (v: string) => local.set('fal-key', v) };
setImageGenerators([
  meshyImageGenerator({ key: { label: 'Meshy API key', get: () => local.get('meshy-key'), set: (v) => local.set('meshy-key', v) } }),
  falImageGenerator({ key: falKey }),
]);
setVideoGenerators([falVideoGenerator({ key: falKey })]);

// ------------------------------------------------------------------ the editor

const registry = drama2Graph.createRegistry();
const graph = new Graph(registry);
const evaluator = new Evaluator(graph, registry);
const canvas = $('#canvas');
let editor: NodeEditor | undefined;

function ensureEditor(): NodeEditor {
  if (editor) return editor;
  editor = new NodeEditor(canvas, { graph, registry, evaluator, views: drama2Graph.editor?.views, plugins: drama2Graph.editor?.plugins, direction: drama2Graph.editor?.direction });
  applyTheme();
  // Where you are goes in the address, so a reload (or a shared link) comes back to it.
  const ed = editor;
  ed.on('view', ({ id }) => setSpot({ v: id }));
  ed.on('select', ({ node }) => setSpot({ n: node }));
  ed.on('sheet', (x) => {
    if (x.node) {
      sheetBack.opened();
      setSpot({ n: x.node, s: x.param ?? 'edit', st: x.title, se: x.event });
    } else {
      setSpot({ s: undefined, st: undefined, se: undefined });
      sheetBack.closed();
    }
  });
  addEventListener('popstate', () => sheetBack.popped());
  return editor;
}

/**
 * Back closes an open sheet (the phone's back gesture too) instead of leaving the page. Opening a
 * sheet adds a history entry; Back takes it off and closes the sheet; closing it any other way
 * (Done, the backdrop) takes the entry off too, so history doesn't pile up.
 */
const sheetBack = {
  /** A history entry stands for the open sheet. */
  entry: false,
  /** history.back() we called ourselves: its popstate isn't a Back press. */
  ours: false,
  opened() {
    if (!this.entry) this.push();
  },
  push() {
    // Reloaded on a sheet's entry (the browser keeps its state): that entry stands for it again.
    if ((history.state as { sheet?: boolean } | null)?.sheet) return void (this.entry = true);
    // The entry below is where you were without the sheet; the new one, with it.
    const here = location.href;
    const base = new URL(here);
    for (const k of ['s', 'st', 'se']) base.searchParams.delete(k);
    history.replaceState(null, '', base);
    history.pushState({ sheet: true }, '', here);
    this.entry = true;
  },
  closed() {
    if (!this.entry) return;
    // Another sheet may open straight away (one replaces another): then keep the entry.
    setTimeout(() => {
      if (!this.entry || document.querySelector('.nm-sheet:not(.nm-choose)')) return;
      this.entry = false;
      this.ours = true;
      history.back();
    }, 0);
  },
  popped() {
    if (this.ours) return void (this.ours = false);
    if (!this.entry) return;
    // Back pressed with a sheet open: close it (the entry is already gone).
    this.entry = false;
    editor?.closePalette();
  },
};

/**
 * Where you are in a production, kept in the address next to ?p: the board (v), the selected
 * card (n), and an open sheet (s: "edit", or a field such as "images", with its title st and
 * the event that opened its panel se).
 */
type Spot = { v?: string; n?: string; s?: string; st?: string; se?: string };
const SPOT_KEYS = ['v', 'n', 's', 'st', 'se'] as const;
/** While a production loads and its spot is put back, the editor's own events don't rewrite it. */
let spotQuiet = false;
const urlSpot = (): Spot => {
  const q = new URLSearchParams(location.search);
  return Object.fromEntries(SPOT_KEYS.map((k) => [k, q.get(k) ?? undefined]).filter(([, v]) => v)) as Spot;
};
function setSpot(patch: Spot) {
  if (spotQuiet) return;
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(patch)) v ? u.searchParams.set(k, v) : u.searchParams.delete(k);
  if (u.href !== location.href) history.replaceState(history.state, '', u); // keeps a sheet's entry marked
}
/** Back to a spot: its board, its card (zoomed to), its sheet. Missing cards and boards are skipped. */
async function restoreSpot(ed: NodeEditor, spot: Spot) {
  try {
    if (spot.v && drama2Graph.editor?.views?.some((v) => v.id === spot.v)) await ed.setView(spot.v);
    const n = spot.n && graph.nodes.has(spot.n) ? spot.n : undefined;
    if (n) {
      ed.select({ node: n });
      ed.zoomToNode(n, { animate: false });
      if (spot.s === 'edit') ed.openNodeEditor(n);
      else if (spot.s) ed.openFieldSheet(n, spot.s, spot.st, spot.se === GENERATE_EVENT ? GENERATE_EVENT : undefined);
    }
  } finally {
    spotQuiet = false;
    // Write down where it actually ended up (a card that's gone drops out).
    setSpot({ v: ed.currentView, n: ed.selection.node, ...(spot.s && ed.selection.node === spot.n ? {} : { s: undefined, st: undefined, se: undefined }) });
  }
}

const statusEl = $('#status');
evaluator.on('start', () => statusEl.setAttribute('data-state', 'running'));
evaluator.on('done', (r) => {
  statusEl.setAttribute('data-state', r.errors.length ? 'error' : 'ok');
  statusEl.textContent = typeof r.outputs.summary === 'string' ? r.outputs.summary : r.errors.length ? `${r.errors.length} problem${r.errors.length > 1 ? 's' : ''}` : 'ready';
});

// Themes: "Club colours" follows this page's palette; the rest are the library's built-in themes.
const themeSel = $<HTMLSelectElement>('#theme');
themeSel.append(new Option('Club colours', ''));
for (const mode of ['light', 'dark'] as const) {
  const group = document.createElement('optgroup');
  group.label = mode === 'light' ? 'Light themes' : 'Dark themes';
  for (const t of listThemes().filter((x) => x.mode === mode)) group.append(new Option(t.name, t.id));
  themeSel.append(group);
}
themeSel.value = local.get('theme') ?? '';
function applyTheme() {
  const t = themeSel.value ? getTheme(themeSel.value) : undefined;
  editor?.setTheme(t ?? null);
  if (t) document.documentElement.dataset.theme = t.mode;
  else delete document.documentElement.dataset.theme;
}
themeSel.addEventListener('change', () => {
  local.set('theme', themeSel.value);
  applyTheme();
});

// ------------------------------------------------------------------ productions

let store: ProductionStore = serverStore;
let productions: ProductionSummary[] = [];
let current: Production | undefined;
const prodSel = $<HTMLSelectElement>('#prod');

function renderPicker() {
  prodSel.replaceChildren(...productions.map((p) => new Option(p.title, p.id, false, p.id === current?.id)));
  const none = !productions.length;
  $('#empty').hidden = !none;
  canvas.hidden = none;
  prodSel.disabled = $<HTMLButtonElement>('#more').disabled = none;
  document.title = current ? `${current.title} · Drama Club` : 'Drama Club';
}

function upsertSummary(p: ProductionSummary) {
  productions = [p, ...productions.filter((x) => x.id !== p.id)];
}

/** An empty production: no cards yet. */
const blankGraph = (): GraphJSON => ({ version: 1, type: drama2Graph.id, nodes: [], edges: [] });
const exampleGraph = (): GraphJSON => ({ ...structuredClone(drama2Graph.examples![0].graph), type: drama2Graph.id });

async function open(id: string, { fresh = false, spot }: { fresh?: boolean; spot?: Spot } = {}) {
  await flush();
  hideBanner();
  show(await store.get(id), fresh, spot);
}

function show(p: Production, fresh = false, spot?: Spot) {
  spotQuiet = true;
  current = p;
  dirty = false;
  const ed = ensureEditor();
  canvas.hidden = false;
  $('#empty').hidden = true;
  try {
    loading = true;
    graph.load(structuredClone(p.graph));
  } catch (err) {
    console.error(err);
    banner(`This production could not be opened: ${(err as Error).message}`);
    graph.load(blankGraph());
  } finally {
    loading = false;
  }
  ed.history?.reset();
  ed.select({});
  requestAnimationFrame(() => {
    if (fresh) void ed.autoLayout({ animate: false });
    else ed.fit();
    // Back where the address says (a reload), else at the start.
    void restoreSpot(ed, spot ?? {});
  });
  local.set(`last:${store.mode}`, p.id);
  setUrl(p.id);
  renderPicker();
  setSave('saved');
  // Made before pictures moved to R2 (or imported): save once now to move its photos out.
  if (store.mode === 'server' && hasInlinePhotos(p.graph)) {
    dirty = true;
    setSave('saving', 'Moving pictures…');
    void save();
  }
}

async function create(title: string, graphJson: GraphJSON) {
  await flush();
  const production = await store.create(title, graphJson);
  upsertSummary(production);
  show(production, true);
}

async function newProduction(template?: 'blank' | 'example') {
  const body = html(`
    <label>Title <input type="text" name="title" required maxlength="200" value="${productions.length ? '' : 'Our first production'}" placeholder="e.g. Spring showcase"></label>
    <label class="choice"><input type="radio" name="template" value="blank" ${template !== 'example' ? 'checked' : ''}><span>Blank<small>Empty boards, ready for your cast.</small></span></label>
    <label class="choice"><input type="radio" name="template" value="example" ${template === 'example' ? 'checked' : ''}><span>From the example<small>A finished term of a school drama: cast, costumes, locations, shots, scenes and episodes.</small></span></label>`);
  const data = await ask({ title: 'New production', body, ok: 'Create' });
  if (!data) return;
  const title = String(data.get('title') ?? '').trim() || 'Untitled production';
  await run(() => create(title, data.get('template') === 'example' ? exampleGraph() : blankGraph()));
}

prodSel.addEventListener('change', () => run(() => open(prodSel.value)));
$('#new').addEventListener('click', () => newProduction());
document.querySelectorAll<HTMLButtonElement>('[data-template]').forEach((b) => b.addEventListener('click', () => newProduction(b.dataset.template as 'blank' | 'example')));

menu($('#more'), $('#more-menu'), (act) => {
  if (!current) return;
  const p = current;
  if (act === 'rename') {
    void ask({ title: 'Rename production', body: html(`<label>Title <input type="text" name="title" required maxlength="200" value="${esc(p.title)}"></label>`), ok: 'Rename' }).then(
      (d) => d && run(() => save({ title: String(d.get('title')).trim() })),
    );
  } else if (act === 'duplicate') {
    void run(() => create(`${p.title} (copy)`, graph.toJSON()));
  } else if (act === 'export') {
    // Pictures go in the file itself, so it opens anywhere (another account, browser-only mode).
    void run(async () => {
      setSave('saving', 'Preparing download…');
      const json = await withPhotosInline(graph.toJSON());
      setSave(dirty ? 'unsaved' : 'saved');
      const blob = new Blob([JSON.stringify({ title: p.title, graph: json }, null, 2)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${p.title.replace(/[^\w -]+/g, '').trim() || 'production'}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  } else if (act === 'import') {
    $('#import-file').click();
  } else if (act === 'delete') {
    void ask({ title: `Delete “${p.title}”?`, body: 'Every card and picture in it goes too. This can’t be undone.', ok: 'Delete', danger: true }).then(
      (d) =>
        d &&
        run(async () => {
          clearTimeout(saveTimer);
          dirty = false;
          await store.remove(p.id);
          productions = productions.filter((x) => x.id !== p.id);
          current = undefined;
          local.set(`last:${store.mode}`, null);
          if (productions[0]) await open(productions[0].id);
          else {
            setUrl(null);
            graph.load(blankGraph());
            renderPicker();
            setSave('');
          }
        }),
    );
  }
});

$<HTMLInputElement>('#import-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await run(async () => {
    const parsed = JSON.parse(await file.text());
    // Either our export ({ title, graph }) or a bare map from the playground's JSON panel.
    const g: GraphJSON = parsed?.graph ?? parsed;
    if (!Array.isArray(g?.nodes)) throw new Error('That file is not a production or a node map');
    if (g.type && g.type !== drama2Graph.id) throw new Error(`That map is a “${g.type}” map, not Drama boards`);
    if (g.nodes.some((n) => !registry.get(n.type))) throw new Error('That map has cards this app doesn’t know');
    await create(parsed?.title ?? file.name.replace(/\.json$/i, ''), { ...g, type: drama2Graph.id });
  });
});

// ------------------------------------------------------------------ saving

const saveEl = $('#save');
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let loading = false;
let saving: Promise<void> | null = null;
let retryMs = 2000;

function setSave(state: 'saved' | 'saving' | 'unsaved' | 'error' | '', text?: string) {
  saveEl.dataset.state = state;
  saveEl.textContent = text ?? { saved: store.mode === 'local' ? 'Saved on this device' : 'Saved', saving: 'Saving…', unsaved: 'Unsaved changes', error: 'Not saved', '': '' }[state];
}

graph.on('change', (e) => {
  if (loading || e.kind === 'load' || !current) return;
  dirty = true;
  setSave('unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 800);
});

/** Save the open production: its map, and any other fields given. */
async function save(fields: { title?: string; force?: boolean } = {}): Promise<void> {
  if (saving) await saving;
  const p = current;
  if (!p) return;
  clearTimeout(saveTimer);
  const sendGraph = dirty;
  if (!sendGraph && !fields.title) return;
  dirty = false;
  setSave('saving');
  saving = (async () => {
    try {
      const production = await store.update(p.id, {
        ...(sendGraph ? { graph: graph.toJSON() } : {}),
        ...(fields.title ? { title: fields.title } : {}),
        ...(fields.force ? { force: true } : { version: p.version }),
      });
      retryMs = 2000;
      if (current?.id === p.id) Object.assign(current, production);
      upsertSummary(production);
      renderPicker();
      setSave(dirty ? 'unsaved' : 'saved');
    } catch (err) {
      if (sendGraph) dirty = true;
      if (err instanceof ApiError && err.status === 409) {
        setSave('error', 'Changed elsewhere');
        banner('This production was changed on another device or tab since you opened it.', [
          { label: 'Load theirs', run: () => void run(() => ((dirty = false), open(p.id))) },
          { label: 'Keep mine', primary: true, run: () => void run(() => save({ ...fields, force: true })) },
        ]);
      } else if (err instanceof ApiError && err.status === 401) {
        setSave('error');
        banner('You were signed out. Sign in again to keep saving; this tab keeps your changes until then.', [{ label: 'Sign in', primary: true, run: () => void signInAgain() }]);
      } else if (err instanceof ApiError && err.status < 500) {
        setSave('error');
        banner(err.message);
      } else {
        // Offline or the server is down: keep trying, backing off.
        setSave('error', 'Offline · retrying');
        saveTimer = setTimeout(() => void save(fields), retryMs);
        retryMs = Math.min(retryMs * 2, 60_000);
      }
    } finally {
      saving = null;
    }
  })();
  return saving;
}

/** Save anything pending now (before switching productions). */
async function flush() {
  if (saving) await saving;
  if (dirty) await save();
}

addEventListener('beforeunload', (e) => {
  if (dirty || saving) e.preventDefault();
});

/**
 * Pull to refresh, from the top bar. Browsers only do it when the page itself scrolls, and this
 * one doesn't (the map takes every gesture), so it's done here: drag the bar down past the mark
 * and let go. Unsaved changes are saved first; if that fails, it doesn't reload.
 */
function pullToRefresh(bar: HTMLElement) {
  const PULL = 70;
  const pill = document.createElement('div');
  pill.className = 'ptr';
  pill.setAttribute('role', 'status');
  document.body.append(pill);
  let start: { x: number; y: number; id: number } | undefined;
  let dy = 0;
  const show = () => {
    const d = Math.min(dy, PULL * 1.6);
    pill.style.transform = `translate(-50%, ${d - 44}px)`;
    pill.style.opacity = String(Math.min(1, d / PULL));
    pill.textContent = dy >= PULL ? '↻ Release to refresh' : '↓ Pull to refresh';
    pill.classList.toggle('ptr-ready', dy >= PULL);
  };
  const reset = () => {
    start = undefined;
    dy = 0;
    pill.style.transform = '';
    pill.style.opacity = '';
    pill.classList.remove('ptr-ready');
  };
  bar.addEventListener('touchstart', (e) => {
    // Not from the bar's controls (the production list, menus).
    if (e.touches.length !== 1 || (e.target as Element).closest('select, input, .menu')) return;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY, id: e.touches[0].identifier };
    dy = 0;
  }, { passive: true });
  bar.addEventListener('touchmove', (e) => {
    const t = start && [...e.touches].find((x) => x.identifier === start!.id);
    if (!t || !start) return;
    dy = t.clientY - start.y;
    // Mostly down: it's a pull. Sideways or up: let it be.
    if (dy < 8 || Math.abs(t.clientX - start.x) > dy) return void ((dy = 0), show());
    e.preventDefault();
    show();
  }, { passive: false });
  bar.addEventListener('touchend', () => {
    if (dy < PULL) return reset();
    pill.textContent = '↻ Saving…';
    pill.classList.add('ptr-busy');
    void flush()
      .then(() => {
        // A save that failed leaves the changes marked unsaved: don't lose them.
        if (dirty) throw new Error('your changes aren’t saved yet');
        pill.textContent = '↻ Refreshing…';
        location.reload();
      })
      .catch((err: Error) => {
        pill.classList.remove('ptr-busy');
        reset();
        setSave('error', `Not refreshed: ${err.message}`);
      });
  });
  bar.addEventListener('touchcancel', reset);
}
pullToRefresh(document.querySelector<HTMLElement>('.bar')!);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && dirty && void save());

/** Run an action, showing any error in the banner. */
async function run(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    banner(err instanceof Error ? err.message : String(err));
  }
}

// ------------------------------------------------------------------ signing in

let user: User | null = null;

function showUser(u: User) {
  const av = $('#user');
  av.textContent = u.picture ? '' : (u.name || u.email).slice(0, 1).toUpperCase();
  av.style.backgroundImage = u.picture ? `url("${u.picture.replace(/"/g, '%22')}")` : '';
  $('#who').replaceChildren(html(`<b>${esc(u.name)}</b>${esc(u.email)}`));
}

menu($('#user'), $('#user-menu'), (act) => {
  if (act === 'logout') {
    void run(async () => {
      await flush();
      await api.post('/auth/logout', {});
      location.href = location.pathname;
    });
  } else if (act === 'signin') {
    void run(async () => {
      await flush();
      local.set('mode', null);
      location.href = location.pathname;
    });
  } else if (act === 'tokens') {
    void run(showTokens);
  } else if (act === 'keys') {
    const body = html(`<p>Your own keys for AI services. They stay in this browser and are only sent to that service, which bills you directly.</p>
      <label>Meshy API key <small>pictures</small><input type="password" name="meshy" autocomplete="off" placeholder="msy_…" value="${esc(local.get('meshy-key') ?? '')}"></label>
      <label>fal API key <small>pictures (Nano Banana) and shot clips (Seedance)</small><input type="password" name="fal" autocomplete="off" placeholder="fal key" value="${esc(local.get('fal-key') ?? '')}"></label>
      <p><a href="https://www.meshy.ai/api" target="_blank" rel="noopener">Get a Meshy key</a> · <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener">Get a fal key</a></p>`);
    void ask({ title: 'AI service keys', body, ok: 'Save' }).then((d) => {
      if (!d) return;
      local.set('meshy-key', String(d.get('meshy')).trim() || null);
      local.set('fal-key', String(d.get('fal')).trim() || null);
    });
  }
});

/** API tokens for agents and scripts: list, make (shown once) and revoke. */
async function showTokens() {
  if (store.mode !== 'server') {
    banner('API tokens need an account: sign in to use them.');
    return;
  }
  const { tokens } = await api.get<{ tokens: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[] }>('/tokens');
  const when = (t: string | null) => (t ? new Date(t).toLocaleDateString() : 'never');
  const body = html(`<p>Agents and scripts can set up your productions with a token: <code>Authorization: Bearer dc_…</code>.
      See <a href="agents.md" target="_blank" rel="noopener">the guide</a> and <a href="api/openapi.json" target="_blank" rel="noopener">the API description</a>.</p>
    <ul class="tokens">${tokens.map((t) => `<li><span><b>${esc(t.name)}</b><small>made ${when(t.createdAt)} · last used ${when(t.lastUsedAt)}</small></span><button type="button" class="btn" data-revoke="${esc(t.id)}">Revoke</button></li>`).join('') || '<li><small>No tokens yet.</small></li>'}</ul>
    <label>New token name <input type="text" name="name" maxlength="80" placeholder="e.g. Claude, my laptop"></label>`);
  body.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((b) =>
    b.addEventListener('click', () =>
      void run(async () => {
        await api.del(`/tokens/${b.dataset.revoke}`);
        b.closest('li')!.remove();
      }),
    ),
  );
  const d = await ask({ title: 'API tokens', body, ok: 'Make token' });
  if (!d) return;
  const made = await api.post<{ token: string; name: string }>('/tokens', { name: String(d.get('name') ?? '').trim() });
  const shown = html(`<p>Copy it now: it won't be shown again. Anyone with it can change your productions, so keep it private, and revoke it here if it leaks.</p>
    <label>${esc(made.name)} <input type="text" name="token" readonly value="${esc(made.token)}"></label>`);
  const input = shown.querySelector('input')!;
  void navigator.clipboard?.writeText(made.token).then(() => (input.title = 'Copied'), () => undefined);
  await ask({ title: 'Your new API token', body: shown, ok: 'Done' });
}

let gsiLoaded: Promise<void> | undefined;
interface Gsi {
  accounts: { id: { initialize(o: object): void; renderButton(el: HTMLElement, o: object): void; prompt(): void } };
}
const loadGsi = () =>
  (gsiLoaded ??= new Promise<void>((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
    s.onload = () => resolve();
    s.onerror = () => {
      gsiLoaded = undefined;
      reject(new Error('Google sign-in could not be loaded. Check your connection and reload.'));
    };
    document.head.append(s);
  }));

async function showSignIn() {
  setState('out');
  const errEl = $('#signin-err');
  const cfg = await api.get<{ googleClientId: string | null; devLogin: boolean }>('/config');
  $('#go-local').onclick = () => {
    local.set('mode', 'local');
    void run(startLocal);
  };
  const dev = $<HTMLFormElement>('#dev-login');
  dev.hidden = !cfg.devLogin;
  dev.onsubmit = (e) => {
    e.preventDefault();
    void api
      .post('/auth/dev', { email: new FormData(dev).get('email') })
      .then(boot)
      .catch((err) => (errEl.textContent = err.message));
  };
  if (!cfg.googleClientId) return;
  try {
    await loadGsi();
  } catch (err) {
    errEl.textContent = (err as Error).message;
    return;
  }
  const google = (window as unknown as { google: Gsi }).google;
  google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    callback: (r: { credential: string }) =>
      void api
        .post('/auth/google', { credential: r.credential })
        .then(boot)
        .catch((err) => (errEl.textContent = err.message)),
  });
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  google.accounts.id.renderButton($('#gbtn'), { theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
}

/** Signed out mid-edit: sign in in a popup-free way by reloading after saving locally. */
async function signInAgain() {
  // Keep the unsaved map in this browser, then come back to it after signing in.
  if (current && dirty) local.set(`draft:${current.id}`, JSON.stringify({ version: current.version, graph: graph.toJSON() }));
  dirty = false;
  location.reload();
}

/** The production in the address (?p=<id>), and keeping it there. */
const urlProduction = () => new URLSearchParams(location.search).get('p');
function setUrl(id: string | null) {
  const u = new URL(location.href);
  // Another production: where you were in the last one no longer applies.
  if (u.searchParams.get('p') !== id) for (const k of SPOT_KEYS) u.searchParams.delete(k);
  if (id) u.searchParams.set('p', id);
  else u.searchParams.delete('p');
  if (u.href !== location.href) history.replaceState(history.state, '', u); // keeps a sheet's entry marked
}

let serverAvailable = false;

async function boot() {
  serverAvailable = await hasServer();
  // No server (GitHub Pages, opened from a file), or the person chose to stay on this device.
  if (!serverAvailable || local.get('mode') === 'local') return startLocal();
  const me = await api.get<{ user: User | null }>('/me');
  user = me.user;
  if (!user) return showSignIn();
  store = serverStore;
  showUser(user);
  $('[data-act="signin"]').hidden = true;
  await startEditing();
}

/** Productions kept in this browser only: no account needed. */
async function startLocal() {
  store = localStore;
  const av = $('#user');
  av.textContent = '📱';
  av.style.backgroundImage = '';
  $('#who').replaceChildren(
    html(`<b>Not signed in</b>Productions are saved in this browser only. Download them as JSON to back them up or move them.`),
  );
  $('[data-act="logout"]').hidden = true;
  // Signing in is only possible where there is a server.
  $('[data-act="signin"]').hidden = !serverAvailable;
  await startEditing();
}

async function startEditing() {
  setState('in');
  // Signed in: finished clips are copied into this site's storage (fal's links expire, and the
  // page can't read videos from fal to take their last frame). Browser-only: fal's link as it is.
  setClipKeeper(store.mode === 'server' ? async (url) => (await api.post<{ url: string }>('/clips', { url })).url : null);
  // What made each picture and clip, for 7 days: on the server when signed in, else in this browser.
  setGenerationLog(store.mode === 'server' ? serverGenerations : localGenerations);
  productions = await store.list();
  const fromUrl = urlProduction();
  const spot = urlSpot();
  const want = [fromUrl, local.get(`last:${store.mode}`), productions[0]?.id].find((id) => id && productions.some((p) => p.id === id));
  if (fromUrl && !want) banner(store.mode === 'local' ? 'That production isn’t saved in this browser.' : 'That production isn’t one of yours, or it was deleted.');
  if (!want) {
    setUrl(null);
    renderPicker();
    return;
  }
  await open(want, { spot: want === fromUrl ? spot : undefined });
  restoreDraft();
}

const KEEP_MS = 7 * 86_400_000;
const serverGenerations = {
  save(r: GenerationRecord) {
    if (current) void api.post(`/productions/${current.id}/generations`, r).catch(() => undefined);
  },
  async list(node: string, param: string) {
    if (!current) return [];
    const q = new URLSearchParams({ node, param });
    return (await api.get<{ generations: GenerationRecord[] }>(`/productions/${current.id}/generations?${q}`)).generations;
  },
};
/** Browser-only: kept in this browser, the last 7 days (at most 100 per production). */
const localGenerations = {
  key: () => `gen:${current?.id ?? ''}`,
  read(): GenerationRecord[] {
    try {
      const all = JSON.parse(local.get(this.key()) ?? '[]') as GenerationRecord[];
      return all.filter((r) => Date.now() - r.at < KEEP_MS);
    } catch {
      return [];
    }
  },
  save(r: GenerationRecord) {
    if (current) local.set(this.key(), JSON.stringify([...this.read(), r].slice(-100)));
  },
  async list(node: string, param: string) {
    return this.read().filter((r) => r.node === node && r.param === param).reverse();
  },
};

/** A draft kept when the session ran out: put it back and save it. */
function restoreDraft() {
  if (!current) return;
  const raw = local.get(`draft:${current.id}`);
  if (!raw) return;
  local.set(`draft:${current.id}`, null);
  try {
    const d = JSON.parse(raw) as { version: number; graph: GraphJSON };
    graph.load(d.graph);
    current.version = d.version;
    dirty = true;
    void save();
  } catch {
    /* ignore a broken draft */
  }
}

boot().catch((err) => {
  setState('out');
  $('#signin-err').textContent = err instanceof ApiError ? err.message : 'Drama Club could not reach its server. Reload to try again.';
});

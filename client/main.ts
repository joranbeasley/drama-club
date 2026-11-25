// Drama Club in the browser: sign in, pick a production, edit it as Drama boards, autosave.
import {
  Graph,
  Evaluator,
  NodeEditor,
  drama2Graph,
  setImageGenerator,
  meshyImageGenerator,
  listThemes,
  getTheme,
  type GraphJSON,
} from 'mobile-nodemap';
import { api, ApiError, type Production, type ProductionSummary, type User } from './api.ts';

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

// ------------------------------------------------------------------ image generation

// ✨ Generate in picture fields: Meshy text-to-image with the user's own key, kept in this browser.
setImageGenerator(
  meshyImageGenerator({
    key: { label: 'Meshy API key', get: () => local.get('meshy-key'), set: (v) => local.set('meshy-key', v) },
  }),
);

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
  return editor;
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

async function open(id: string, { fresh = false } = {}) {
  await flush();
  hideBanner();
  const { production } = await api.get<{ production: Production }>(`/productions/${id}`);
  show(production, fresh);
}

function show(p: Production, fresh = false) {
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
  requestAnimationFrame(() => (fresh ? void ed.autoLayout({ animate: false }) : ed.fit()));
  local.set('last', p.id);
  if (location.pathname !== `/p/${p.id}`) history.replaceState(null, '', `/p/${p.id}`);
  renderPicker();
  setSave('saved');
}

async function create(title: string, graphJson: GraphJSON) {
  await flush();
  const { production } = await api.post<{ production: Production }>('/productions', { title, graph: graphJson });
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
    const blob = new Blob([JSON.stringify({ title: p.title, graph: graph.toJSON() }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${p.title.replace(/[^\w -]+/g, '').trim() || 'production'}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } else if (act === 'import') {
    $('#import-file').click();
  } else if (act === 'delete') {
    void ask({ title: `Delete “${p.title}”?`, body: 'Every card and picture in it goes too. This can’t be undone.', ok: 'Delete', danger: true }).then(
      (d) =>
        d &&
        run(async () => {
          clearTimeout(saveTimer);
          dirty = false;
          await api.del(`/productions/${p.id}`);
          productions = productions.filter((x) => x.id !== p.id);
          current = undefined;
          local.set('last', null);
          if (productions[0]) await open(productions[0].id);
          else {
            history.replaceState(null, '', '/');
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
  saveEl.textContent = text ?? { saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved changes', error: 'Not saved', '': '' }[state];
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
      const { production } = await api.put<{ production: ProductionSummary }>(`/productions/${p.id}`, {
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
      location.href = '/';
    });
  } else if (act === 'meshy') {
    const body = html(`<p>Picture fields can generate images with Meshy. Your key stays in this browser and is only sent to Meshy.</p>
      <label>Meshy API key <input type="password" name="key" autocomplete="off" placeholder="msy_…" value="${esc(local.get('meshy-key') ?? '')}"></label>`);
    void ask({ title: 'Image generation', body, ok: 'Save' }).then((d) => d && local.set('meshy-key', String(d.get('key')).trim() || null));
  }
});

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

async function boot() {
  const me = await api.get<{ user: User | null }>('/me');
  user = me.user;
  if (!user) return showSignIn();
  showUser(user);
  setState('in');
  ({ productions } = await api.get<{ productions: ProductionSummary[] }>('/productions'));
  const fromUrl = /^\/p\/([\w-]+)/.exec(location.pathname)?.[1];
  const want = [fromUrl, local.get('last'), productions[0]?.id].find((id) => id && productions.some((p) => p.id === id));
  if (fromUrl && !want) banner('That production isn’t one of yours, or it was deleted.');
  if (!want) {
    history.replaceState(null, '', '/');
    renderPicker();
    return;
  }
  await open(want);
  restoreDraft();
}

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

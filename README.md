# Drama Club

Plan productions on your phone: cast and costumes, locations, props, shots, scenes and episodes, as tabs of linked cards, with pictures, shot lists and Seedance video scripts. It is the **Drama boards** map from [mobile-nodemap](https://github.com/joranbeasley/mobile-nodemap) (`drama2Graph`) as a standalone app, with **Sign in with Google**, running on **Cloudflare's free tier**: a Worker serves the app and its API, and productions live in a **D1** database.

Without an account (or with no server at all, as on GitHub Pages) productions are kept in the browser instead.

## Run it locally

Needs Node 22.18+. No database to install: `wrangler dev` runs the Worker and a local D1.

```sh
npm install                       # also builds mobile-nodemap from GitHub
cp .dev.vars.example .dev.vars    # DEV_LOGIN=1: sign in with any email on localhost
npm run dev                       # http://localhost:8787
```

`npm run dev` applies the migrations (`migrations/*.sql`) to the local database, rebuilds the client on change and reloads the Worker.

## Deploying to Cloudflare

`.github/workflows/deploy.yml` tests every push and deploys `main`: it finds or creates the `dramaclub` D1 database and the `dramaclub-media` R2 bucket (`scripts/ensure-d1.mjs`), applies migrations and runs `wrangler deploy`. One-time setup:

1. **Cloudflare.** Sign up (free) and open **Workers & Pages** once so your account gets a `workers.dev` subdomain. Note your **Account ID** (on the Workers & Pages overview, or the account home page).
2. **API token.** My Profile → API Tokens → Create Token → Custom token, with these **Account** permissions: *Workers Scripts: Edit*, *D1: Edit*, *Workers R2 Storage: Edit*, *Account Settings: Read*. R2 must be enabled on the account (R2 in the dashboard; it asks for a payment method, and the free allowance is 10 GB).
3. **GitHub.** In the repo, Settings → Secrets and variables → Actions:
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - Variables: `GOOGLE_CLIENT_ID` (below), and optionally `ALLOWED_EMAILS` / `ALLOWED_DOMAINS`
4. Push, or run the **Deploy** workflow. The app is at `https://drama-club.<your-subdomain>.workers.dev` (also shown on the workflow run).

Until the token is set the deploy job is skipped, so pushes stay green. To deploy from your own machine instead: `npx wrangler login && npm run deploy`.

### Google sign-in

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID**, type **Web application**.
2. **Authorized JavaScript origins**: `https://drama-club.<your-subdomain>.workers.dev` (and `http://localhost:8787` to try it locally). No redirect URIs.
3. Put the client id in the `GOOGLE_CLIENT_ID` repository variable and deploy again.

The page shows Google's button. Google hands the browser a signed ID token, which the page posts to `/api/auth/google`; the Worker checks Google's signature, the audience, expiry and that the email is verified (`worker/google.ts`, using `jose`), applies the allow lists, and starts a session: an `httpOnly`, `SameSite=Lax`, `Secure` cookie holding a random token, of which only the SHA-256 is stored. No client secret is involved.

### Settings

| Variable | | |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | empty: no sign-in | OAuth web client id. Without it the app runs browser-only |
| `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` | empty: anyone | Comma-separated allow lists |
| `SESSION_DAYS` | `30` | In `wrangler.jsonc` |
| `DEV_LOGIN` | off | `1` in `.dev.vars` only. Works only on `localhost` even if set elsewhere |

### Free-tier limits

The design keeps well inside them: the Worker never parses a production's JSON (requests use a few ms of the 10 ms CPU allowance), and maps are stored as text in chunks under D1's 2 MB-per-value limit. A production can be up to 24 MB of JSON (pictures are stored inside it as compressed JPEGs, so roughly a hundred or more pictures). D1's free 500 MB per database holds a lot of productions; pictures are what fill it.

## GitHub Pages and browser-only mode

When there is no server behind the page (GitHub Pages, any static host), or someone taps **Continue without an account**, productions are kept in that browser (IndexedDB, which has room for pictures, unlike `localStorage`). Everything works the same, but nothing leaves the device: **Download as JSON** backs up or moves a production, and **Import JSON** brings it into an account later.

`.github/workflows/pages.yml` publishes `public/` to Pages from the default branch (Settings → Pages → Source: GitHub Actions).

## How it fits together

```
client/            browser app, bundled with esbuild into public/app.js
  main.ts          sign-in, production picker, the NodeEditor (drama2Graph), autosave
  store.ts         where productions live: the API (serverStore) or IndexedDB (localStore)
  api.ts           fetch wrapper
public/            index.html, app.css (and the built app.js): served as static assets
worker/            the Cloudflare Worker: /api/*
  index.ts         routing, security headers, errors
  auth.ts          sessions, Google and dev sign-in, /api/me
  google.ts        ID token verification
  productions.ts   productions, chunked storage, version checks
migrations/        D1 schema, applied in order
scripts/           client build, ensure-d1 (deploy)
test/              API tests against the real Worker in wrangler dev, and token checks
```

**API** (JSON, under `/api`): `GET /config`, `GET /me`, `POST /auth/google {credential}`, `POST /auth/logout`, `GET /productions`, `POST /productions?title=…` (body: the map), `GET /productions/:id`, `PUT /productions/:id/graph?version=N` (body: the map; `force=1` to overwrite), `PATCH /productions/:id {title, version}`, `DELETE /productions/:id`. A map is mobile-nodemap `GraphJSON` (type `drama2`).

**Clips.** A clip made with 🎬 is copied from fal into R2 (`POST /api/clips`, `worker/clips.ts`, from fal's file hosts only), because fal's links expire and the page can't read videos from fal to take their last frame. The shot plays the copy (`api/clips/<id>.mp4`, owners only, with Range requests for seeking) and keeps its last frame. A shot whose clip is still on fal is copied when it's shown.

**Agent API.** Agents and scripts can set up productions with a personal API token (account menu → **API tokens…**; stored hashed, shown once, revocable, and unable to make tokens or delete productions): `Authorization: Bearer dc_…`. `GET /api/productions/{id}/outline` reads a production; `POST /api/productions/{id}/scenes` sets up a scene in one call (shots, cast, location, outfits, matched by name and created when missing); smaller calls add characters, locations, props, episodes and shots, edit or delete any item, and set the wardrobe at episode, scene or shot level. Writes go onto the latest version (or only onto `?version=N`). The OpenAPI 3.1 description is served at `/api/openapi.json` and a guide at `/agents.md` (`worker/agent.ts`, `worker/openapi.ts`, `worker/tokens.ts`, `public/agents.md`).

**The address keeps your place.** `?p=` is the production, `v` the board, `n` the selected card, and `s` an open sheet (`edit`, or a field such as `images` with its title `st` and `se` when its generate panel was open). A reload, or a link sent to someone, opens the same board, card and sheet; cards that no longer exist are skipped. Switching productions starts afresh. **Back** (and the phone's back gesture) closes an open sheet before it leaves the page: opening a sheet adds a history entry, Back takes it off, and closing the sheet another way takes it off too.

**Pull to refresh.** Browsers only pull to refresh when the page scrolls, and this one doesn't (the map takes every gesture), so the top bar does it: drag it down and let go. Unsaved changes are saved first; if they can't be, it doesn't reload.

**Saving.** Edits save automatically after a short pause. Each save names the version it was based on; if the production was saved elsewhere since (another tab or phone), the server answers `409` and the app offers **Load theirs** or **Keep mine**. A save writes a new set of chunks and switches to it in the same D1 transaction as the version check, so a refused or interrupted save never leaves a half-written map. Offline saves retry with back-off, and closing the tab with unsaved changes asks first.

**Pictures.** Photos are stored in R2, named by the SHA-256 of their content, so each is stored once. A production holds links (`api/images/<hash>.jpg`) instead of the pictures, which keeps it a few KB. The browser uploads new photos when it saves (`client/media.ts`), and a production saved before this moves its photos out the first time it's opened. Pictures are served by the Worker only to people who uploaded them, and cached by the browser for good (the name never changes). **Download as JSON** puts them back inline, so the file works anywhere. Pictures made by **Meshy** or **fal** arrive as links to their servers, which expire (Meshy's within days), so they're copied into R2 the same way when the production saves, or when it's opened (`POST /api/images/copy {url}`, from `assets.meshy.ai` and fal's file hosts only, raster pictures only); a link that has already expired is left as it is. SVG drawings stay inline. Browser-only mode keeps everything in the browser as before. Deleting a production leaves its pictures in R2 (another production may use them).

**AI generation.** Each person adds their own keys (account menu → **AI service keys…**), kept in their browser and sent only to that service, which bills them directly. **✨ Generate** in picture fields offers **Meshy** or **fal** (Nano Banana 2 / Pro), with the card's reference pictures. **🎬 Generate clip** on a shot's clip field uses **fal** (Seedance 2.0, 2.0 Fast, 2.0 Mini or 2.5, Kling O3, Veo 3.1, Wan 2.6 or MiniMax H3): it starts from the shot's own Seedance export (prompt, reference pictures as @Image1…, length, aspect ratio, and the previous clip's last frame when the shot continues), then keeps the clip's link and its last frame on the shot. Dreamina has no public API; use its CLI or the Seedance export for it.

## Tests

```sh
npm test            # builds, starts the Worker with a throwaway local D1, runs the API tests
npm run typecheck
```

## mobile-nodemap version

`package.json` installs the library from GitHub (`github:joranbeasley/mobile-nodemap#main`); npm builds it on install. `package-lock.json` pins the exact commit: run `npm i github:joranbeasley/mobile-nodemap#main` to move to the library's latest `main`.

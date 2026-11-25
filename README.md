# Drama Club

Plan productions on your phone: cast and costumes, locations, props, shots, scenes and episodes, as tabs of linked cards, with pictures, shot lists and Seedance video scripts. It is the **Drama boards** map from [mobile-nodemap](https://github.com/joranbeasley/mobile-nodemap) (`drama2Graph`) as a standalone app, with **Sign in with Google** and productions kept in **Postgres**.

## Run it locally

Needs Node 22.18+ and Postgres 14+ (or Docker).

```sh
npm install                 # also builds mobile-nodemap from GitHub
docker compose up -d db     # or use your own Postgres
cp .env.example .env        # DEV_LOGIN=1 is on: sign in with any email, no Google needed
npm run dev                 # http://localhost:3000, rebuilds the client and restarts the server on change
```

The server applies database migrations (`db/migrations/*.sql`) when it starts; `npm run migrate` does it on its own.

## Without a server: GitHub Pages and browser storage

The app also runs as plain static files. When there is no Drama Club server behind the page (GitHub Pages, any static host), or someone taps **Continue without an account** on the sign-in screen, productions are kept in that browser (IndexedDB, which has room for pictures, unlike `localStorage`'s ~5 MB). Everything works the same (autosave, the example, JSON export and import, the two-tab conflict check), but nothing leaves the device: use **Download as JSON** to back up or move a production, and **Import JSON** to bring it into a signed-in account later.

`.github/workflows/pages.yml` builds `public/` on every push and publishes the default branch to Pages. To turn it on: **Settings → Pages → Build and deployment → Source: GitHub Actions**, then re-run the workflow (or push). The site is `https://<owner>.github.io/drama-club/`. Productions open as `?p=<id>`.

## Google sign-in

1. In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** of type **Web application**.
2. Under **Authorized JavaScript origins** add every origin you serve from, e.g. `http://localhost:3000` and `https://dramaclub.example.org`. No redirect URIs are needed.
3. Put the client id in `GOOGLE_CLIENT_ID`, and remove `DEV_LOGIN`.
4. Optionally limit who can get in: `ALLOWED_EMAILS=ana@gmail.com,ben@gmail.com` and/or `ALLOWED_DOMAINS=ourschool.org`.

How it works: the page shows Google's button (Google Identity Services). Google hands the browser a signed ID token, which the page posts to `/api/auth/google`. The server verifies it with `google-auth-library` (signature, audience, expiry, verified email), upserts the user and starts a session: an `httpOnly`, `SameSite=Lax` cookie holding a random token, of which only the SHA-256 is stored in `sessions`. No Google client secret is involved.

## Configuration

| Variable | | |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection string |
| `GOOGLE_CLIENT_ID` | required unless `DEV_LOGIN=1` | OAuth web client id |
| `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` | empty: anyone | Comma-separated allow lists |
| `DEV_LOGIN` | off | `1`: email-only sign-in for development. Ignored when `NODE_ENV=production` |
| `NODE_ENV` | | `production`: secure cookies, trusts one proxy hop (`X-Forwarded-*`) |
| `PORT` | `3000` | |
| `SESSION_DAYS` | `30` | |
| `MAX_BODY` | `20mb` | Largest production accepted. Pictures are stored inside it as compressed data URLs |

## Deploying

`docker build .` produces a runnable image (`node server/index.ts`, port 3000). Serve it over HTTPS with `NODE_ENV=production`, a `DATABASE_URL` and a `GOOGLE_CLIENT_ID` whose authorized origins include your domain.

## How it fits together

```
client/        browser app, bundled with esbuild into public/app.js
  main.ts      sign-in, production picker, the NodeEditor (drama2Graph), autosave
  api.ts       fetch wrapper
public/        index.html, app.css (and the built app.js)
server/        Express 5 on Node's built-in TypeScript support (no build step)
  app.ts       routes, security headers, errors
  auth.ts      Google ID token check, sessions, /api/me, logout
  productions.ts  CRUD with optimistic concurrency
  db.ts        pg pool and the migration runner
db/migrations/ SQL, applied in order once each
test/          API tests against a real Postgres
```

**API** (all JSON, all under `/api`): `GET /config`, `GET /me`, `POST /auth/google {credential}`, `POST /auth/logout`, `GET /productions`, `POST /productions {title, graph?}`, `GET|PUT|DELETE /productions/:id`. A production's `graph` is mobile-nodemap `GraphJSON` (type `drama2`).

**Saving.** Edits save automatically after a short pause. Each save sends the `version` it was based on; if the production was saved elsewhere since (another tab or phone), the server answers `409` and the app offers **Load theirs** or **Keep mine**. Offline saves retry with back-off, and closing the tab with unsaved changes asks first.

**Browser-only mode.** `client/store.ts` has two stores behind one interface: `serverStore` (the API) and `localStore` (IndexedDB), chosen at start-up by probing `api/health`.

**Image generation.** Picture fields can generate images with Meshy using each user's own API key (account menu → Image generation key), kept in their browser and sent only to Meshy.

## Tests

```sh
TEST_DATABASE_URL=postgres://dramaclub:dramaclub@localhost:5432/dramaclub_test npm test   # wipes that database
npm run typecheck
```

## mobile-nodemap version

`package.json` installs the library from GitHub. It currently points at the `ccr-2e2febf3-1a89e5` branch, which adds the `prepare` script that lets npm build it on install; switch it to `#main` once that is merged (`npm i github:joranbeasley/mobile-nodemap`).

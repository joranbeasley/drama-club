// Finds the "dramaclub" D1 database in your Cloudflare account (creating it the first time) and
// writes its id into wrangler.jsonc, and makes sure the "dramaclub-media" R2 bucket exists, so
// deploying needs no manual setup beyond an API token (with D1 and R2 edit rights).
// Uses CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID like wrangler itself.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NAME = 'dramaclub';
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const find = () => JSON.parse(wrangler('d1', 'list', '--json')).find((d) => d.name === NAME);

let db = find();
if (!db) {
  console.log(`Creating D1 database "${NAME}"…`);
  wrangler('d1', 'create', NAME);
  db = find();
}
if (!db?.uuid) throw new Error(`Could not find or create the D1 database "${NAME}"`);

const file = 'wrangler.jsonc';
const config = readFileSync(file, 'utf8');
const next = config.replace(/("database_name":\s*"dramaclub",[\s\S]*?"database_id":\s*")[^"]*(")/, `$1${db.uuid}$2`);
if (next === config && !config.includes(db.uuid)) throw new Error(`Could not set database_id in ${file}`);
writeFileSync(file, next);
console.log(`D1 "${NAME}" is ${db.uuid}`);

// R2: create the bucket the first time ("already exists" afterwards is fine).
const BUCKET = 'dramaclub-media';
const made = spawnSync('npx', ['wrangler', 'r2', 'bucket', 'create', BUCKET], { encoding: 'utf8' });
const said = `${made.stdout}\n${made.stderr}`;
if (made.status === 0) console.log(`Created R2 bucket "${BUCKET}"`);
else if (/already exists|10004/i.test(said)) console.log(`R2 bucket "${BUCKET}" is there`);
else {
  console.error(said);
  throw new Error(
    /auth|permission|10000|403/i.test(said)
      ? `Could not create the R2 bucket "${BUCKET}": the API token needs "Workers R2 Storage: Edit" (and R2 must be enabled on the account).`
      : `Could not create the R2 bucket "${BUCKET}"`,
  );
}

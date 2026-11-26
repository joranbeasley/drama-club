// Finds the "dramaclub" D1 database in your Cloudflare account (creating it the first time) and
// writes its id into wrangler.jsonc, so deploying needs no manual setup beyond an API token.
// Uses CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID like wrangler itself.
import { execFileSync } from 'node:child_process';
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

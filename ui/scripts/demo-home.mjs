// Builds the clean demo home Toil UI and the toil CLI are recorded in:
//
//   node ui/scripts/demo-home.mjs                 # ~/toil-demo-home
//   node ui/scripts/demo-home.mjs --fresh         # delete it and build it again
//   node ui/scripts/demo-home.mjs --launch        # then start Toil UI in it
//   node ui/scripts/demo-home.mjs --home <dir>
//
// In <home> it writes:
//   - .toil/config.json: the demo's connections only (DEMO_CONNECTIONS, below),
//     copied from your ~/.toil/config.json with writes turned off on each, so no
//     other connection of yours (a work host) appears on camera. Secrets in it are
//     keychain: references only, so the tokens stay in the OS credential store; a
//     plaintext one stops the run. It adds a `github` connection with no token and
//     a `ledger` SQLite one.
//   - ledger.db: a made-up ledger of 6 merchants, 60 settlements and 12
//     chargebacks, built with node:sqlite: the same rows every time, dated
//     relative to today.
//   - .toil-demo-home, a marker: --fresh deletes a folder only when it carries it.
// toil runs in the home with every TOIL_* variable of your shell removed, so none
// can turn writes back on or pick another toil project. --launch starts Toil UI
// the same way, with HOME and USERPROFILE both set (Windows goes by the second)
// and the GitHub token read from `gh auth token` into that one process: run it
// yourself, since it hands a token over. Nothing is printed or written.
//   - the toil project `payments-team`, made with toil's own projects commands,
//     tying Jira SCRUM, GitHub imagile-dev/toil-sandbox, Azure DevOps "Toil
//     Sandbox" and the ledger together.
// Repo tooling only: nothing here ships. A clean desk, set up for the camera,
// as is traditional.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { npmCli } from './package-rules.mjs';

/** The connections the demo uses; nothing else of yours is copied. */
export const DEMO_CONNECTIONS = ['jira', 'confluence', 'ado', 'figma', 'payments-db'];
const MARKER = '.toil-demo-home';

const args = process.argv.slice(2);
const take = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args.splice(at, 2)[1] : fallback;
};
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? (args.splice(at, 1), true) : false;
};
const home = resolve(take('--home', join(homedir(), 'toil-demo-home')));
const fresh = flag('--fresh');
const launch = flag('--launch');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const toilJs = resolve(take('--toil', join(root, 'dist', 'toil.js')));
if (args.length) fail(`Unknown argument: ${args.join(' ')}`, 'Use --home <dir>, --fresh, --launch and --toil <path>.');
// The demo home is never your home, a folder holding it, or anything in or around this repository.
const fold = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
const inside = (child, parent) => {
  const rel = relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
if (inside(homedir(), home)) fail(`${home} is, or holds, your home folder.`, 'Pick a folder of its own with --home, such as ~/toil-demo-home.');
if (inside(root, home) || inside(home, root)) fail(`${home} is in or around this repository.`, 'Pick a folder outside the repository with --home, such as ~/toil-demo-home.');

function fail(message, fix) {
  process.stderr.write(`demo-home: ${message}\n  Fix: ${fix}\n`);
  process.exit(1);
}
const say = (line) => process.stdout.write(`${line}\n`);

// The marker goes only on a folder this script makes, or one that already carries it,
// so --fresh can never delete a folder of someone's files.
if (existsSync(home) && !existsSync(join(home, MARKER)) && readdirSync(home).length) fail(`${home} already holds files and isn't a demo home this script made (it has no ${MARKER}).`, 'Pick a new or empty folder with --home.');
if (fresh && existsSync(home)) {
  if (!existsSync(join(home, MARKER))) fail(`${home} isn't a demo home this script made (it has no ${MARKER}), so --fresh won't delete it.`, 'Pick another --home, or delete it yourself if you mean to.');
  rmSync(home, { recursive: true, force: true });
}
mkdirSync(join(home, '.toil'), { recursive: true });
writeFileSync(join(home, MARKER), 'Made by ui/scripts/demo-home.mjs. --fresh deletes this folder.\n');
// macOS's `security` finds the login keychain under $HOME/Library, so a home with
// another HOME needs the real Keychains folder linked in, or every keychain:
// reference reads as missing. Windows and Linux stores don't go by HOME.
if (process.platform === 'darwin') {
  const link = join(home, 'Library', 'Keychains');
  let isLink = false;
  try {
    isLink = lstatSync(link).isSymbolicLink();
  } catch {
    // nothing there yet
  }
  if (isLink && !existsSync(link)) rmSync(link); // a dangling link from a moved home
  if (!existsSync(link)) {
    mkdirSync(join(home, 'Library'), { recursive: true });
    symlinkSync(join(homedir(), 'Library', 'Keychains'), link);
  }
}

// Config: a copy with writes off, keychain references only ------------------------------
const realConfig = join(homedir(), '.toil', 'config.json');
if (!existsSync(realConfig)) fail(`There is no ${realConfig}.`, 'Add the jira and ado connections first (.claude/skills/sandboxes/demo-reset.md).');
const mine = JSON.parse(readFileSync(realConfig, 'utf8'));
const config = { version: mine.version ?? 2, connections: {}, defaults: {} };
// Any key that names a secret: a value there must be a keychain: reference. `<key>From` names a connection.
const SECRET_KEY = /token|key|pass|secret|connectionstring|code/i;
for (const name of DEMO_CONNECTIONS) {
  const conn = mine.connections?.[name];
  if (!conn) continue;
  for (const [key, value] of Object.entries(conn)) {
    if (SECRET_KEY.test(key) && !key.endsWith('From') && typeof value === 'string' && !value.startsWith('keychain:')) fail(`Connection ${name} holds a plaintext ${key}.`, `Run toil connections login ${name} so it becomes a keychain: reference.`);
  }
  config.connections[name] = { ...conn, writes: false };
  if (mine.defaults?.[conn.area]) config.defaults[conn.area] = { ...mine.defaults[conn.area], connection: name };
}
config.connections.github ??= { area: 'github', baseUrl: 'https://api.github.com' };
config.connections.github.writes = false;
const ledgerPath = join(home, 'ledger.db');
config.connections.ledger = { area: 'db', engine: 'sqlite', path: ledgerPath.replaceAll('\\', '/'), writes: false };
writeFileSync(join(home, '.toil', 'config.json'), JSON.stringify(config, null, 2) + '\n');
say(`config: ${Object.keys(config.connections).join(', ')} (writes off on all)`);

// The ledger ----------------------------------------------------------------------------
rmSync(ledgerPath, { force: true });
const db = new DatabaseSync(ledgerPath);
db.exec(`
  CREATE TABLE merchants (id INTEGER PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, risk TEXT NOT NULL);
  CREATE TABLE settlements (id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL REFERENCES merchants(id), settled_on TEXT NOT NULL, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL, status TEXT NOT NULL);
  CREATE TABLE chargebacks (id INTEGER PRIMARY KEY, settlement_id INTEGER NOT NULL REFERENCES settlements(id), opened_on TEXT NOT NULL, reason TEXT NOT NULL, amount_minor INTEGER NOT NULL, status TEXT NOT NULL);
`);
let seed = 43;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const merchants = [
  ['Northwind Coffee', 'WA', 'low'], ['Trailhead Outdoor', 'CO', 'low'], ['Paper Crane Stationery', 'OR', 'medium'],
  ['Lumen Games', 'TX', 'high'], ['Harbor Books', 'MA', 'low'], ['Bayou Street Eats', 'LA', 'medium'],
];
const addMerchant = db.prepare('INSERT INTO merchants (id, name, state, risk) VALUES (?, ?, ?, ?)');
merchants.forEach(([name, state, risk], i) => addMerchant.run(i + 1, name, state, risk));
const addSettlement = db.prepare('INSERT INTO settlements (id, merchant_id, settled_on, currency, amount_minor, status) VALUES (?, ?, ?, ?, ?, ?)');
const day = 24 * 60 * 60 * 1000;
for (let i = 1; i <= 60; i++) {
  const m = 1 + Math.floor(rnd() * merchants.length);
  const date = new Date(Date.now() - Math.floor(rnd() * 30) * day).toISOString().slice(0, 10);
  addSettlement.run(i, m, date, 'USD', 5000 + Math.floor(rnd() * 500000), i > 54 ? 'pending' : 'paid');
}
const addChargeback = db.prepare('INSERT INTO chargebacks (id, settlement_id, opened_on, reason, amount_minor, status) VALUES (?, ?, ?, ?, ?, ?)');
for (let i = 1; i <= 12; i++) {
  const date = new Date(Date.now() - Math.floor(rnd() * 20) * day).toISOString().slice(0, 10);
  addChargeback.run(i, 1 + Math.floor(rnd() * 60), date, pick(['fraudulent', 'product_not_received', 'duplicate', 'requested_by_customer']), 1000 + Math.floor(rnd() * 40000), i <= 7 ? 'open' : pick(['won', 'lost']));
}
db.close();
say(`ledger: ${ledgerPath} (6 merchants, 60 settlements, 12 chargebacks)`);

// The toil project ------------------------------------------------------------------------
// Your shell's environment without any TOIL_* variable, with HOME and USERPROFILE on the demo home.
const demoEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TOIL_/i.test(k))), HOME: home, USERPROFILE: home, ...extra });
const toil = (...argv) => {
  const res = spawnSync(process.execPath, [toilJs, ...argv], { encoding: 'utf8', env: demoEnv() });
  try {
    return JSON.parse(res.stdout);
  } catch {
    return fail(`toil ${argv.slice(0, 3).join(' ')} printed no envelope: ${(res.stderr || res.stdout).trim().slice(0, 300)}`, 'Run it by hand.');
  }
};
const must = (env, what) => env.ok || fail(`${what}: ${env.error.message}`, env.error.fix ?? 'Run it by hand.');
const P = 'payments-team';
if (!toil('projects', 'show', P).ok) must(toil('projects', 'init', P, '--description', 'Deliverables Unlimited at Overdraft Federal: Checkout (Jira), Platform (GitHub) and Settlement (Azure DevOps), with the read replica (made-up demo data)'), 'projects init');
must(toil('projects', 'add-repo', P, 'https://github.com/imagile-dev/toil-sandbox', '--name', 'toil-sandbox', '--replace'), 'projects add-repo');
must(toil('projects', 'link', P, 'github', '--connection', 'github', '--set', 'owner=imagile-dev', '--set', 'repo=toil-sandbox', '--replace'), 'projects link github');
if (config.connections.jira) must(toil('projects', 'link', P, 'jira', '--connection', 'jira', '--set', 'project=SCRUM', '--replace'), 'projects link jira');
if (config.connections.ado) must(toil('projects', 'link', P, 'ado', '--connection', 'ado', '--set', 'project=Toil Sandbox', '--replace'), 'projects link ado');
// The Postgres replica (demo-db.mjs) when it's configured, else the SQLite ledger.
must(toil('projects', 'link', P, 'db', '--connection', config.connections['payments-db'] ? 'payments-db' : 'ledger', '--replace'), 'projects link db');
if (config.connections.confluence) must(toil('projects', 'link', P, 'confluence', '--connection', 'confluence', '--set', 'space=OD', '--replace'), 'projects link confluence');
if (config.connections.figma) must(toil('projects', 'link', P, 'figma', '--connection', 'figma', '--replace'), 'projects link figma');
const check = toil('projects', 'check', P);
say(`toil project ${P}: ${check.ok && check.data?.ok !== false ? 'checks out' : `check says ${JSON.stringify(check.data?.problems ?? check.error)}`}`);
say(`demo home ready: ${home}`);

// Toil UI in the demo home ------------------------------------------------------------------
if (launch) {
  // gh reads its login with your real environment; the token goes only to Toil UI's process.
  const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (token.status !== 0 || !token.stdout.trim()) fail("couldn't read a GitHub token from gh.", 'Sign in with gh auth login, then run this again.');
  say('starting Toil UI in the demo home (Ctrl+C to stop)');
  const ui = spawnSync(process.execPath, [npmCli(), 'exec', '--yes', '--', '@imagile-dev/toil-ui'], { stdio: 'inherit', env: demoEnv({ TOIL_GITHUB_TOKEN: token.stdout.trim() }) });
  process.exit(ui.status ?? 1);
}

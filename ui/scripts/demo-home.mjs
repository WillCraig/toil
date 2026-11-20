// Builds the clean demo home Toil UI and the toil CLI are recorded in:
//
//   node ui/scripts/demo-home.mjs                 # ~/toil-demo-home
//   node ui/scripts/demo-home.mjs --fresh         # delete it and build it again
//   node ui/scripts/demo-home.mjs --launch        # then start Toil UI in it
//   node ui/scripts/demo-home.mjs --home <dir>
//   node ui/scripts/demo-home.mjs --people-only   # only map the demo's people in an existing home
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
// can turn writes back on or pick another toil project. --launch starts this
// checkout's Toil UI (ui/dist, so run npm run build -w ui first) on toil built from
// this checkout into .scratch/toil, as dev-real.mjs does, so the two always match
// (the published toil may lack a field the checkout's UI sends). It runs with HOME
// and USERPROFILE both set (Windows goes by the second) and the GitHub token read
// from `gh auth token` into that one process: run it yourself, since it hands a
// token over. Nothing is printed or written.
//   - the toil project `payments-team`, made with toil's own projects commands,
//     tying Jira SCRUM, GitHub imagile-dev/toil-sandbox, Azure DevOps "Toil
//     Sandbox" and the ledger together, with the ticket rules gherkin,
//     user-story and bug-repro (a warning, not a stop, on a toil without them).
//   - payments-team's people: the one person the demo story names, Sam Rivera
//     (demo-story.md), with the Jira, GitHub and Azure DevOps accounts the seeded
//     items are assigned to, read with toil at run time (the seeds assign only the
//     tokens' identity), so one person never shows as three unmapped accounts. No
//     account id is written in this repository. --people-only does this step alone,
//     on a home built before, and leaves its config (writes included) as it is.
// Repo tooling only: nothing here ships. A clean desk, set up for the camera,
// as is traditional.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildToil, RealHomeError, toilCli, toilUi, toilUiNodeArgs } from './real-home.mjs';

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
const peopleOnly = flag('--people-only');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const toilFlag = take('--toil');
let toilJs = resolve(toilFlag ?? join(root, 'dist', 'toil.js'));
if (args.length) fail(`Unknown argument: ${args.join(' ')}`, 'Use --home <dir>, --fresh, --launch, --people-only and --toil <path>.');
if (peopleOnly && (fresh || launch)) fail("--people-only can't be used with --fresh or --launch.", 'Run --people-only on its own, on a demo home built before.');
if (launch && toilFlag) fail("--toil and --launch can't be used together.", '--launch builds toil from this checkout itself; leave out --toil.');
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

// Your shell's environment without any TOIL_* variable, with HOME and USERPROFILE on the demo home.
const demoEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TOIL_/i.test(k))), HOME: home, USERPROFILE: home, ...extra });
// toil in the demo home; `extra` adds env for one call, `input` is its stdin (a read's envelope can outgrow a Windows command line).
const runToil = (extra = {}, input = undefined) => (...argv) => {
  const res = spawnSync(process.execPath, [toilJs, ...argv], { encoding: 'utf8', cwd: home, env: demoEnv(extra), maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  try {
    return JSON.parse(res.stdout);
  } catch {
    return fail(`toil ${argv.slice(0, 3).join(' ')} printed no envelope: ${(res.stderr || res.stdout).trim().slice(0, 300)}`, 'Run it by hand.');
  }
};
const toil = Object.assign(runToil(), { withEnv: (extra) => runToil(extra), withInput: (input) => runToil({}, input) });
const must = (env, what) => env.ok || fail(`${what}: ${env.error.message}`, env.error.fix ?? 'Run it by hand.');
const P = 'payments-team';

// The demo's people ------------------------------------------------------------------------
/** The one person the demo story names (demo-story.md): every seeded item is assigned to the tokens' identity, which plays this one person. */
export const DEMO_PERSON = 'Sam Rivera';
const PEOPLE_READ_LIMIT = 50;

/**
 * Maps the accounts the seeded items are assigned to onto DEMO_PERSON, read with toil and toil's own OWI mapping at run
 * time, so the ids match what Toil UI reads and none is written in this repository. An area it can't read is a warning,
 * never a stop. Nothing is printed but the areas mapped.
 */
function mapPeople(connections) {
  /** The OWI accounts (assignee and reporter) in one read's envelope, most frequent first. */
  const accountsOf = (envelope, what) => {
    if (!envelope.ok) return say(`warning: couldn't read ${what} to map the demo's people: ${envelope.error.message}`), [];
    const mapped = toil.withInput(JSON.stringify(envelope))('util', 'owi', 'map', '--input-file', '-');
    if (!mapped.ok) return say(`warning: couldn't map ${what} to OWI to find the demo's people: ${mapped.error.message}`), [];
    const counts = new Map();
    for (const item of mapped.data?.items ?? []) for (const who of [item.assignee, item.reporter]) if (who?.id) counts.set(who.id, (counts.get(who.id) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  };
  const ids = {};
  if (connections.jira) ids.jira = accountsOf(toil('jira', 'issue', 'search', '--toil-project', P, '--jql', 'project = SCRUM AND labels = toil-seed ORDER BY key', '--limit', String(PEOPLE_READ_LIMIT)), 'Jira SCRUM');
  if (connections.ado) {
    const found = toil('ado', 'work-item', 'search', '--toil-project', P, '--wiql', "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Toil Sandbox' AND [System.Tags] CONTAINS 'toil-seed' ORDER BY [System.Id]", '--limit', String(PEOPLE_READ_LIMIT));
    const numbers = found.ok ? (found.data?.workItems ?? []).map((w) => String(w.id)) : [];
    if (!found.ok) say(`warning: couldn't search Azure DevOps Toil Sandbox to map the demo's people: ${found.error.message}`);
    else if (numbers.length) ids.ado = accountsOf(toil('ado', 'work-item', 'get-many', '--toil-project', P, ...numbers, '--fields', 'System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo,System.CreatedBy,System.TeamProject'), 'Azure DevOps Toil Sandbox');
  }
  // The GitHub repository is seeded as a whole, so any issue in it counts (the sandboxes skill).
  if (connections.github) {
    // The home's github connection holds no token (--launch hands gh's to Toil UI), so this one read gets gh's, as --launch does.
    const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
    if (token.status !== 0 || !token.stdout.trim()) say("warning: couldn't read a GitHub token from gh, so the demo's GitHub account isn't mapped. Sign in with gh auth login and run --people-only.");
    else ids.github = accountsOf(toil.withEnv({ TOIL_GITHUB_TOKEN: token.stdout.trim() })('github', 'issue', 'list', '--toil-project', P, '--state', 'all', '--limit', String(PEOPLE_READ_LIMIT)), 'GitHub toil-sandbox');
  }
  const flags = Object.entries(ids).flatMap(([area, found]) => {
    if (found.length > 1) say(`warning: the seeded ${area} items name ${found.length} accounts; ${DEMO_PERSON} takes the one most of them are assigned to.`);
    return found.length ? [`--${area}`, found[0]] : [];
  });
  if (!flags.length) return say(`warning: no seeded item named an account, so ${P} has no people.`);
  must(toil('projects', 'person', P, DEMO_PERSON, ...flags, '--replace'), 'projects person');
  say(`toil project ${P}: ${DEMO_PERSON} mapped to the ${Object.keys(ids).filter((a) => ids[a].length).join(', ')} accounts the seeded items name`);
}

// With --launch the home is built, and Toil UI then runs, on one toil: this checkout's,
// built into .scratch/toil, so the toil project it writes is the one Toil UI reads.
let built;
if (launch) {
  if (!existsSync(toilUi)) fail(`${toilUi} isn't built.`, 'Run npm run build -w ui first.');
  try {
    built = buildToil();
  } catch (e) {
    if (e instanceof RealHomeError) fail(e.message, e.fix);
    throw e;
  }
  toilJs = toilCli;
}

// --people-only: the people step alone, on a home this script built, with its config (writes included) as it stands.
if (peopleOnly) {
  if (!existsSync(join(home, MARKER)) || !existsSync(join(home, '.toil', 'config.json'))) fail(`${home} isn't a demo home this script built.`, 'Build it first: node ui/scripts/demo-home.mjs.');
  if (!toil('projects', 'show', P).ok) fail(`${home} has no toil project ${P}.`, 'Build it first: node ui/scripts/demo-home.mjs.');
  mapPeople(JSON.parse(readFileSync(join(home, '.toil', 'config.json'), 'utf8')).connections ?? {});
  process.exit(0);
}

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
if (!toil('projects', 'show', P).ok) must(toil('projects', 'init', P, '--description', 'Deliverables Unlimited at Overdraft Federal: Checkout (Jira), Platform (GitHub) and Settlement (Azure DevOps), with the read replica (made-up demo data)'), 'projects init');
must(toil('projects', 'add-repo', P, 'https://github.com/imagile-dev/toil-sandbox', '--name', 'toil-sandbox', '--replace'), 'projects add-repo');
must(toil('projects', 'link', P, 'github', '--connection', 'github', '--set', 'owner=imagile-dev', '--set', 'repo=toil-sandbox', '--replace'), 'projects link github');
if (config.connections.jira) must(toil('projects', 'link', P, 'jira', '--connection', 'jira', '--set', 'project=SCRUM', '--replace'), 'projects link jira');
// Which Jira fields hold story points and the sprint (the sandbox site's ids, Jira Cloud's usual ones), or
// Toil UI reads neither and a chain of estimated stories shows no points.
if (config.connections.jira) {
  must(toil('projects', 'field', P, 'jira', 'estimate', 'customfield_10016', '--replace'), 'projects field estimate');
  must(toil('projects', 'field', P, 'jira', 'iteration', 'customfield_10020', '--replace'), 'projects field iteration');
  // Jira numbers custom fields per site, so read them back from a seeded story: a
  // wrong id would leave Toil UI with no points and no word of why.
  const probe = toil('jira', 'issue', 'get', 'SCRUM-14', '--select', '{points: fields.customfield_10016, sprint: fields.customfield_10020[0].name}');
  if (!probe.ok) say(`warning: couldn't read SCRUM-14 to check the Jira field ids: ${probe.error.message}`);
  else if (typeof probe.data?.points !== 'number' || !probe.data?.sprint) say('warning: SCRUM-14 has no story points in customfield_10016 or no sprint in customfield_10020; find this site\'s ids with toil jira issue fields --discover --custom-only and set them with toil projects field.');
}
// The repository too, or Toil UI has no ADO repository to read code reviews from.
if (config.connections.ado) must(toil('projects', 'link', P, 'ado', '--connection', 'ado', '--set', 'project=Toil Sandbox', '--set', 'repo=settlement-service', '--replace'), 'projects link ado');
// The Postgres replica (demo-db.mjs) when it's configured, else the SQLite ledger.
must(toil('projects', 'link', P, 'db', '--connection', config.connections['payments-db'] ? 'payments-db' : 'ledger', '--replace'), 'projects link db');
if (config.connections.confluence) must(toil('projects', 'link', P, 'confluence', '--connection', 'confluence', '--set', 'space=OD', '--replace'), 'projects link confluence');
if (config.connections.figma) must(toil('projects', 'link', P, 'figma', '--connection', 'figma', '--replace'), 'projects link figma');
// Ticket rules (#657): the three built-in rule sets, which the seeded stories and bugs
// were written to (demo-week-data.mjs). A toil from before `projects standards set`
// says so and the home is built without them: a missing rule set is a warning on
// camera prep, not a reason to stop.
const rules = toil('projects', 'standards', 'set', P, '--use', 'gherkin', '--use', 'user-story', '--use', 'bug-repro', '--replace');
if (rules.ok) say(`toil project ${P}: ticket rules gherkin, user-story and bug-repro`);
else if (/unknown command/i.test(rules.error?.message ?? '')) say(`warning: ${toilJs} has no \`projects standards set\` yet (#657), so ${P} has no ticket rules. Build toil from a checkout that has it and run this again.`);
else say(`warning: couldn't set ${P}'s ticket rules: ${rules.error?.message}${rules.error?.fix ? ` (${rules.error.fix})` : ''}`);
mapPeople(config.connections);
const check = toil('projects', 'check', P);
say(`toil project ${P}: ${check.ok && check.data?.ok !== false ? 'checks out' : `check says ${JSON.stringify(check.data?.problems ?? check.error)}`}`);
say(`demo home ready: ${home}`);

// Toil UI in the demo home ------------------------------------------------------------------
if (launch) {
  // gh reads its login with your real environment; the token goes only to Toil UI's process.
  const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (token.status !== 0 || !token.stdout.trim()) fail("couldn't read a GitHub token from gh.", 'Sign in with gh auth login, then run this again.');
  say(`starting Toil UI in the demo home on ${built.describe} (Ctrl+C to stop)`);
  // Codex keeps its sign-in under CODEX_HOME (default ~/.codex), which the demo HOME hides; point it at the real one,
  // the way the Keychains link does for Claude, so Ask and Fix with AI agent can run on camera. Nothing is copied.
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const agentEnv = existsSync(codexHome) ? { CODEX_HOME: codexHome } : {};
  const ui = spawnSync(process.execPath, [...toilUiNodeArgs, toilUi], { stdio: 'inherit', env: demoEnv({ TOIL_GITHUB_TOKEN: token.stdout.trim(), ...agentEnv }) });
  process.exit(ui.status ?? 1);
}

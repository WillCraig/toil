// Installs both tarballs the way a locked-down user would (npm, scripts off,
// no registry) into a throwaway prefix, then drives the installed toil-ui bin:
// it prints its launch URL once, refuses a foreign Host and a missing token,
// trades the token for a session id (a header, never a cookie), serves the app,
// answers the API with the session id and the CSRF token and refuses it without
// them, and reads through the installed toil with no sample data at all. Run
// after `npm run build` at the root (toil's tarball) and in ui/ (its own).
// Stops every process it starts.
// Then it opens every view of the sample app in every theme in headless Chrome
// and holds the layout to scripts/layout-check.mjs.
// The tour of the building now takes in every floor, in every livery.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOTION_ROUTES, WIDTHS, checkLayout, themeRuns } from './layout-check.mjs';
import { npmCli } from './package-rules.mjs';

const ui = join(import.meta.dirname, '..');
const repo = join(ui, '..');
const work = mkdtempSync(join(tmpdir(), 'toil-ui-smoke-'));
const home = join(work, 'home');
const env = { ...process.env, HOME: home, USERPROFILE: home, TOIL_UI_DATA_DIR: join(work, 'data') };
for (const key of Object.keys(env)) if (/^TOIL_(CONN_|TOIL_PROJECT)/.test(key)) delete env[key];
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: 'utf8', env });
const steps = [];
const problems = [];
const check = (ok, message) => (ok ? null : problems.push(message));

function send(origin, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers: { host: url.host, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Starts the installed bin and resolves with its printed launch URL. */
function launch(bin, args) {
  const child = spawn(process.execPath, [bin, '--port', '0', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`toil-ui printed no URL in 15s. stdout: ${out} stderr: ${err}`)), 15000);
    child.stdout.on('data', (c) => {
      out += c;
      const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.stderr.on('data', (c) => (err += c));
    child.on('exit', (code) => reject(new Error(`toil-ui exited ${code} before printing a URL. stderr: ${err}`)));
  });
  return { child, url, output: () => out, errors: () => err };
}

/** Signs in as the page does: the launch token in the URL for a session id, sent as a header. */
async function signIn(launchUrl) {
  const { origin, searchParams } = new URL(launchUrl);
  const res = await send(origin, '/api/session', { method: 'POST', body: JSON.stringify({ token: searchParams.get('token') }), headers: { origin, 'content-type': 'application/json' } });
  check(res.status === 200 && !res.headers['set-cookie'], `signing in answered ${res.status}${res.headers['set-cookie'] ? ' and set a cookie' : ''}`);
  const session = JSON.parse(res.body);
  const sid = session.session;
  const call = (command, input = {}, headers = {}) =>
    send(origin, '/api/execute', { method: 'POST', body: JSON.stringify({ command, input }), headers: { 'x-toil-ui-session': sid, origin, 'content-type': 'application/json', 'x-toil-ui-csrf': session.csrf, ...headers } });
  return { origin, sid, session, call };
}

const children = [];
try {
  // Both tarballs, from this checkout.
  const toilTgz = join(work, JSON.parse(npm(['pack', '--ignore-scripts', '--pack-destination', work, '--json'], repo))[0].filename);
  const uiTgz = join(work, JSON.parse(npm(['pack', '--ignore-scripts', '--pack-destination', work, '--json'], ui))[0].filename);
  const prefix = join(work, 'install');
  // --offline: toil-ui's one dependency is the toil tarball beside it, so nothing comes from a registry.
  npm(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', toilTgz, uiTgz], work);
  const installed = join(prefix, 'node_modules', '@imagile-dev');
  const bin = join(installed, 'toil-ui', 'dist', 'server', 'toil-ui.js');
  const pinned = JSON.parse(readFileSync(join(installed, 'toil-ui', 'package.json'), 'utf8')).dependencies['@imagile-dev/toil'];
  const toilInstalled = JSON.parse(readFileSync(join(installed, 'toil', 'package.json'), 'utf8')).version;
  check(pinned === toilInstalled, `toil-ui pins toil ${pinned}, but the install holds ${toilInstalled}`);
  check(!existsSync(join(prefix, 'node_modules', 'react')), 'the install holds react; the front end must be built in, not installed');
  steps.push(`installed toil ${toilInstalled} and toil-ui offline with scripts off (no react: the front end is built in)`);

  const version = execFileSync(process.execPath, [bin, '--version'], { env, encoding: 'utf8' }).trim();
  check(version.includes(`(toil ${toilInstalled})`), `toil-ui --version printed ${version}`);

  // Sample data first: the views' calls, end to end.
  const sample = launch(bin, ['--sample']);
  children.push(sample.child);
  const launchUrl = await sample.url;
  const { origin } = new URL(launchUrl);
  check(sample.output().split(launchUrl).length === 2, 'the launch URL was printed more than once');

  const foreign = await send(origin, launchUrl, { headers: { host: 'rebind.imagile.dev' } });
  check(foreign.status === 403 && !foreign.headers['set-cookie'], `a foreign Host got ${foreign.status}`);
  check((await send(origin, '/api/session')).status === 401, 'the API answered without a session');
  const wrong = await send(origin, '/api/session', { method: 'POST', body: JSON.stringify({ token: 'wrong' }), headers: { origin, 'content-type': 'application/json' } });
  check(wrong.status === 401, `a wrong token got ${wrong.status}`);

  const s = await signIn(launchUrl);
  const page = await send(origin, launchUrl);
  check(page.status === 200 && page.body.includes('<div id="root">') && page.body.includes('<title>Toil UI</title>'), `the app page answered ${page.status}`);
  const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(page.body)?.[1];
  const asset = script ? await send(origin, `/${script}`) : { status: 0, headers: {} };
  check(asset.status === 200 && String(asset.headers['content-type']).startsWith('text/javascript'), `the app's script ${script} answered ${asset.status}`);
  // The package's app is the local entry, which reads through the server, not the preview's fixtures.
  check(asset.body.includes('api/session') && !asset.body.includes('The preview has no sample answer'), `the app's script ${script} is the preview's build, not the local app's`);
  check(s.session.store === 'fixture' && s.session.sample === true && s.session.toil.version === toilInstalled, `the session was ${JSON.stringify(s.session)}`);
  const list = JSON.parse((await s.call('projects list')).body);
  check(list.ok && list.data.toilProjects.length === 3, `projects list over the API returned ${JSON.stringify(list).slice(0, 200)}`);
  const refused = await s.call('jira issue create', { project: 'PAY' });
  check(refused.status === 403 && JSON.parse(refused.body).ok === false, `a write command got ${refused.status}`);
  const noCsrf = await s.call('projects list', {}, { 'x-toil-ui-csrf': 'wrong' });
  check(noCsrf.status === 403, `a POST without the CSRF token got ${noCsrf.status}`);
  const onlyCookie = await send(origin, '/api/session', { headers: { cookie: `toil-ui=${s.sid}` } });
  check(onlyCookie.status === 401, `a session id in a cookie, not the header, got ${onlyCookie.status}`);
  const all = [foreign, page, asset, refused, noCsrf];
  check(all.every((r) => !r.headers['set-cookie']), 'a response set a cookie');
  check(all.every((r) => !Object.keys(r.headers).some((h) => h.startsWith('access-control-'))), 'a response carried a CORS header');
  steps.push(`--sample on ${origin}: foreign Host 403, API without a session 401, wrong token 401, token traded for a header session (no cookie), a cookie-only session 401, app and script 200, 3 Toil projects over the API, a write refused, no CSRF 403, no CORS header`);

  // Every view in every theme, at 375, 768 and 1440, in real Chrome (scripts/layout-check.mjs).
  const layout = await checkLayout({
    urlFor: (theme, scheme, route) => `${launchUrl}&theme=${theme}&scheme=${scheme}${route}`,
    log: (line) => process.stderr.write(`  layout: ${line}
`),
  });
  problems.push(...layout.problems);
  for (const r of layout.reported) console.log(`  report-only (decorative theme): ${r}`);
  steps.push(`layout: ${layout.checked} views and states in ${themeRuns().length} theme schemes at ${WIDTHS.join(', ')}px, ${layout.problems.length} problem(s) (no sideways scroll, no overflow outside a declared scroller, nothing past its card, nothing fixed covering the page's end, one-row headers, a full header row at 1440px, a dimming backdrop, a board card dragged with real mouse and touch input that follows the pointer and lands as a ghost in its target column, and no axe violation in Plain or Crate), ${layout.reported.length} report-only axe finding(s) in the decorative themes`);

  // Motion on (#419): the views where the theme moments play, again, with the system allowing motion and Theme motion at full.
  const moving = await checkLayout({
    urlFor: (theme, scheme, route) => `${launchUrl}&theme=${theme}&scheme=${scheme}${route}`,
    routes: MOTION_ROUTES,
    motion: 'no-preference',
    log: (line) => process.stderr.write(`  layout (motion on): ${line}
`),
  });
  problems.push(...moving.problems.map((p) => `motion on: ${p}`));
  for (const r of moving.reported) console.log(`  report-only (decorative theme, motion on): ${r}`);
  steps.push(`layout with motion on: ${moving.checked} views and states (${MOTION_ROUTES.join(', ')}) in ${themeRuns().length} theme schemes at ${WIDTHS.join(', ')}px, the splash, a loading screen and the sprint recap playing, ${moving.problems.length} problem(s), ${moving.reported.length} report-only axe finding(s)`);

  // toil's own execute(), from the installed package, with an empty home, behind the SQLite cache.
  const live = launch(bin, []);
  children.push(live.child);
  const l = await signIn(await live.url);
  check(l.session.store === 'sqlite' && l.session.sync === true && l.session.agent === 'none' && l.session.sample === false, `the live session was ${JSON.stringify(l.session)}`);
  const liveList = JSON.parse((await l.call('projects list')).body);
  check(liveList.ok === true && Array.isArray(liveList.data?.toilProjects) && liveList.meta?.command === 'projects list', `projects list through the installed toil returned ${JSON.stringify(liveList).slice(0, 300)}`);
  const syncHeaders = { 'x-toil-ui-session': l.sid, origin: l.origin, 'content-type': 'application/json', 'x-toil-ui-csrf': l.session.csrf };
  const started = await send(l.origin, '/api/sync', { method: 'POST', body: '{}', headers: syncHeaders });
  check(started.status === 202, `starting a sync answered ${started.status}: ${started.body.slice(0, 200)}`);
  let status = { job: { running: true } };
  for (let i = 0; status.job.running && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    status = JSON.parse((await send(l.origin, '/api/sync', { headers: { 'x-toil-ui-session': l.sid } })).body);
  }
  check(status.job.running === false && status.job.error === null && status.job.toilProjectsTotal === 0, `the sync with no Toil projects ended as ${JSON.stringify(status.job)}`);
  const db = join(work, 'data', 'cache', 'toil-ui.db');
  check(existsSync(db), `the cache wasn't created at ${db}`);
  check(!/ExperimentalWarning|SQLite is an experimental/.test(live.errors()), `toil-ui printed node:sqlite's warning: ${live.errors()}`);
  steps.push(`live on ${l.origin}: projects list through the installed toil's execute() returned ok with ${liveList.data?.toilProjects?.length} Toil projects; a sync ran through the API into ${db}, with no ExperimentalWarning on stderr`);

  // toil-ui wipe refuses while the server holds the data folder's lock, on every OS...
  let refusedWipe = '';
  try {
    execFileSync(process.execPath, [bin, 'wipe'], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    refusedWipe = String(e.stderr);
  }
  check(refusedWipe.includes('Toil UI is running; stop it, or use Wipe in the UI.') && existsSync(db), `toil-ui wipe while the server ran printed ${JSON.stringify(refusedWipe)}`);
  // ...and deletes the cache folder once the server that holds it has stopped.
  live.child.kill();
  await new Promise((r) => live.child.once('exit', r));
  const wiped = execFileSync(process.execPath, [bin, 'wipe'], { env, encoding: 'utf8' });
  check(!existsSync(join(work, 'data', 'cache')) && /Wiped/.test(wiped), `toil-ui wipe left ${join(work, 'data', 'cache')}: ${wiped}`);
  steps.push('toil-ui wipe removed the cache folder');
} catch (e) {
  problems.push(e instanceof Error ? e.message : String(e));
} finally {
  for (const child of children) child.kill();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}

if (problems.length) {
  console.error(`ui smoke found ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`ui smoke ok:\n${steps.map((s) => `  - ${s}`).join('\n')}`);

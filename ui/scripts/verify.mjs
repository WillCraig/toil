// `npm run verify:ui`: one command an agent or a person runs before opening a
// PR that touches Toil UI. It builds Toil UI, and toil from this checkout into
// .scratch/toil, which Toil UI then runs on in place of the published toil it
// pins (#332: real-home.mjs's buildToil, local-toil-hook.mjs), so commands ui/
// calls before their release work here. The report names that toil. Then it
// checks Toil UI two ways:
//
//   1. Sample data. `toil-ui --sample` in a throwaway home, every view through
//      the layout and axe check (scripts/layout-check.mjs) in every theme and
//      scheme at 375, 768 and 1440px. Needs nothing but a browser, so CI can
//      run it. Then the first run (#416): toil-ui on an empty home, whose
//      Toil projects view must show the three-step checklist, through the same check.
//   2. Real data, from a source (`--source github`, the default): the private
//      sandbox imagile-dev/toil-sandbox, in the isolated home dev-real.mjs
//      uses (scripts/real-home.mjs) at <clone>/.scratch/verify/home, made fresh
//      each run, with the token from `gh auth token` in toil-ui's environment
//      only. It syncs the `sandbox` toil project through toil, then runs the same
//      check over the real-data routes (home, the toil project with its Board and Dependencies tabs, its worklog and stand-up, one of its items,
//      and every settings page in the layout check's list). With `--ask` it also asks an agent
//      (Codex unless `--adapter copilot` or `--adapter claude`, on `--model` when given) one starter
//      question, then Analyze as its follow-up, and checks that an answer arrived, that the server verified
//      every [[id]] it cites, that its proposals parsed, that nothing ran (no
//      write in toil's audit log), that the answer names the model asked for, that
//      `codex mcp list` in Toil UI's own Codex home shows only toil_ui (Codex
//      only), and that the answer's usage, as the SDK reported it, is in the
//      usage ledger unchanged (#295). Then the history of analyses (#395): the
//      Analyze kept top-down, the toil project's WIP limit changed in the scratch
//      home, Analyze again, both listed with what changed, and the Analyses tab
//      and the second one opened through the layout check. Without a GitHub sign-in this part is
//      skipped, and the report says so plainly.
//
// In both, the layout problems fail the run in every theme; axe violations
// fail it in Plain and Crate (strict) and are reported for the other themes,
// as the layout check has it. It writes ui/.verify/report.md and viewport
// screenshots of the strict themes to ui/.verify/shots/ (git-ignored), exits 1
// on any problem, and stops every server and browser it started.
//
//   npm run verify:ui                       # from the root or ui/
//   npm run verify:ui -- --ask              # also ask Codex (npm run verify:ui --ask works too)
//   npm run verify:ui -- --ask --adapter copilot --model mai-code-1.1-flash   # or Copilot, or Claude on haiku
//   npm run verify:ui -- --no-build --starter standup
//
// Repo tooling only; nothing here ships. The inspection is self-certified, but
// at least it now arrives with photographs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { findChrome, openBrowser } from './chrome.mjs';
import { FIRST_RUN_ROUTE, ROUTES, WIDTHS, checkLayout, themeRuns } from './layout-check.mjs';
import { npmCli } from './package-rules.mjs';
import { ADAPTERS, RealHomeError, adoProblem, buildToil, githubToken, sdkInstall, sdkInstalled, prepareAdoHome, prepareRealHome, realHomeEnv, root, toilIn, toilUi, toilUiNodeArgs } from './real-home.mjs';

const ui = join(root, 'ui');
const out = join(ui, '.verify');

// Flags after `--`, or npm's own config form (`npm run verify:ui --ask` sets npm_config_ask).
const args = process.argv.slice(2);
const npmFlag = (name) => process.env[`npm_config_${name.replace(/-/g, '_')}`];
const has = (name) => args.includes(`--${name}`) || npmFlag(name) === 'true';
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  if (at >= 0) return args[at + 1];
  const fromNpm = npmFlag(name);
  return fromNpm && fromNpm !== 'true' ? fromNpm : fallback;
};
const valued = ['--source', '--starter', '--project', '--adapter', '--model'];
const known = new Set(['--ask', '--no-build', ...valued]);
const unknown = args.filter((a, i) => a.startsWith('--') && !known.has(a) && !valued.includes(args[i - 1]));
if (unknown.length) {
  process.stderr.write(`verify:ui: unknown argument ${unknown.join(' ')}\n  Fix: use --ask, --no-build, --source github|ado, --project <name>, --starter <id>, --adapter codex|copilot|claude and --model <id>; see the comment at the top of ui/scripts/verify.mjs.\n`);
  process.exit(2);
}
const ask = has('ask');
const build = !has('no-build');
const sourceName = value('source', 'github');
const starter = value('starter', 'hygiene');
const project = value('project', process.env.TOIL_ADO_PROJECT);
const adapter = value('adapter', 'codex');
const model = value('model', null) || null;
if (!ADAPTERS[adapter]) {
  process.stderr.write(`verify:ui: --adapter ${adapter} isn't an adapter.\n  Fix: pass --adapter codex, copilot or claude.\n`);
  process.exit(2);
}
const agentLabel = ADAPTERS[adapter].label;
const askStep = `Ask (${agentLabel})`;

/**
 * Where real data comes from. Each source sets up its toil project in the scratch
 * home and hands back toil-ui's environment, or says why it can't (`skip`).
 * Another tracker is one more entry of the same shape: `--source ado` runs
 * the same sync, layout check and Ask against an Azure DevOps Services board
 * (the one ui/scripts/ado-seed/ fills), from TOIL_ADO_BASE_URL,
 * TOIL_ADO_PAT and --project (else TOIL_ADO_PROJECT).
 */
const SOURCES = {
  github: {
    label: 'GitHub, imagile-dev/toil-sandbox',
    setup(home) {
      const gh = githubToken();
      if (!gh.token) return { skip: `${gh.problem}. Sign in with gh auth login, or set TOIL_GITHUB_TOKEN, to run it.` };
      const env = { ...realHomeEnv(home, gh.token), TOIL_UI_DATA_DIR: join(home, '.toil-ui') };
      const toilProject = prepareRealHome({ home, repo: 'imagile-dev/toil-sandbox', self: false, env, log: say });
      return { env, toilProject, detail: `token from ${gh.from}, in toil-ui's environment only` };
    },
  },
  ado: {
    label: 'Azure DevOps Services, ado-board',
    setup(home) {
      const missing = adoProblem(process.env, project);
      if (missing) return { skip: `${missing}.` };
      const env = { ...realHomeEnv(home, null, process.env, { ado: true }), TOIL_UI_DATA_DIR: join(home, '.toil-ui') };
      const toilProject = prepareAdoHome({ home, project, env, log: say });
      return { env, toilProject, detail: "TOIL_ADO_BASE_URL and TOIL_ADO_PAT in toil-ui's environment only" };
    },
  },
};

const steps = [];
const problems = [];
const reported = [];
const say = (line) => process.stderr.write(`verify:ui: ${line}\n`);
/** One line of the report's table. */
const step = (name, result, detail) => {
  steps.push({ name, result, detail });
  say(`${result.toUpperCase()} ${name}: ${detail}`);
};
const children = [];

/** One HTTP call to a running toil-ui, with the Host header it insists on. */
function send(origin, path, { method = 'GET', headers = {}, body, timeoutMs = 60_000 } = {}) {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers: { host: url.host, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text, json: () => JSON.parse(text) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${url.pathname} got no answer in ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    req.end(body);
  });
}

/** Starts the built toil-ui and resolves with its URL and an API client. */
async function launch(argv, env) {
  const child = spawn(process.execPath, [...toilUiNodeArgs, toilUi, '--port', '0', ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  const pageUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`toil-ui printed no URL in 20s. stderr: ${stderr}`)), 20_000);
    child.stdout.on('data', (c) => {
      stdout += c;
      const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.stderr.on('data', (c) => (stderr += c));
    child.on('exit', (code) => reject(new Error(`toil-ui exited ${code} before printing a URL. stderr: ${stderr}`)));
  });
  const { origin } = new URL(pageUrl);
  // What a browser does on opening the address: navigate to the page, and keep the cookie it earns (#561).
  const entered = await send(origin, '/', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } });
  const cookie = String(entered.headers?.['set-cookie'] ?? '').split(';')[0];
  if (!cookie.startsWith('toil-ui=')) throw new Error(`opening toil-ui's page answered ${entered.status} with no cookie`);
  const api = {
    get: (path) => send(origin, `/api/${path}`, { headers: { cookie } }),
    post: (path, body, timeoutMs) => send(origin, `/api/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { cookie, origin, 'content-type': 'application/json' }, timeoutMs }),
  };
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill();
    await new Promise((r) => child.once('exit', r));
  };
  return { pageUrl, origin, api, stop, stderr: () => stderr };
}

/** The layout check over some routes, strict themes shot to `shots`; its problems and findings go into the report. */
async function layout(part, pageUrl, routes) {
  const urlFor = (theme, scheme, route) => `${pageUrl}?theme=${theme}&scheme=${scheme}${route}`;
  const runs = themeRuns();
  const log = (line) => say(`  layout (${part}): ${line}`);
  // A real toil project's name and links may genuinely fill the header's row at 1440px, so only the sample's must fit (#387).
  const headerFits = part !== 'real';
  // The analyses part reads the real toil project, whose Analyze answers are a real agent's: states that need the sample's content are not held to it.
  const sample = part !== 'real' && part !== 'analyses';
  // One call, so the strict and the other schemes share the workers' queue and the pass takes one scheme-length of
  // wall time per worker, not two in a row. Only the strict schemes are shot. Only they fail the run on axe: checkLayout
  // files the others' axe findings under `reported` per scheme, the same split the two calls made.
  const all = await checkLayout({ urlFor, routes, runs, shots: join(out, 'shots', part), shotsFor: (r) => r.strict, log, headerFits, sample });
  const found = all.problems;
  problems.push(...found.map((p) => `${part}: ${p}`));
  reported.push(...all.reported.map((p) => `${part}: ${p}`));
  const checked = all.checked;
  step(`Layout and axe, ${part}`, found.length ? 'fail' : 'pass', `${checked} views and states, ${routes.length} routes in ${runs.length} theme schemes at ${WIDTHS.join(', ')}px: ${found.length} problem(s), ${all.reported.length} report-only axe finding(s) outside Plain and Crate`);
}

/** The toil project page's first work item, as a route, read from the page itself. */
async function firstItemRoute(pageUrl, toilProject) {
  const { page, close } = await openBrowser(findChrome());
  try {
    await page.size(1440);
    await page.goto(`${pageUrl}?theme=plain&scheme=light#/project/${encodeURIComponent(toilProject)}`);
    return await page.evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        // An item's page, or its drawer (#494: the briefing's rows open ?item=), which names the same item.
        const page = [...document.querySelectorAll('a[href*="/item/"]')].map((a) => new URL(a.href).hash).find(Boolean);
        const peek = [...document.querySelectorAll('a[href*="?item="]')].map((a) => new URL(a.href).hash).find(Boolean);
        const link = page ?? (peek ? peek.replace(/\\?item=(.+)$/, '/item/$1') : undefined);
        if (link || Date.now() - started > 15000) resolve(link ?? null);
        else setTimeout(tick, 100);
      };
      tick();
    })`);
  } finally {
    await close();
  }
}

/** Lines of toil's audit log in a home, as objects. */
function auditLines(home) {
  const dir = join(home, '.toil', 'audit');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

/** `codex mcp list --json` names in one Codex home, with the overrides Toil UI passes, run by the CLI Toil UI resolved. */
function codexServers(cli, codexHome) {
  const res = spawnSync(cli, ['mcp', 'list', '--json', '-c', 'mcp_servers={ toil_ui = { url = "http://127.0.0.1:1/api/agent/mcp", bearer_token_env_var = "TOIL_UI_MCP_TOKEN" } }', '--disable', 'plugins', '--disable', 'apps'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) return { problem: res.error?.message ?? res.stderr.trim() };
  return { names: JSON.parse(res.stdout).map((s) => s.name) };
}

/**
 * One question, streamed as the page streams it (#343): every NDJSON line's
 * answer, the last one whole, and the status each partial carried.
 */
async function streamedAsk(api, body) {
  const res = await api.post('agent/ask', { ...body, stream: true }, 15 * 60_000);
  if (res.status !== 200) return { status: res.status, error: res.json().error ?? { message: res.body } };
  const lines = res.body.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const error = lines.find((l) => l.error)?.error;
  const versions = lines.filter((l) => l.answer).map((l) => l.answer);
  return { status: 200, error, versions, answer: versions.at(-1), done: lines.some((l) => l.done) };
}

/**
 * One question to the chosen adapter, held to the four checks the Ask makes,
 * plus the model it named, and for Codex its home's MCP servers. Copilot and
 * Claude are held to the same checks as Codex, the reference (#317, #318).
 */
async function askAgent(api, toilProject, home, dataDir, env, pageUrl) {
  if (!sdkInstalled(adapter)) {
    const install = sdkInstall(adapter);
    problems.push(`Ask: ${ADAPTERS[adapter].package} isn't installed in this clone. Install it with ${install} and run again.`);
    step(askStep, 'fail', `${ADAPTERS[adapter].package} isn't installed: ${install}`);
    return;
  }
  const saved = await api.post('agent/settings', { adapter, model, cliPath: null, endpoint: null, instructions: null, voice: null });
  const chosen = saved.status === 200 ? saved.json().adapters.find((a) => a.name === adapter) : null;
  if (!chosen?.cli.path) {
    problems.push(`Ask: Toil UI can't start ${agentLabel}: ${chosen?.cli.problem ?? saved.body}`);
    step(askStep, 'fail', chosen?.cli.problem ?? `saving the agent settings answered ${saved.status}`);
    return;
  }
  const before = auditLines(home).length;
  const started = Date.now();
  const res = await streamedAsk(api, { toilProject, prompt: starter, theme: 'plain', voice: false, chat: { id: 'verify-ui', turn: 1 } });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (res.status !== 200 || res.error || !res.done) {
    const e = res.error ?? { message: 'the stream ended without done' };
    problems.push(`Ask: ${agentLabel} gave no answer (${res.status}): ${e.message}${e.fix ? ` Fix: ${e.fix}` : ''}`);
    step(askStep, 'fail', `no answer after ${seconds}s: ${e.message}`);
    return;
  }
  const answer = res.answer;
  const fail = (what) => problems.push(`Ask: ${what}`);
  // The status line (#343): what each partial said the agent was doing, as the page shows it.
  const tools = [...new Set(res.versions.filter((v) => v.activity?.phase === 'tool').map((v) => `${v.activity.tool} (${v.activity.source})`))];
  const thinking = res.versions[0]?.activity?.phase === 'thinking';
  const writing = res.versions.some((v) => v.activity?.phase === 'writing');
  if (!thinking || !tools.length || !writing) fail(`the stream's status said thinking ${thinking}, tools ${tools.length}, writing ${writing}; each should show.`);
  // The answer names the model asked for (an alias such as haiku inside the SDK's full id), or the run measured another model's cost (#317).
  if (model && !answer.model?.includes(model)) fail(`the answer names the model ${answer.model ?? 'none'}, not ${model}.`);
  step('Ask: streamed with a live status', thinking && tools.length && writing ? 'pass' : 'fail', `${res.versions.length} versions; thinking, then ${tools.join(', ') || 'no tool'}, then writing; answered by ${answer.adapter} (${answer.model ?? "its CLI's default model"})`);
  const words = answer.parts.map((p) => p.text).join(' ').split(/\s+/).filter(Boolean).length;
  if (!answer.parts.length) fail('the answer has no text.');
  step('Ask: an answer arrived', answer.parts.length ? 'pass' : 'fail', `"${answer.prompt}" answered by ${answer.by} in ${seconds}s: ${answer.parts.length} paragraph(s), ${words} words`);

  const unverified = answer.unverified ?? [];
  if (unverified.length) fail(`the answer names ${unverified.length} id(s) its tools never returned: ${unverified.join(', ')}.`);
  if (!answer.citations.length) fail('the answer cites no work item, so none of it is traced to a source.');
  step('Ask: every [[id]] verified by the server', unverified.length || !answer.citations.length ? 'fail' : 'pass', `${answer.citations.length} cited (${answer.citations.slice(0, 6).join(', ')}${answer.citations.length > 6 ? ', …' : ''}), ${unverified.length} unverified`);

  const dropped = (answer.warnings ?? []).filter((w) => /suggested change was left out|only the first/.test(w));
  const malformed = answer.proposals.filter((p) => !p.item || !p.title);
  for (const w of dropped) fail(w);
  if (malformed.length) fail(`${malformed.length} proposal(s) have no item or title.`);
  const runnable = answer.proposals.filter((p) => p.command);
  step('Ask: proposals parsed', dropped.length || malformed.length ? 'fail' : 'pass', `${answer.proposals.length} proposal(s), ${runnable.length} with a toil command line (${[...new Set(runnable.map((p) => p.command))].join(', ') || 'none'}), ${dropped.length} left out`);

  // Usage (#295): the answer carries what the SDK reported, and the ledger holds exactly that.
  const records = answer.usage?.records ?? [];
  const ledger = (await api.get('usage')).json().records ?? [];
  const stored = records.filter((r) => ledger.some((l) => l.id === r.id && l.inputTokens === r.inputTokens && l.outputTokens === r.outputTokens && l.cachedInputTokens === r.cachedInputTokens));
  const tokened = records.filter((r) => typeof r.inputTokens === 'number' && typeof r.outputTokens === 'number');
  const wrongModel = model ? records.filter((r) => r.model && !r.model.includes(model)) : [];
  if (!tokened.length) fail(`the answer carries no usage with tokens from the ${agentLabel} SDK.`);
  if (wrongModel.length) fail(`${wrongModel.length} usage record(s) name another model: ${[...new Set(wrongModel.map((r) => r.model))].join(', ')}.`);
  if (stored.length !== records.length) fail(`${records.length - stored.length} of the answer's usage record(s) aren't in the ledger as the answer reported them.`);
  // Copilot's premium requests and Claude's SDK estimate (total_cost_usd, per model) are figures of their own.
  const billed = (r) => [r.premiumRequests !== undefined ? `${r.premiumRequests} premium request(s)` : '', r.costUsd !== undefined ? `$${r.costUsd.toFixed(4)} (${r.costSource}${r.plan ? ', API-equivalent' : ''})` : ''].filter(Boolean).join(', ');
  step('Ask: usage recorded', tokened.length && stored.length === records.length && !wrongModel.length ? 'pass' : 'fail', records.map((r) => `${r.inputTokens} in (${r.cachedInputTokens ?? 'not reported'} cached), ${r.outputTokens} out, cache write ${r.cacheWriteTokens ?? 'not reported'}, model ${r.model ?? 'not named by the SDK'}${billed(r) ? `, ${billed(r)}` : ''}`).join('; ') || 'none reported');

  const during = auditLines(home).slice(before);
  const wrote = during.filter((l) => l.writes || l.allowWrite);
  if (wrote.length) fail(`toil's audit log shows ${wrote.length} write(s) during the question: ${wrote.map((l) => l.command).join(', ')}.`);
  const methods = [...new Set(during.flatMap((l) => l.requests.map((r) => r.method)))];
  step('Ask: nothing ran', wrote.length ? 'fail' : 'pass', `${during.length} toil call(s) during the question, ${wrote.length} writing; request methods ${methods.join(', ') || 'none'}; the connection has writes off`);

  if (adapter === 'codex') {
    const theirs = codexServers(chosen.cli.path, process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex'));
    const ours = codexServers(chosen.cli.path, join(dataDir, 'cache', 'codex'));
    const only = ours.names && ours.names.length === 1 && ours.names[0] === 'toil_ui';
    if (!only) fail(`codex mcp list in Toil UI's Codex home shows ${ours.names ? JSON.stringify(ours.names) : `an error: ${ours.problem}`}, not toil_ui alone.`);
    step("Ask: Codex's MCP servers", only ? 'pass' : 'fail', `codex mcp list in Toil UI's Codex home: ${ours.names ? ours.names.join(', ') : ours.problem}; the same overrides in your own Codex home would list ${theirs.names ? theirs.names.length : '?'} server(s)`);
  }

  // Analyze (#343), as the chat's second question, carrying the first: the pulse check, cited.
  const history = [{ prompt: answer.prompt, answer: answer.parts.map((p) => p.text).join('\n\n'), by: answer.by }];
  const pulseStarted = Date.now();
  const pulse = await streamedAsk(api, { toilProject, prompt: 'analyze', theme: 'plain', voice: false, chat: { id: 'verify-ui', turn: 2 }, history });
  const pulseSeconds = Math.round((Date.now() - pulseStarted) / 1000);
  const p = pulse.answer;
  const pulseOk = pulse.status === 200 && !pulse.error && p && (p.parts.length || p.briefing) && p.citations.length && !(p.unverified ?? []).length && p.carried === 1;
  if (!pulseOk) fail(`Analyze: ${pulse.error?.message ?? `${p?.parts.length ?? 0} paragraph(s), ${p?.citations.length ?? 0} cited, ${(p?.unverified ?? []).length} unverified, carried ${p?.carried ?? 0}`}`);
  step('Ask: Analyze, as a follow-up', pulseOk ? 'pass' : 'fail', p ? `${p.briefing ? `a briefing (${p.briefing.reasons.length} reason(s)), ` : ''}${p.parts.length} paragraph(s) in ${pulseSeconds}s, ${p.citations.length} cited, ${(p.unverified ?? []).length} unverified, carried ${p.carried ?? 0} earlier turn; starts: ${p.parts.map((x) => x.text.split(/[:.]/)[0].slice(0, 30)).join(' / ')}` : (pulse.error?.message ?? 'no answer'));
  if (p) await analysisHistory(api, toilProject, home, env, pageUrl, p, [...history, { prompt: p.prompt, answer: p.parts.map((x) => x.text).join('\n\n'), by: p.by }]);
}

/**
 * The history of analyses (#395): the Analyze just asked was kept, read back
 * with its briefing (#494: a recommendation, and its first three reasons as the
 * history's issues); then the toil project's
 * WIP limit changes in the scratch home, Analyze runs again, and the history
 * lists both, newest first, the second saying what changed since the first.
 * The Analyses tab and the second one opened go through the layout check,
 * shot like every other view.
 */
async function analysisHistory(api, toilProject, home, env, pageUrl, first, history) {
  const fail = (what) => problems.push(`Analyses: ${what}`);
  const one = async (id) => {
    const res = id ? await api.get(`analyses/one?toilProject=${encodeURIComponent(toilProject)}&id=${encodeURIComponent(id)}`) : null;
    return res?.status === 200 ? res.json() : null;
  };
  const shapeOf = (r) => (r ? `recommendation ${r.recommendation ? `"${r.recommendation.replace(/\[\[[^\]]*:([^\]]+)\]\]/g, '$1').slice(0, 90)}${r.recommendation.length > 90 ? '…' : ''}"` : 'missing'}, ${r.issues.length} issue(s)${r.issues.length ? ` (${r.issues.map((i) => i.title ?? 'untitled').join(', ')})` : ''}, ${r.citations.length} cited` : 'not kept');
  const kept = await one(first.analysis);
  const topDown = (r) => Boolean(r?.record.recommendation && r.record.briefing) && r.record.issues.length <= 3;
  if (!kept) fail(`the first Analyze wasn't kept: its answer names ${first.analysis ? `analysis ${first.analysis}, which the history doesn't have` : 'no analysis'}.`);
  else if (!topDown(kept)) fail(`the first Analyze isn't top-down: ${shapeOf(kept.record)}.`);
  step('Analyses: the first kept, top-down', topDown(kept) ? 'pass' : 'fail', shapeOf(kept?.record));

  // Something changes between the two: the toil project's WIP limit, in the scratch home, through toil's own command.
  const toil = toilIn(home, env);
  const shown = toil('projects', 'show', toilProject);
  const was = shown.ok ? shown.data?.toilProject?.wipLimit ?? null : null;
  const limit = was === 1 ? 2 : 1;
  const set = toil('projects', 'wip-limit', toilProject, String(limit), '--replace');
  if (!set.ok) fail(`toil projects wip-limit ${toilProject} ${limit} --replace failed: ${set.error.message}`);
  step('Analyses: the Toil project changed between them', set.ok ? 'pass' : 'fail', `toil projects wip-limit ${toilProject} ${limit} --replace, from ${was ?? 'none'}`);

  const started = Date.now();
  const again = await streamedAsk(api, { toilProject, prompt: 'analyze', theme: 'plain', voice: false, chat: { id: 'verify-ui', turn: 3 }, history });
  const seconds = Math.round((Date.now() - started) / 1000);
  const second = await one(again.answer?.analysis);
  if (again.error || !second) fail(`the second Analyze ${again.error ? `failed: ${again.error.message}` : "wasn't kept"}.`);
  else if (!topDown(second)) fail(`the second Analyze isn't top-down: ${shapeOf(second.record)}.`);
  step('Analyses: Analyze again, kept', second && topDown(second) ? 'pass' : 'fail', `in ${seconds}s; ${shapeOf(second?.record)}${(again.answer?.unverified ?? []).length ? `, ${again.answer.unverified.length} unverified` : ''}`);

  const list = (await api.get(`analyses?toilProject=${encodeURIComponent(toilProject)}`)).json();
  const c = Array.isArray(list) ? list[0]?.changes : null;
  const ordered = Array.isArray(list) && list.length >= 2 && list[0].id === second?.record.id && list[1].id === kept?.record.id && c?.previous?.id === kept?.record.id;
  if (!ordered) fail(`the history doesn't list the second analysis first, compared with the first: ${JSON.stringify(Array.isArray(list) ? list.slice(0, 2).map((a) => ({ id: a.id, previous: a.changes.previous?.id ?? null })) : list)}.`);
  const said = c ? [`${c.newlyBlocked.length} newly blocked`, `${c.cleared.length} cleared`, `points moved on ${c.points.length}`, c.sprint ? 'the sprint moved' : 'the sprint the same', `${c.cited.length} newly cited`, `${c.dropped.length} dropped`, c.recommendationChanged ? 'a new recommendation' : 'the same recommendation'].join(', ') : 'nothing to compare';
  step('Analyses: the history and what changed', ordered ? 'pass' : 'fail', `${Array.isArray(list) ? list.length : 0} kept, newest first; since the one before: ${said}`);

  if (second) await layout('analyses', pageUrl, [`#/project/${toilProject}`, `#/project/${toilProject}/analyses`, `#/project/${toilProject}/analyses/${encodeURIComponent(second.record.id)}`]);
}

const startedAt = new Date();
let toilVersion = 'toil ? (it never built)';
let uiVersion = '?';
try {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chrome, Edge or Chromium found. Install one, or set CHROME_PATH to it.');
  step('Browser', 'pass', `${basename(chrome)} at ${chrome}`);

  if (build) {
    const res = spawnSync(process.execPath, [npmCli(), 'run', 'build'], { cwd: ui, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`npm run build in ui/ failed:\n${(res.stdout + res.stderr).trim().split('\n').slice(-20).join('\n')}`);
    step('Build', 'pass', 'npm run build in ui/');
  } else {
    if (!existsSync(toilUi)) throw new Error(`${toilUi} isn't built; run without --no-build.`);
    step('Build', 'skip', '--no-build: the existing ui/dist');
  }

  // Toil UI runs on toil built from this checkout, so ui/ can call commands no release has yet (#332).
  let toil;
  try {
    toil = buildToil({ build });
  } catch (e) {
    if (e instanceof RealHomeError) throw new Error(`${e.message} Fix: ${e.fix}`, { cause: e });
    throw e;
  }
  const version = spawnSync(process.execPath, [...toilUiNodeArgs, toilUi, '--version'], { encoding: 'utf8' });
  const hooked = version.stderr.includes('@imagile-dev/toil/api is toil built from this checkout');
  if (!hooked) problems.push(`toil-ui --version never resolved @imagile-dev/toil/api to the build in .scratch/toil, so every check below would be about another toil: ${version.stderr.trim() || 'nothing on stderr'}`);
  uiVersion = version.stdout.trim().split(' ')[0] || '?';
  toilVersion = toil.describe;
  step('Toil', hooked ? 'pass' : 'fail', `${toil.describe}${toil.built ? '' : ' (--no-build: the existing build)'}; Toil UI imports it through ui/scripts/local-toil-hook.mjs`);

  // The published Toil UI still installs the toil it pins; a wrong lockfile would install another one (#299).
  const lock = spawnSync(process.execPath, [join(ui, 'scripts', 'check-lockfile.mjs')], { encoding: 'utf8' });
  if (lock.status !== 0) problems.push(lock.stderr.trim());
  // Right after a release the check passes with a warning on stderr (the lockfile PR is pending); the row says so.
  const lockSaid = (lock.status === 0 ? lock.stdout || lock.stderr : lock.stderr).trim();
  step('Pinned toil', lock.status === 0 ? 'pass' : 'fail', `${lockSaid.replace(/^(::warning::)?check:lockfile (ok|found|WARNING)[^:]*: ?/, '')} That is what the published package installs; this run uses the build above.`);

  // 1. Sample data, in a throwaway home.
  const work = join(tmpdir(), `toil-ui-verify-${process.pid}`);
  const sampleEnv = { ...process.env, HOME: join(work, 'home'), USERPROFILE: join(work, 'home'), TOIL_UI_DATA_DIR: join(work, 'data') };
  const sample = await launch(['--sample'], sampleEnv);
  try {
    await layout('sample', sample.pageUrl, ROUTES);
  } finally {
    await sample.stop();
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }

  // 1b. The first run (#416): toil-ui on a home with no connections and no toil projects, and no TOIL_* variable from this
  // shell, so it shows the checklist. It reads only toil's own empty config, so it needs no network either.
  const fresh = join(tmpdir(), `toil-ui-verify-first-${process.pid}`);
  const freshEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TOIL_')));
  Object.assign(freshEnv, { HOME: join(fresh, 'home'), USERPROFILE: join(fresh, 'home'), TOIL_UI_DATA_DIR: join(fresh, 'data') });
  const first = await launch([], freshEnv);
  try {
    await layout('first-run', first.pageUrl, [FIRST_RUN_ROUTE]);
  } finally {
    await first.stop();
    rmSync(fresh, { recursive: true, force: true, maxRetries: 5 });
  }

  // 2. Real data.
  const source = SOURCES[sourceName];
  if (!source) throw new Error(`there is no source ${JSON.stringify(sourceName)}; verify:ui knows ${Object.keys(SOURCES).join(', ')}.`);
  const home = join(root, '.scratch', 'verify', 'home');
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  mkdirSync(home, { recursive: true });
  let ready;
  try {
    ready = source.setup(home);
  } catch (e) {
    if (e instanceof RealHomeError) throw new Error(`${e.message} Fix: ${e.fix}`, { cause: e });
    throw e;
  }
  if (ready.skip) {
    step(`Real data (${source.label})`, 'skip', `skipped: ${ready.skip}`);
    if (ask) step(askStep, 'skip', 'skipped with the real data it would read');
  } else {
    step(`Real data (${source.label})`, 'pass', `home ${relative(root, home)}, Toil project ${ready.toilProject}, ${ready.detail}`);
    const real = await launch([], ready.env);
    try {
      const started = await real.api.post('sync', { toilProject: ready.toilProject });
      if (started.status !== 202) throw new Error(`starting the sync answered ${started.status}: ${started.body}`);
      let status;
      const deadline = Date.now() + 10 * 60_000;
      do {
        await new Promise((r) => setTimeout(r, 500));
        status = (await real.api.get('sync')).json();
      } while (status.job.running && Date.now() < deadline);
      const state = status.toilProjects.find((d) => d.name === ready.toilProject);
      const failed = state?.sources.filter((s) => s.status !== 'ok') ?? [];
      const synced = !status.job.running && !status.job.error && state?.status === 'ok';
      if (!synced) problems.push(`sync: ${status.job.running ? 'still running after 10 minutes' : status.job.error ?? `${ready.toilProject} is ${state?.status ?? 'missing'}: ${failed.map((s) => `${s.area}: ${s.error}`).join('; ')}`}`);
      step(`Sync ${ready.toilProject}`, synced ? 'pass' : 'fail', `${status.job.fetched} call(s) to toil, ${status.job.requests} request(s), ${status.job.pages} page(s), ${status.job.retries} retr${status.job.retries === 1 ? 'y' : 'ies'}; ${state?.sources.map((s) => `${s.area} ${s.status}`).join(', ') ?? 'no Toil project state'}`);

      const item = await firstItemRoute(real.pageUrl, ready.toilProject);
      if (!item) problems.push(`real data: the ${ready.toilProject} Toil project page links no work item, so no item view was checked.`);
      // The settings pages come from the layout check's own list, so a page added there is checked on real data too.
      const routes = ['#/', `#/project/${ready.toilProject}`, `#/project/${ready.toilProject}/board`, `#/project/${ready.toilProject}/dependencies`, `#/project/${ready.toilProject}/worklog`, `#/project/${ready.toilProject}/worklog/standup`, ...(item ? [item] : []), ...ROUTES.filter((r) => r.startsWith('#/settings/'))];
      await layout('real', real.pageUrl, routes);

      if (ask) await askAgent(real.api, ready.toilProject, home, ready.env.TOIL_UI_DATA_DIR, ready.env, real.pageUrl);
      else step(askStep, 'skip', `not asked; pass --ask to ask ${agentLabel} one starter question`);
    } finally {
      await real.stop();
      // The scratch home outlives the run; the second name for your Codex sign-in doesn't.
      rmSync(join(ready.env.TOIL_UI_DATA_DIR, 'cache', 'codex', 'auth.json'), { force: true });
    }
  }
} catch (e) {
  problems.push(e instanceof Error ? e.message : String(e));
  step('Run', 'fail', e instanceof Error ? e.message.split('\n')[0] : String(e));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
}

// The report.
const pass = problems.length === 0;
const shots = existsSync(join(out, 'shots')) ? readdirSync(join(out, 'shots'), { recursive: true }).filter((f) => String(f).endsWith('.png')).length : 0;
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const report = [
  '# Toil UI verification',
  '',
  `**${pass ? 'PASS' : `FAIL: ${problems.length} problem(s)`}** in ${Math.round((Date.now() - startedAt.getTime()) / 60_000)} min. ${startedAt.toISOString()}, ${process.platform} ${process.arch}, Node ${process.versions.node}, Toil UI ${uiVersion} on ${toilVersion}. \`npm run verify:ui${[ask ? '--ask' : '', build ? '' : '--no-build', sourceName !== 'github' ? `--source ${sourceName}` : '', starter !== 'hygiene' ? `--starter ${starter}` : '', adapter !== 'codex' ? `--adapter ${adapter}` : '', model ? `--model ${model}` : ''].filter(Boolean).map((a) => ` ${a}`).join('')}\``,
  '',
  '| Step | Result | Detail |',
  '|---|---|---|',
  ...steps.map((s) => `| ${cell(s.name)} | ${s.result} | ${cell(s.detail)} |`),
  '',
  ...(problems.length ? ['## Problems', '', ...problems.map((p) => `- ${cell(p)}`), ''] : []),
  `## Report-only axe findings (${reported.length})`,
  '',
  'Outside Plain and Crate, axe findings are reported and never fail the run (AGENT_DECISIONS.md, #267).',
  '',
  ...(reported.length ? [...reported.slice(0, 40).map((r) => `- ${cell(r)}`), ...(reported.length > 40 ? [`- and ${reported.length - 40} more`] : [])] : ['None.']),
  '',
  `${shots} viewport screenshot(s) of Plain and Crate are in ui/.verify/shots/.`,
  '',
].join('\n');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'report.md'), report);
process.stdout.write(`${report}\nWrote ${join(out, 'report.md')}.\n`);
process.exitCode = pass ? 0 : 1;

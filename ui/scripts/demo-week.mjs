// Turns the seeded sandboxes into "a real team's week" for screen recordings:
// one current sprint across GitHub, Jira and Azure DevOps, a day of movement
// (something done, things in progress, a blocker chain, code reviews waiting on
// review and on checks), and a few small "ready for an agent" items with code
// for the agent to change. Run the seeds first (.claude/skills/sandboxes/demo-reset.md):
//
//   node ui/scripts/demo-week.mjs --sprint "Sprint 44" --ends 2026-11-27
//   node ui/scripts/demo-week.mjs --sprint "Sprint 44" --ends 2026-11-27 --only github,jira
//
// It writes only to the three test projects in CLAUDE.md (SANDBOX in
// demo-week-data.mjs); there is no flag to aim it anywhere else. GitHub goes
// through gh, as seed-sandbox.mjs does (toil's github area has no milestone
// command). The GitHub sandbox repository is seeded as a whole (seed-sandbox.mjs
// made all of it), so its items may be changed; what this script creates there
// carries the label `toil-seed`, and the agent-ready issue is found by it. Jira and
// Azure DevOps go through toil's own commands with --allow-write, so the
// connection's `writes` decides and no token is ever seen here, and only items
// that carry the seed mark are changed. Every step looks first and skips what is
// already done, so it is safe to run again before each recording, and a run puts
// back an agent-ready item a recording closed. Pass a new --sprint and --ends to
// roll the week forward. All of it is made-up work: Deliverables Unlimited's
// engagement at Overdraft Federal, a US bank that does not exist.
// Repo tooling only: nothing here ships. The stand-up was rehearsed, which is
// more than most stand-ups can say.
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ITEMS, DEMO_NOTE, GITHUB_POINTS, SANDBOX, SKELETON } from './demo-week-data.mjs';

const args = process.argv.slice(2);
const take = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args.splice(at, 2)[1] : fallback;
};
const sprint = take('--sprint');
const ends = take('--ends');
const only = take('--only', 'github,jira,ado').split(',');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const toilJs = resolve(take('--toil', resolve(root, 'dist', 'toil.js')));
if (args.length) fail(`Unknown argument: ${args.join(' ')}`, 'Use --sprint, --ends, and optionally --only github,jira,ado and --toil <path to toil.js>.');
if (!sprint || !/^\d{4}-\d{2}-\d{2}$/.test(ends ?? '')) fail('Name the sprint and its last day.', 'node ui/scripts/demo-week.mjs --sprint "Sprint 44" --ends 2026-11-27');

function fail(message, fix) {
  process.stderr.write(`demo-week: ${message}\n  Fix: ${fix}\n`);
  process.exit(1);
}
const say = (line) => process.stdout.write(`${line}\n`);

/** One `gh api` call, the body on stdin, never through a shell. `paginate` reads every page of a list. */
function gh(method, path, body, { allow404 = false, paginate = false } = {}) {
  const argv = ['api', '-X', method, path, ...(paginate ? ['--paginate', '--slurp'] : []), ...(body ? ['--input', '-'] : [])];
  const res = spawnSync('gh', argv, { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) fail(`couldn't run gh: ${res.error.message}`, 'Install the GitHub CLI and sign in with gh auth login.');
  if (res.status !== 0) {
    if (allow404 && /HTTP 404/.test(res.stderr)) return null;
    fail(`gh api ${method} ${path} failed: ${res.stderr.trim() || res.stdout.trim()}`, 'Check gh auth status.');
  }
  const out = res.stdout.trim();
  if (!out) return null;
  const parsed = JSON.parse(out);
  return paginate ? parsed.flat() : parsed;
}

/** One toil call, never through a shell; fails loudly on an error envelope unless asked not to. */
function toil(argv, { soft = false } = {}) {
  if (!existsSync(toilJs)) fail(`There is no toil at ${toilJs}.`, 'Pass --toil <path to toil.js>.');
  const res = spawnSync(process.execPath, [toilJs, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let env;
  try {
    env = JSON.parse(res.stdout);
  } catch {
    fail(`toil ${argv.slice(0, 3).join(' ')} printed no envelope: ${(res.stderr || res.stdout).trim().slice(0, 300)}`, 'Run the same toil command by hand.');
  }
  if (!env.ok && !soft) fail(`toil ${argv.slice(0, 4).join(' ')}: ${env.error.message}`, env.error.fix ?? 'Run the same toil command by hand.');
  return env;
}

// GitHub --------------------------------------------------------------------------------
function github() {
  const { owner, repo } = SANDBOX;
  const R = `repos/${owner}/${repo}`;
  const info = gh('GET', R, null, { allow404: true });
  if (!info) fail(`${owner}/${repo} doesn't exist, or gh can't see it.`, 'Run ui/scripts/seed-sandbox.mjs first.');
  const main = info.default_branch;
  const me = gh('GET', 'user').login;
  say(`GitHub ${owner}/${repo} as ${me}`);

  // The seed mark for what this script creates (seed-sandbox.mjs's own items predate it).
  const labels = gh('GET', `${R}/labels?per_page=100`, null, { paginate: true }).map((l) => l.name);
  if (!labels.includes('toil-seed')) gh('POST', `${R}/labels`, { name: 'toil-seed', color: 'ededed', description: 'Made by a demo seed script' });
  if (!labels.includes('agent-ready')) gh('POST', `${R}/labels`, { name: 'agent-ready', color: '7057ff', description: 'Small and specified: an agent can pick it up' });

  // One current sprint: this one open, every other milestone closed, open sprint work moved onto it.
  const milestones = gh('GET', `${R}/milestones?state=all&per_page=100`, null, { paginate: true });
  let current = milestones.find((m) => m.title === sprint);
  const due = `${ends}T00:00:00Z`;
  if (!current) {
    current = gh('POST', `${R}/milestones`, { title: sprint, due_on: due, description: `The current sprint, ending ${ends}. ${DEMO_NOTE}` });
    say(`  milestone ${sprint}: created, due ${ends}`);
  } else if (current.state !== 'open' || current.due_on?.slice(0, 10) !== ends) {
    current = gh('PATCH', `${R}/milestones/${current.number}`, { state: 'open', due_on: due });
    say(`  milestone ${sprint}: open, due ${ends}`);
  }
  const issues = gh('GET', `${R}/issues?state=all&per_page=100`, null, { paginate: true }).filter((i) => !i.pull_request);
  for (const m of milestones.filter((x) => x.number !== current.number && /^Sprint \d+$/.test(x.title))) {
    for (const i of issues.filter((x) => x.state === 'open' && x.milestone?.number === m.number)) {
      gh('PATCH', `${R}/issues/${i.number}`, { milestone: current.number });
      say(`  #${i.number} moved from ${m.title} to ${sprint}`);
    }
    if (m.state === 'open') {
      gh('PATCH', `${R}/milestones/${m.number}`, { state: 'closed' });
      say(`  milestone ${m.title}: closed`);
    }
  }
  const byTitle = (prefix) => issues.find((i) => i.title.startsWith(prefix));

  // Code an agent can change, on the default branch; a run also undoes what a recording changed.
  for (const [path, text] of Object.entries(SKELETON)) {
    const have = gh('GET', `${R}/contents/${path}?ref=${main}`, null, { allow404: true });
    if (have && Buffer.from(have.content, 'base64').toString('utf8') === text) continue;
    gh('PUT', `${R}/contents/${path}`, { message: `chore: ${have ? 'update' : 'add'} ${path} (demo code)`, branch: main, content: Buffer.from(text).toString('base64'), ...(have ? { sha: have.sha } : {}) });
    say(`  ${path}: ${have ? 'updated' : 'added'} on ${main}`);
  }

  // Done today: the runbook PR merges and closes its issue.
  const pulls = gh('GET', `${R}/pulls?state=all&per_page=100`, null, { paginate: true });
  const runbook = pulls.find((p) => p.head.ref === 'docs/refund-runbook');
  if (runbook?.state === 'open') {
    gh('PUT', `${R}/pulls/${runbook.number}/merge`, { merge_method: 'squash' });
    say(`  PR #${runbook.number}: merged`);
  }

  // In progress today: a status comment on each, once per sprint.
  const notes = [
    ['Tokenise stored cards', `Edge proxy now swaps PANs for tokens in staging; the core service still has one code path that reads the raw number. Finishing that next. (${sprint} update, ${DEMO_NOTE})`],
    ['Duplicate capture when', `Root cause found: the idempotency check runs after the processor call. Fix is up for review; the shared store work waits on it. (${sprint} update, ${DEMO_NOTE})`],
  ];
  for (const [prefix, body] of notes) {
    const issue = byTitle(prefix);
    if (!issue) continue;
    const comments = gh('GET', `${R}/issues/${issue.number}/comments?per_page=100`, null, { paginate: true });
    if (comments.some((c) => c.body.includes(`(${sprint} update`))) continue;
    gh('POST', `${R}/issues/${issue.number}/comments`, { body });
    say(`  #${issue.number}: status comment added`);
  }

  // A code review waiting on review, for the duplicate-capture fix.
  const dup = byTitle('Duplicate capture when');
  const fixBranch = 'fix/check-idempotency-before-capture';
  if (dup && !pulls.some((p) => p.head.ref === fixBranch)) {
    if (!gh('GET', `${R}/git/ref/heads/${fixBranch}`, null, { allow404: true })) {
      const sha = gh('GET', `${R}/git/ref/heads/${main}`).object.sha;
      gh('POST', `${R}/git/refs`, { ref: `refs/heads/${fixBranch}`, sha });
    }
    const path = 'docs/idempotency.md';
    if (!gh('GET', `${R}/contents/${path}?ref=${fixBranch}`, null, { allow404: true })) {
      gh('PUT', `${R}/contents/${path}`, { message: 'fix: check the idempotency key before calling the processor', branch: fixBranch, content: Buffer.from('# Idempotency\n\nA capture checks its idempotency key before it calls the processor, so a retried request returns the first result instead of capturing again.\n').toString('base64') });
    }
    const pr = gh('POST', `${R}/pulls`, { title: 'fix: check the idempotency key before calling the processor', head: fixBranch, base: main, body: `Closes #${dup.number}.\n\nMoves the idempotency check ahead of the processor call. ${DEMO_NOTE}` });
    gh('POST', `${R}/issues/${pr.number}/labels`, { labels: ['toil-seed'] });
    say(`  PR #${pr.number}: opened, waiting on review`);
  }

  // The blocker chain: duplicate capture -> shared store -> payout preview -> rolling reserve.
  const store = byTitle('Keep idempotency keys');
  const preview = byTitle('Payout preview');
  if (store && preview) {
    const line = `Blocked by #${store.number}.`;
    const body = preview.body ?? '';
    if (!body.includes(line)) {
      gh('PATCH', `${R}/issues/${preview.number}`, { body: `${body}\n\n${line}` });
      say(`  #${preview.number}: ${line}`);
    }
    if (!preview.labels.some((l) => l.name === 'blocked')) gh('POST', `${R}/issues/${preview.number}/labels`, { labels: ['blocked'] });
  }

  // Estimates the blocker timeline's critical chain depends on (GITHUB_POINTS): one points label, swapped only when it differs.
  for (const [prefix, points] of Object.entries(GITHUB_POINTS)) {
    const issue = byTitle(prefix);
    if (!issue) continue;
    const want = `points: ${points}`;
    const have = issue.labels.map((l) => l.name).filter((n) => /^points: \d+$/.test(n));
    if (have.length === 1 && have[0] === want) continue;
    for (const name of have.filter((n) => n !== want)) gh('DELETE', `${R}/issues/${issue.number}/labels/${encodeURIComponent(name)}`);
    if (!have.includes(want)) gh('POST', `${R}/issues/${issue.number}/labels`, { labels: [want] });
    say(`  #${issue.number}: ${want}`);
  }

  // One item ready for an agent: open, with today's text, even after a recording closed it.
  const item = AGENT_ITEMS.github;
  // Matched on both labels, so an agent-ready issue a person filed is never rewritten.
  const agent = issues.filter((i) => ['agent-ready', 'toil-seed'].every((name) => i.labels.some((l) => l.name === name))).sort((a, b) => b.number - a.number)[0];
  if (!agent) {
    const i = gh('POST', `${R}/issues`, { title: item.title, body: item.body, labels: ['agent-ready', 'toil-seed', 'type: bug', 'priority: medium', 'points: 1'], milestone: current.number });
    say(`  #${i.number}: agent-ready issue created`);
  } else {
    if (agent.state !== 'open' || agent.title !== item.title || agent.body !== item.body || agent.milestone?.number !== current.number) {
      gh('PATCH', `${R}/issues/${agent.number}`, { state: 'open', title: item.title, body: item.body, milestone: current.number });
      say(`  #${agent.number}: agent-ready issue ${agent.state !== 'open' ? 'reopened' : 'brought up to date'}`);
    }
  }
  say(`  done: https://github.com/${owner}/${repo}/milestone/${current.number}`);
}

if (only.includes('github')) github();
if (only.includes('jira')) (await import('./demo-week-jira.mjs')).jira({ toil, say, fail, sprint, ends, project: SANDBOX.jiraProject, item: AGENT_ITEMS.jira, note: DEMO_NOTE });
if (only.includes('ado')) (await import('./demo-week-ado.mjs')).ado({ toil, say, fail, sprint, ends, project: SANDBOX.adoProject, item: AGENT_ITEMS.ado, skeleton: SKELETON, note: DEMO_NOTE });

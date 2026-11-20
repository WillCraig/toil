// Every step of .github/workflows/triage.yml that does more than wire inputs to
// outputs, as one function each, so the wiring is tested here instead of being
// discovered in a run. The YAML passes inputs as env vars (never interpolated
// into a script) and reads the outputs these write to $GITHUB_OUTPUT.
//
//   node scripts/triage/steps.mjs <step>
//
// Each step takes { env, fetcher, log } and returns its outputs; the CLI writes
// them to $GITHUB_OUTPUT. OUTPUTS lists what each step can write, and
// test/workflow-wiring.test.ts holds the YAML to it. Three rounds of review found
// wiring bugs no unit test could see, which is three more than a form ought to
// need before someone checks the boxes are connected.

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { extract, inspect } from './archive.mjs';
import { CLAIMED, DENIED, FAILED, NEEDS_HUMAN, QUEUED, claim, drain, gh } from './cap.mjs';
import { check } from './changes.mjs';
import { decide } from './decision.mjs';
import { areas } from './labels.mjs';
import { parseTerms, redact } from './redact.mjs';

/** What each step may write to $GITHUB_OUTPUT. */
export const OUTPUTS = {
  select: ['issues'],
  redact: [],
  prepare: ['fenced', 'nonce', 'areas', 'handover_sha', 'direction'],
  decide: ['decision', 'labels', 'duplicate_of'],
  requeue: [],
  hold: [],
  'open-pr': ['url'],
  apply: [],
};

const options = (env, fetcher) => ({ fetcher, token: env.GH_TOKEN });
const repoOf = (env) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) throw new Error('GITHUB_REPOSITORY must be owner/name.');
  return env.GITHUB_REPOSITORY;
};
const issueOf = (value, name) => {
  if (!/^[1-9]\d*$/.test(String(value ?? '').trim())) throw new Error(`${name} is empty or not an issue number.`);
  return Number(value);
};

/** Parses the issue list one job hands the next; empty or missing is an empty list, anything else is refused. */
export function parseIssues(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return [];
  const list = JSON.parse(text);
  if (!Array.isArray(list) || list.some((n) => !Number.isInteger(n) || n < 1)) throw new Error(`Not a list of issue numbers: ${text}`);
  return list;
}

/**
 * The one person whose comments re-run triage and steer it. A comment from anyone
 * else is a stranger's, and never reaches the agent as direction. The workflow's
 * `if` names the same login; GitHub sets it from the account, so it can't be forged.
 */
export const MAINTAINER = 'kolatts';
/**
 * Comments a Claude Code session posts under the maintainer's login carry one of
 * these marks (the `ship` skill's round marker and reply footer, a PR footer). They
 * are an agent's words, not the maintainer's, so they neither start a run nor count
 * as direction.
 */
const AGENT_MARKS = ['<!-- toil-feedback-round -->', 'Addressed by [Claude Code]', 'Generated with [Claude Code]'];
const fromAgent = (body) => AGENT_MARKS.some((mark) => String(body ?? '').includes(mark));
/** Labels that take a PR out of any agent's hands (the `automation` skill). */
const HANDS_OFF = ['no-auto-fix', 'needs-human'];
/** The branch open-pr pushes for an issue, and the one a comment on a triage PR maps back from. */
const BRANCH = /^claude\/issue-([1-9]\d*)$/;

/**
 * select: which issues this run triages. A label event claims within the cap; the
 * schedule drains the queue; a dispatch is a re-triage, and so is the maintainer's
 * comment on the issue or on the draft PR triage opened for it.
 */
export async function select({ env, fetcher = fetch, log = console.log }) {
  const repo = repoOf(env);
  const cap = Number(env.TRIAGE_CAP ?? '4');
  if (env.EVENT === 'issues') {
    const issue = issueOf(env.ISSUE, 'ISSUE');
    const result = await claim(repo, issue, cap, options(env, fetcher));
    log(`#${issue}: ${result.reason}`);
    return { issues: JSON.stringify(result.run ? [issue] : []) };
  }
  if (env.EVENT === 'workflow_dispatch') {
    const issue = issueOf(env.DISPATCHED, 'The dispatched issue');
    log(`A manual re-triage of #${issue}, not counted against the cap.`);
    return { issues: JSON.stringify([issue]) };
  }
  if (env.EVENT === 'issue_comment') {
    if (env.COMMENTER !== MAINTAINER) {
      log(`A comment from ${env.COMMENTER || 'nobody named'}, not ${MAINTAINER}; nothing to triage.`);
      return { issues: '[]' };
    }
    if (fromAgent(env.COMMENT_BODY)) {
      log(`The comment carries an agent's mark, so it's not ${MAINTAINER}'s direction; nothing to triage.`);
      return { issues: '[]' };
    }
    const number = issueOf(env.ISSUE, 'ISSUE');
    let issue = number;
    if (env.IS_PR === 'true') {
      // A comment on a PR re-triages the issue the PR was opened for, and only a
      // PR triage itself pushed from this repository.
      const pr = await gh('GET', `/repos/${repo}/pulls/${number}`, undefined, options(env, fetcher));
      const mapped = pr.head?.repo?.full_name === repo ? BRANCH.exec(pr.head?.ref ?? '')?.[1] : undefined;
      if (!mapped || pr.state !== 'open') {
        log(`#${number} is not an open pull request triage opened; nothing to triage.`);
        return { issues: '[]' };
      }
      issue = Number(mapped);
    }
    // The re-run force-pushes claude/issue-<n> from main, so once a person has
    // taken its PR over (marked it ready, or labelled it hands-off) a comment on
    // the PR or on the issue leaves it alone.
    const owner = repo.split('/')[0];
    const pulls = (await gh('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:claude/issue-${issue}`)}`, undefined, options(env, fetcher))) ?? [];
    for (const pr of pulls) {
      const handsOff = (pr.labels ?? []).map((l) => l.name).filter((name) => HANDS_OFF.includes(name));
      if (pr.draft !== true || handsOff.length) {
        log(`Triage's PR #${pr.number} is ${pr.draft !== true ? 'no longer a draft' : `labelled ${handsOff.join(', ')}`}, so a person has it; triage won't push over it.`);
        return { issues: '[]' };
      }
    }
    log(`${MAINTAINER} commented on ${issue === number ? `#${issue}` : `triage's PR #${number}`}: a re-triage of #${issue}, not counted against the cap.`);
    return { issues: JSON.stringify([issue]) };
  }
  if (env.EVENT === 'schedule') {
    const issues = await drain(repo, cap, options(env, fetcher));
    log(issues.length ? `Triaging from the queue: ${issues.map((n) => `#${n}`).join(', ')}` : 'Nothing to triage from the queue today.');
    return { issues: JSON.stringify(issues) };
  }
  throw new Error(`Triage doesn't run on ${env.EVENT ?? 'an unnamed event'}.`);
}

/** redact: rewrites each claimed issue's title and body in place before anything else reads them. */
export async function redactIssues({ env, fetcher = fetch, log = console.log }) {
  const repo = repoOf(env);
  const terms = parseTerms(env.REDACT_TERMS ?? '');
  if (terms.invalid) log(`::warning::${terms.invalid} REDACT_TERMS entries were refused (they would match the redactor's own markers).`);
  for (const number of parseIssues(env.ISSUES)) {
    const issue = await gh('GET', `/repos/${repo}/issues/${number}`, undefined, options(env, fetcher));
    const title = redact(issue.title ?? '', terms);
    const body = redact(issue.body ?? '', terms);
    if (title !== (issue.title ?? '') || body !== (issue.body ?? '')) {
      await gh('PATCH', `/repos/${repo}/issues/${number}`, { title, body }, options(env, fetcher));
      log(`Redacted #${number} in place.`);
    }
  }
  return {};
}

const EXCLUDED = new Set(['.git', 'node_modules', '.triage-out', '.triage-in']);

/** Pages of 100 read for the duplicate check; pull requests count against them. */
const ISSUE_PAGES = 10;
/** Denied issues shown with their reasons, newest first; each body and comment is cut to this many characters. */
const MAX_DENIED = 30;
const MAX_DENIED_TEXT = 2000;
/** Pages of 100 comments read on each denied issue, so the newest are found, not the first hundred. */
const COMMENT_PAGES = 5;
/**
 * Whose comments can say why a request was denied: triage itself and the project's
 * own people. Anyone can comment on a closed issue, so a stranger's "the rule changed"
 * must never reach the agent as a reason.
 */
const REASON_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const TRIAGE_BOT = 'imagile-bot[bot]';
/** Each comment in the maintainer's direction is cut to this many characters, and the whole to the last this many comments. */
const MAX_DIRECTION_TEXT = 4000;
const MAX_DIRECTION_COMMENTS = 20;

/** Every comment on an issue or PR, oldest first, up to COMMENT_PAGES pages. */
async function commentsOn(repo, number, o) {
  const all = [];
  for (let page = 1; page <= COMMENT_PAGES; page++) {
    const batch = (await gh('GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`, undefined, o)) ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * The conversation on the issue and on the open PR triage made for it, oldest first,
 * split by how far each comment can be trusted. `direction` is the maintainer's own
 * comments (not an agent's posted under that login): trusted, and set outside the
 * fence. `earlier` is the project bot's comments (triage's earlier runs, and the
 * review agent on the PR): agent output that read untrusted text, so it goes inside
 * the fence as context. Nobody else's comments are included. Any line that could pass
 * for one of the headers is indented, so no body can forge an author.
 */
async function conversation(repo, number, terms, o) {
  const entry = (where) => (c) => ({ where, at: c.created_at ?? '', login: c.user?.login, body: c.body ?? '' });
  const all = (await commentsOn(repo, number, o)).map(entry(`issue #${number}`));
  const owner = repo.split('/')[0];
  const pulls = (await gh('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:claude/issue-${number}`)}`, undefined, o)) ?? [];
  for (const pr of pulls) all.push(...(await commentsOn(repo, pr.number, o)).map(entry(`PR #${pr.number}`)));
  all.sort((a, b) => a.at.localeCompare(b.at));
  const render = (who) => (c) => `--- ${who}, on ${c.where}${c.at ? `, ${c.at}` : ''}\n${redact(c.body, terms).replace(/\r/g, '').slice(0, MAX_DIRECTION_TEXT).replace(/^(\s*)---/gm, '$1  ---')}`;
  const mine = all.filter((c) => c.login === MAINTAINER && !fromAgent(c.body)).slice(-MAX_DIRECTION_COMMENTS);
  const bot = all.filter((c) => c.login === TRIAGE_BOT).slice(-MAX_DIRECTION_COMMENTS);
  return {
    direction: mine.length ? mine.map(render(`${MAINTAINER} (maintainer)`)).join('\n\n') : 'None. Triage on CLAUDE.md alone.',
    earlier: bot.map(render('the project bot (triage or review)')).join('\n\n'),
  };
}

/**
 * prepare: everything the agent reads, made before it starts by main's code: the
 * issue (redacted again, in case it changed since select) fenced with a nonce,
 * the repository's issues for the duplicate check, the area list, a pristine copy
 * of the tree, and the handover script copied out with its hash.
 */
export async function prepare({ env, fetcher = fetch, cwd = process.cwd() }) {
  const repo = repoOf(env);
  const number = issueOf(env.NUMBER, 'NUMBER');
  const temp = env.RUNNER_TEMP;
  if (!temp) throw new Error('RUNNER_TEMP is not set.');
  const terms = parseTerms(env.REDACT_TERMS ?? '');
  const issue = await gh('GET', `/repos/${repo}/issues/${number}`, undefined, options(env, fetcher));
  // Every other issue, open or closed, for the duplicate check. The issue being
  // triaged is left out: a re-triage is a fresh look, never its own duplicate.
  // The endpoint returns pull requests too, which use up pages, hence ten of them.
  const list = [];
  const bodies = new Map();
  for (let page = 1; page <= ISSUE_PAGES; page++) {
    const batch = await gh('GET', `/repos/${repo}/issues?state=all&per_page=100&page=${page}`, undefined, options(env, fetcher));
    for (const i of batch) {
      if (i.pull_request || i.number === number) continue;
      list.push({ number: i.number, title: redact(i.title ?? '', terms), state: i.state, stateReason: i.state_reason ?? null, labels: (i.labels ?? []).map((l) => l.name) });
      bodies.set(i.number, i.body ?? '');
    }
    if (batch.length < 100) break;
  }
  // A past denial binds only if its reason still holds, and the list carries no
  // reasons. So the denied issues come with their body and their last comments,
  // redacted, and the agent reads why rather than guessing.
  const denied = [];
  for (const i of list.filter((d) => d.labels.includes(DENIED)).sort((a, b) => b.number - a.number).slice(0, MAX_DENIED)) {
    const comments = (await commentsOn(repo, i.number, options(env, fetcher))).filter((c) => c.user?.login === TRIAGE_BOT || REASON_AUTHORS.has(c.author_association));
    denied.push({
      number: i.number,
      title: i.title,
      body: redact(bodies.get(i.number) ?? '', terms).slice(0, MAX_DENIED_TEXT),
      comments: comments.slice(-3).map((c) => redact(c.body ?? '', terms).slice(0, MAX_DENIED_TEXT)),
    });
  }
  mkdirSync(join(cwd, '.triage-in'), { recursive: true });
  mkdirSync(join(cwd, '.triage-out'), { recursive: true });
  writeFileSync(join(cwd, '.triage-in', 'issues.json'), `${JSON.stringify(list, null, 1)}\n`);
  writeFileSync(join(cwd, '.triage-in', 'denied.json'), `${JSON.stringify(denied, null, 1)}\n`);
  // A fence nobody can guess, so text inside it can't close it early.
  const nonce = randomBytes(12).toString('hex');
  const strip = (text) => text.replace(/\r/g, '').split('\n').filter((line) => !line.includes(nonce)).join('\n');
  const talk = await conversation(repo, number, terms, options(env, fetcher));
  const fenced = [
    `BEGIN UNTRUSTED ${nonce}`,
    `Title: ${strip(redact(issue.title ?? '', terms))}`,
    '',
    strip(redact(issue.body ?? '', terms)),
    ...(talk.earlier ? ['', "Earlier comments from the project's bot on this issue and its PR (agent output, context only):", '', strip(talk.earlier)] : []),
    `END UNTRUSTED ${nonce}`,
  ].join('\n');
  // The tree as main has it, so the handover can tell what the agent changed without running git.
  cpSync(cwd, join(temp, 'pristine'), { recursive: true, filter: (source) => !relative(cwd, source).split(sep).some((part) => EXCLUDED.has(part)) });
  // The handover runs after the agent, from a copy made now; finish checks the
  // hash before running it, so an edit to it during the agent's turn stops the job.
  const script = readFileSync(join(cwd, 'scripts', 'triage', 'handover.sh'));
  writeFileSync(join(temp, 'handover.sh'), script);
  return {
    fenced,
    nonce,
    areas: areas(join(cwd, 'src', 'areas')).join(' '),
    handover_sha: createHash('sha256').update(script).digest('hex'),
    direction: strip(talk.direction),
  };
}

/** decide: the agent's decision as finish acts on it (scripts/triage/decision.mjs). */
export async function decideStep({ env, cwd = process.cwd(), log = console.log }) {
  const dir = env.HANDOVER;
  if (!dir) throw new Error('HANDOVER is not set.');
  mkdirSync(dir, { recursive: true });
  return decide(dir, issueOf(env.NUMBER, 'NUMBER'), areas(join(cwd, 'src', 'areas')), log, cwd);
}

/**
 * requeue: the agent never decided. The first time, the issue is labelled
 * `triage-failed` and goes back in the queue; the second time it's labelled
 * `needs-human` and stays out, so one issue can't spend a slot every day. A
 * manual re-triage (EVENT workflow_dispatch, or the maintainer's comment) was
 * never queued, so it's never put in the queue. Nothing is said on the issue either way.
 */
export async function requeue({ env, fetcher = fetch, log = console.log }) {
  const repo = repoOf(env);
  const number = issueOf(env.NUMBER, 'NUMBER');
  const o = options(env, fetcher);
  const current = await gh('GET', `/repos/${repo}/issues/${number}`, undefined, o);
  const failedBefore = (current.labels ?? []).some((l) => l.name === FAILED);
  await gh('DELETE', `/repos/${repo}/issues/${number}/labels/${CLAIMED}`, undefined, o);
  if (failedBefore) {
    await gh('DELETE', `/repos/${repo}/issues/${number}/labels/${QUEUED}`, undefined, o);
    await gh('POST', `/repos/${repo}/issues/${number}/labels`, { labels: [NEEDS_HUMAN] }, o);
    log(`#${number} failed triage twice; labelled ${NEEDS_HUMAN} and left out of the queue.`);
    return {};
  }
  const manual = env.EVENT === 'workflow_dispatch' || env.EVENT === 'issue_comment';
  await gh('POST', `/repos/${repo}/issues/${number}/labels`, { labels: manual ? [FAILED] : [FAILED, QUEUED] }, o);
  log(manual ? `#${number}: the manual re-triage failed; labelled ${FAILED}.` : `#${number} failed triage once; labelled ${FAILED} and queued again.`);
  return {};
}

/** hold: something credential-shaped was found in what the agent wrote, so nothing is posted and a person looks. */
export async function hold({ env, fetcher = fetch }) {
  const repo = repoOf(env);
  const number = issueOf(env.NUMBER, 'NUMBER');
  const o = options(env, fetcher);
  await gh('DELETE', `/repos/${repo}/issues/${number}/labels/${CLAIMED}`, undefined, o);
  await gh('POST', `/repos/${repo}/issues/${number}/labels`, { labels: [NEEDS_HUMAN] }, o);
  return {};
}

const git = (cwd, args, extraEnv = {}) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  if (run.error || run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.error?.message ?? run.stderr.trim()}`);
  return run.stdout;
};

/**
 * open-pr: the fix as a draft PR. Every path is checked by main's scripts before
 * a byte lands, and again on the commit; nothing in the fix is run.
 */
export async function openPr({ env, fetcher = fetch, cwd = process.cwd(), log = console.log }) {
  const repo = repoOf(env);
  const number = issueOf(env.NUMBER, 'NUMBER');
  const dir = env.HANDOVER;
  const known = areas(join(cwd, 'src', 'areas'));
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : Buffer.alloc(0));
  const inspected = inspect(read('changes.tar'), read('deleted.txt').toString('utf8'), known);
  if (!inspected.ok) throw new Error(`The fix touches files triage may not:\n${inspected.refused.map((r) => `  - ${r}`).join('\n')}`);
  extract(inspected, cwd);
  const branch = `claude/issue-${number}`;
  git(cwd, ['checkout', '-q', '-b', branch]);
  git(cwd, ['add', '-A']);
  const raw = git(cwd, ['diff', '--cached', '--raw', '-z', '--no-renames']);
  const entries = raw.split('\0').filter(Boolean).reduce((acc, field, i, all) => (i % 2 === 0 ? [...acc, { path: all[i + 1], newMode: field.slice(1).split(' ')[1] }] : acc), []);
  const checked = check(entries, known);
  if (!checked.ok) throw new Error(`The commit touches files triage may not: ${checked.refused.join('; ')}`);
  const title = read('pr-title.checked.txt').toString('utf8').trim() || `Triage fix for #${number}`;
  git(cwd, ['-c', 'user.name=imagile-bot[bot]', '-c', 'user.email=imagile-bot[bot]@users.noreply.github.com', 'commit', '-q', '-m', title]);
  // The token reaches git through a credential helper reading env, never argv.
  const pushUrl = env.PUSH_URL ?? `https://github.com/${repo}.git`;
  git(cwd, ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=${GH_TOKEN}"; }; f', 'push', '--force', pushUrl, `HEAD:refs/heads/${branch}`], { GH_TOKEN: env.GH_TOKEN ?? '' });
  // Listed by the workflow from the checked paths, so the agent can't leave it out; its own account of what each edit loosened follows in its text.
  const safety = checked.safety.length
    ? ['## Safety-layer edits', '', "This fix edits files that decide what toil or Toil UI may write, read, run or reach (the write gate, secrets, files, network, bounds, audit, config, the MCP server, Toil UI's server and Settings). Read these first; the description below says what each change loosened or widened, if the agent said:", '', ...checked.safety.map((f) => `- \`${f}\``), '']
    : [];
  const body = [
    ...safety,
    read('pr-body.checked.md').toString('utf8').trim(),
    '',
    `Closes #${number}`,
    '',
    ...(checked.core ? ['This changes toil itself (`src/` outside one area). Triage cannot run the full gate (typecheck, lint, test, build, `check:pure`, `smoke`); CI runs it on this draft, and it has to be green before a maintainer merges.', ''] : []),
    ...(checked.ui ? ["This changes Toil UI (`ui/`). Triage cannot run Toil UI's gate, so before it merges a maintainer runs `npm run verify:ui` and the `ship` skill's screen review (CLAUDE.md, Build & Test), and reads the change against principle 11.", ''] : []),
    "Opened as a draft by triage (`.github/workflows/triage.yml`) from a fix an agent proposed. Every changed path was checked against what a triage fix may touch (not the workflows, scripts or CLAUDE.md, not the site or the Azure Function backend, not a dependency). CI runs the full gate on this draft; a human marks it ready and merges it.",
  ].join('\n');
  const owner = repo.split('/')[0];
  const open = await gh('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`, undefined, options(env, fetcher));
  const pr = open[0]
    ? await gh('PATCH', `/repos/${repo}/pulls/${open[0].number}`, { title, body }, options(env, fetcher))
    : await gh('POST', `/repos/${repo}/pulls`, { title, body, head: branch, base: 'main', draft: true }, options(env, fetcher));
  await gh('POST', `/repos/${repo}/issues/${pr.number}/labels`, { labels: ['from-triage'] }, options(env, fetcher));
  log(`Draft PR: ${pr.html_url}`);
  return { url: pr.html_url };
}

/** apply: the comment, labels and closing the decision calls for. A `maintainer` decision comments and labels, and leaves the issue open. */
export async function apply({ env, fetcher = fetch }) {
  const repo = repoOf(env);
  const number = issueOf(env.NUMBER, 'NUMBER');
  const decision = env.DECISION;
  if (!['fix', 'maintainer', 'deny', 'duplicate', 'invalid'].includes(decision)) throw new Error(`apply has nothing to do for decision ${JSON.stringify(decision)}.`);
  const dir = env.HANDOVER;
  let body = existsSync(join(dir, 'comment.checked.md')) ? readFileSync(join(dir, 'comment.checked.md'), 'utf8') : '';
  let labels = (env.LABELS ?? '').split(',').filter(Boolean);
  if (decision === 'fix') {
    body += env.PR_URL
      ? `\n\nProposed fix, as a draft pull request: ${env.PR_URL}. CI tests it; a maintainer reviews and merges it.\n`
      : `\n\nThe proposed change could not be made into a pull request (${env.RUN_URL}). A maintainer will look at it.\n`;
  }
  if (decision === 'invalid') {
    body = `Triage could not reach a valid decision (${env.RUN_URL}). A maintainer will look at it.\n`;
    labels = ['triaged'];
  }
  const o = options(env, fetcher);
  let decided = decision;
  if (decision === 'duplicate') {
    // The original must be another issue that exists. A duplicate of a denied
    // request is denied too; a duplicate of anything else isn't.
    const of = issueOf(env.DUPLICATE_OF, 'DUPLICATE_OF');
    const original = of === number ? undefined : await gh('GET', `/repos/${repo}/issues/${of}`, undefined, o).catch((error) => {
      // Only a 404 means the original doesn't exist. An auth, server or network
      // failure fails the step, rather than telling the issue something untrue.
      if (/ returned 404:/.test(error.message)) return undefined;
      throw error;
    });
    if (!original || original.pull_request) {
      decided = 'invalid';
      body = `Triage could not reach a valid decision (${env.RUN_URL}): it named #${of} as the original, which is not another issue. A maintainer will look at it.\n`;
      labels = ['triaged'];
    } else {
      if ((original.labels ?? []).some((l) => l.name === DENIED)) labels.push(DENIED);
      if (!new RegExp(`#${of}\\b`).test(body)) body += `\n\nThis is the same request as #${of}.`;
      body += `\n\nDuplicate of #${of}\n`;
    }
  }
  await gh('POST', `/repos/${repo}/issues/${number}/comments`, { body: body.trim() || 'Triaged.' }, o);
  await gh('POST', `/repos/${repo}/issues/${number}/labels`, { labels }, o);
  // A decision ends the issue's time in triage: the claim, the queue and an earlier
  // failure all come off, whether it came from a label, the queue or a manual re-triage.
  // A re-triage that now reaches another decision takes `needs-maintainer` off too.
  for (const label of [CLAIMED, QUEUED, FAILED, ...(decision === 'maintainer' ? [] : ['needs-maintainer'])]) await gh('DELETE', `/repos/${repo}/issues/${number}/labels/${label}`, undefined, o);
  if (decision === 'deny') await gh('PATCH', `/repos/${repo}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' }, o);
  if (decided === 'duplicate') await gh('PATCH', `/repos/${repo}/issues/${number}`, { state: 'closed', state_reason: 'duplicate' }, o);
  return {};
}

export const STEPS = { select, redact: redactIssues, prepare, decide: decideStep, requeue, hold, 'open-pr': openPr, apply };

/** Writes outputs to a GITHUB_OUTPUT file, multi-line values with a delimiter nothing in them can contain. */
export function writeOutputs(file, outputs) {
  for (const [key, value] of Object.entries(outputs)) {
    const text = String(value);
    if (!text.includes('\n')) appendFileSync(file, `${key}=${text}\n`);
    else {
      const delimiter = `EOF_${randomBytes(12).toString('hex')}`;
      appendFileSync(file, `${key}<<${delimiter}\n${text}\n${delimiter}\n`);
    }
  }
}

/** Reads a GITHUB_OUTPUT file back, as the runner does, for tests. */
export function readOutputs(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heredoc = /^([\w-]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], i + 1);
      out[heredoc[1]] = lines.slice(i + 1, end).join('\n');
      i = end;
    } else if (line.includes('=')) {
      out[line.slice(0, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2];
  const step = STEPS[name];
  if (!step) {
    console.error(`Usage: steps.mjs <${Object.keys(STEPS).join('|')}>`);
    process.exit(1);
  }
  try {
    const outputs = await step({ env: process.env });
    if (process.env.GITHUB_OUTPUT) writeOutputs(process.env.GITHUB_OUTPUT, outputs);
    else console.log(JSON.stringify(outputs));
  } catch (error) {
    console.error(`::error::triage ${name}: ${error.message}`);
    process.exit(1);
  }
}

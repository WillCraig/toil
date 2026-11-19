// The Jira half of demo-week.mjs: makes the active sprint the current one
// (renamed to --sprint, running to --ends), gives the three placeholder issues a
// new Jira site starts with believable payments titles, makes a day of movement,
// adds one blocker so the vault story holds up the stored-token charge, and keeps
// one story ready for an agent open, gives the chains' issues due dates across the
// sprint (demo-week-data.mjs, JIRA_DUE_DAYS) for the blocker timeline to draw, and
// gives each seeded story the text the
// ticket rules expect of it (demo-week-data.mjs, RULE_GAPS: three stories miss
// Given/When/Then and two miss the user-story form, on purpose). Everything goes through toil with
// --allow-write, so the `jira` connection's writes decide, and the project is
// always named. An issue is changed only when it carries the `toil-seed` label
// (the placeholders are the one exception, and only while they still have their
// placeholder titles); anything else is skipped and said. A read that fails stops
// the run rather than being taken for "nothing there", so a second run never
// posts twice. Repo tooling only: nothing here ships. Task 1, Task 2 and Task 3
// have been promoted, as placeholders eventually are.
import { flatText, JIRA_BLOCKS, JIRA_DUE_DAYS, jiraStory, RULE_GAPS, ruleMisses, sprintDay, STORIES, typeOfName } from './demo-week-data.mjs';

const day = 24 * 60 * 60 * 1000;
const sameRules = (a, b) => a.length === b.length && a.every((r) => b.includes(r));

export function jira({ toil, say, fail, sprint, ends, project, item, note }) {
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(project)) fail(`"${project}" isn't a Jira project key.`, 'Use the test project from CLAUDE.md, SCRUM.');
  const p = ['--project', project];
  const w = ['--allow-write'];
  say(`Jira project ${project}`);

  // The active sprint becomes this week's.
  const board = toil(['jira', 'board', 'list', ...p]).data[0];
  const sprints = toil(['jira', 'sprint', 'list', '--board', String(board.id)]).data;
  const active = sprints.find((s) => s.state === 'active');
  if (!active) {
    say('  no active sprint: start one on the board first');
    return;
  }
  const start = new Date(Date.parse(`${ends}T00:00:00Z`) - 11 * day).toISOString().slice(0, 10);
  if (active.name !== sprint || !active.endDate?.startsWith(ends)) {
    toil(['jira', 'sprint', 'update', String(active.id), '--name', sprint, '--start', start, '--end', ends, '--goal', 'Stored cards end to end: vault, tokenised charges and saved-card checkout', ...w]);
    say(`  sprint ${active.id}: now "${sprint}", ${start} to ${ends}`);
  }

  // An issue that isn't there is skipped; any other failed read stops the run.
  const get = (key) => {
    const read = toil(['jira', 'issue', 'get', key, '--select', '{key: key, summary: fields.summary, status: fields.status.name, labels: fields.labels, assignee: fields.assignee.accountId}'], { soft: true });
    if (read.ok) return read.data;
    if (read.error.code !== 'NOT_FOUND') fail(`couldn't read ${key}: ${read.error.message}`, 'Run it again; a failed read is never taken for "no such issue".');
    say(`  skipped ${key}: it doesn't exist`);
    return undefined;
  };
  // The token's own account: the one issue it is assigned, if any. No one else is ever assigned.
  const me = toil(['jira', 'issue', 'search', '--jql', `project = "${project}" AND assignee = currentUser()`, '--limit', '1', '--fields', 'assignee', '--select', 'issues[0].fields.assignee.accountId']).data ?? undefined;
  const marker = `(${sprint} update, ${note})`;
  const commented = (key) => {
    const read = toil(['jira', 'issue', 'comments', key], { soft: true });
    if (!read.ok) fail(`couldn't read the comments on ${key}: ${read.error.message}`, 'Run it again; a failed read is never taken for "no comment yet".');
    return JSON.stringify(read.data).includes(`${sprint} update`);
  };
  const seeded = (issue) => issue?.labels?.includes('toil-seed');

  // Placeholders a new site creates, given real work to stand for.
  const renames = [
    { key: `${project}-1`, seed: 'demo-tls', summary: "Rotate the gateway's TLS certificate before it expires on 4 Dec" },
    { key: `${project}-2`, seed: 'demo-load', summary: 'Load test the payout scheduler at three times November volume', assign: true },
    { key: `${project}-3`, seed: 'demo-webhooks', summary: 'Move webhook retries onto the shared queue', assign: true },
  ];
  for (const r of renames) {
    const issue = get(r.key);
    if (!issue || issue.labels?.includes(`seed:${r.seed}`)) continue;
    if (!/^Task \d+$/.test(issue.summary)) continue; // someone renamed it already; leave it
    toil(['jira', 'issue', 'update', r.key, '--summary', r.summary, '--labels', [...(issue.labels ?? []), 'toil-seed', `seed:${r.seed}`].join(','), ...(r.assign && me ? ['--assignee', me] : []), ...w]);
    say(`  ${r.key}: renamed to "${r.summary}"`);
  }

  // A day of movement, once per sprint (a comment marks each one done).
  const moves = [
    { key: `${project}-31`, to: 'Done', comment: 'Merged and verified in staging: the basket survives a 3-D Secure timeout.' },
    { key: `${project}-20`, to: 'In Progress', assign: true, comment: 'Picked up today. Same root cause as the duplicate capture on GitHub: the idempotency check runs too late.' },
    { key: `${project}-14`, comment: 'Vault write path is done; the expiry job is the last piece. Tokenising at the edge and charging a stored token both wait on this.' },
    { key: `${project}-16`, comment: 'Gateway side done. The shared maskPan() helper is split out as a small, specified story an agent can take.' },
  ];
  for (const m of moves) {
    const issue = get(m.key);
    if (!issue) continue;
    if (!seeded(issue)) {
      say(`  skipped ${m.key}: it doesn't carry the toil-seed label`);
      continue;
    }
    if (commented(m.key)) continue;
    if (m.assign && me && issue.assignee !== me) toil(['jira', 'issue', 'assign', m.key, '--assignee', me, ...w]);
    if (m.to && issue.status !== m.to) toil(['jira', 'issue', 'transition', m.key, '--transition', m.to, ...w]);
    toil(['jira', 'issue', 'comment', m.key, '--body', `${m.comment} ${marker}`, ...w]);
    say(`  ${m.key}: ${m.to ? `${m.to}, ` : ''}comment added`);
  }

  // The vault story also holds up charging a stored token, and the edge's follow-ups run one after another (JIRA_BLOCKS).
  for (const [from, to] of JIRA_BLOCKS.map((pair) => pair.map((k) => k.replace(/^SCRUM-/, `${project}-`)))) {
    const [a, b] = [get(from), get(to)];
    if (!seeded(a) || !seeded(b)) continue;
    const links = toil(['jira', 'issue', 'get', to, '--select', 'fields.issuelinks[].inwardIssue.key']).data ?? [];
    if (links.includes(from)) continue;
    toil(['jira', 'issue', 'link', from, '--type', 'Blocks', '--target', to, ...w]);
    say(`  ${from} blocks ${to}`);
  }

  // The sprint plan: each chain's issues due one after another, read first and written only where the date differs.
  let dueWritten = 0;
  for (const [seedKey, n] of Object.entries(JIRA_DUE_DAYS)) {
    // The table names the seed's keys; --project moves them, as JIRA_BLOCKS's are moved above.
    const key = seedKey.replace(/^SCRUM-/, `${project}-`);
    const due = sprintDay(ends, n);
    const read = toil(['jira', 'issue', 'get', key, '--select', '{labels: fields.labels, due: fields.duedate}'], { soft: true });
    if (!read.ok) {
      if (read.error.code !== 'NOT_FOUND') fail(`couldn't read ${key}: ${read.error.message}`, 'Run it again; a failed read is never taken for "no due date".');
      say(`  skipped ${key}: it doesn't exist`);
      continue;
    }
    if (!seeded(read.data)) {
      say(`  skipped ${key}: it doesn't carry the toil-seed label`);
      continue;
    }
    if (read.data.due === due) continue;
    const set = toil(['jira', 'issue', 'update', key, '--field', `duedate=${due}`, ...w], { soft: true });
    if (!set.ok) {
      say(`  ${key}: couldn't set the due date to ${due}: ${set.error.message}`);
      continue;
    }
    dueWritten++;
    say(`  ${key}: due ${due}`);
  }
  if (!dueWritten) say(`  sprint plan: all ${Object.keys(JIRA_DUE_DAYS).length} due dates already as planned`);

  // One story ready for an agent: in the sprint, unassigned, and open even after a recording closed it.
  const found = toil(['jira', 'issue', 'search', '--jql', `project = "${project}" AND labels = "seed:agent-maskpan"`, '--limit', '1']).data.issues?.[0];
  if (!found) {
    const created = toil(['jira', 'issue', 'create', ...p, '--type', 'Story', '--summary', item.summary, '--description', item.description, '--labels', 'agent-ready,toil-seed,seed:agent-maskpan', ...w]).data;
    toil(['jira', 'issue', 'set-sprint', created.key, '--sprint', String(active.id), ...w]);
    const link = toil(['jira', 'issue', 'link', created.key, '--type', 'Relates', '--target', `${project}-16`, ...w], { soft: true });
    say(`  ${created.key}: agent-ready story created${link.ok ? '' : `, but the link to ${project}-16 failed: ${link.error.message}`}`);
  } else {
    const story = get(found.key);
    if (story && story.status !== 'To Do') {
      toil(['jira', 'issue', 'transition', found.key, '--transition', 'To Do', ...w]);
      say(`  ${found.key}: agent-ready story back to To Do`);
    }
  }
  // Ticket rules (#657): each seeded story, and the agent-ready one, carries the text
  // demo-week-data.mjs gives it. Looked at first with the same checks the rules make,
  // and written only when what's there misses something other than its planned gap
  // (a gap must also be the planned text), so a second run writes nothing and a run
  // puts back a gap a recording fixed.
  const stories = toil(['jira', 'issue', 'search', '--jql', `project = "${project}" AND labels = "toil-seed" AND issuetype = Story ORDER BY key`, '--limit', '100', '--fields', 'issuetype,labels,description', '--select', 'issues[].{key: key, type: fields.issuetype.name, labels: fields.labels, description: fields.description}']).data ?? [];
  let rulesWritten = 0;
  for (const story of stories) {
    if (!seeded(story)) continue;
    const seedKey = story.labels.find((l) => l.startsWith('seed:'))?.slice(5);
    const text = seedKey === 'agent-maskpan' ? item.description : STORIES[seedKey] ? jiraStory(seedKey) : undefined;
    if (!text) continue;
    const want = RULE_GAPS.jira[seedKey] ?? [];
    // A planned gap is held to its exact text, so it's the gap the docs name and not one that passes by luck.
    if (sameRules(ruleMisses({ type: typeOfName(story.type), description: story.description }), want) && (!want.length || flatText(story.description) === flatText(text))) continue;
    toil(['jira', 'issue', 'update', story.key, '--description', text, ...w]);
    rulesWritten++;
    say(`  ${story.key}: ticket-rule text written, ${want.length ? `missing ${want.join(', ')} on purpose` : 'passing every rule'}`);
  }
  if (!rulesWritten) say(`  ticket rules: all ${stories.length} seeded stories already as planned`);
  say(`  done: sprint ${active.id} on board ${board.id}`);
}

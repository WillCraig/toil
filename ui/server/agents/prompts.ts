/**
 * What the agent is told (#251): the system prompt every adapter sends, and
 * the starter questions, each scoped to the toil project on screen. The rules in
 * the system prompt are asked of the model; the ones that matter are also
 * enforced, on the server, whatever the model does: it has only read tools,
 * and answer.ts flags any id its tools never returned. Belt, braces, and a
 * second belt.
 *
 * The prompt is composed in one order (#283): the rules, unchanged in every
 * theme; then "Style:", the theme's voice (or the person's custom voice) when
 * "Themed agent voice" is on and the theme has one; then the person's own
 * instructions. Each later part says the rules win over it, so a voice
 * changes phrasing and nothing else. Pure, so the page can show the same
 * prompt the server sends.
 */

import { MAX_HISTORY_ANSWER, MAX_HISTORY_TURNS, type Starter } from '../../src/agent.ts';
import type { Execute } from '../../src/toil.ts';
import { jobLabel, parseJobPrompt } from '../../src/model/jobs.ts';
import { MAX_PROPOSALS } from './answer.ts';

export { MAX_HISTORY_ANSWER, MAX_HISTORY_TURNS } from '../../src/agent.ts';

export interface StarterPrompt extends Starter {
  /** The question as the model gets it, written for the toil project. */
  prompt(toilProject: string): string;
}

export const STARTERS: readonly StarterPrompt[] = [
  {
    id: 'standup',
    label: 'Stand-up digest',
    prompt: (d) => `Write a stand-up digest for the Toil project "${d}": what moved since yesterday, what is in progress and with whom, and what is blocked. Use the transitions to say what moved.`,
  },
  {
    id: 'sprint-risk',
    label: 'Why is this sprint at risk?',
    prompt: (d) => `Why is the current sprint in the Toil project "${d}" at risk? Weigh points left against days left, blocked and blocking items, failing builds, scope added after the sprint started, and work carried over.`,
  },
  {
    id: 'hygiene',
    label: 'Backlog hygiene',
    prompt: (d) => `Review the backlog hygiene of the Toil project "${d}": stale items (no update for over 5 days), unestimated items, items with no parent or epic, and items with no assignee. Propose fixes as proposals where toil has a command for them.`,
  },
  {
    id: 'dependencies',
    label: 'Dependency risk',
    prompt: (d) => `What is the dependency risk in the Toil project "${d}"? Follow the blocks links, say which chains are longest, which blockers are not moving, and what unblocks the most work.`,
  },
  {
    id: 'review',
    label: "What's stuck in review, and why?",
    prompt: (d) => `What's stuck in review in the Toil project "${d}", and why? Use pr_query for the open pull requests and pr_get for detail: for each that is stuck, say what it waits on (review, changes, checks or merge) and for how many working days, its flags (no first review in 2 working days, checks failing for over a day, a merge conflict, no linked work item, a work item done while it is open), who wrote it (person, agent or bot), and the work items it carries. Use pr_metrics for how this compares with usual pickup and review times, quoting each figure's sample size.`,
  },
  {
    id: 'yesterday',
    label: 'What happened yesterday?',
    prompt: (d) => `What happened on the Toil project "${d}" yesterday? Read yesterday's page with worklog_day (days are UTC) and say what moved, what merged or was reviewed, what failed or recovered, what the agents did and what a person noted, citing every work item and pull request. Say what the page says it can't vouch for, if anything.`,
  },
  {
    id: 'people-load',
    label: "Who's overloaded or blocked?",
    prompt: (d) => `Who in the Toil project "${d}" is overloaded or blocked? Use people_list: say who has more in progress than the Toil project's limit (or, with no limit set, who carries the most open work, as a fact and not a judgement), whose items are blocked and by what, and which reviews have waited longest on whom. Then person_get for anyone you name. Cite every item and pull request by its id. Describe each person's plate; never rank or score people against each other.`,
  },
  {
    id: 'one-on-one',
    label: 'Prepare my 1:1 notes for <person>',
    prompt: (d) =>
      `Someone wants 1:1 notes for a person in the Toil project "${d}" but didn't say who. Call people_list and reply with the people they can ask about, one per line, each written as the question to ask: Prepare my 1:1 notes for <name>. Nothing else.`,
  },
  {
    id: 'ready',
    label: 'Which items are ready for an agent?',
    prompt: (d) =>
      `Which items in the Toil project "${d}" are ready for an agent? Use readiness_list: name each ready item, then for the items that are thin or blocked, say which checks they fail and what would make them ready (acceptance criteria to write, a description to fill in, a blocker to finish). Use readiness_get for detail on any you discuss. Cite every item by its id. The verdicts are the readiness gate's: report them as they are, without judging them again.`,
  },
  {
    id: 'release-notes',
    label: 'Release notes',
    prompt: (d) => `Draft release notes for the Toil project "${d}" from the work that is done, grouped by type, saying for each item where it is deployed if the cache shows that.`,
  },
];

/** "Prepare my 1:1 notes for Pat": the 1:1 starter with its person filled in, typed or picked. */
const ONE_ON_ONE = /^\s*prepare\s+(?:my\s+)?1:1\s+notes\s+for\s+(.+?)\s*[.?!]?\s*$/i;

/** The 1:1 notes question for one person: facts about the work, each citing its id, and nothing about the person. */
export const oneOnOnePrompt = (toilProject: string, person: string) =>
  `Prepare 1:1 notes for ${person} in the Toil project "${toilProject}". Use person_get for ${person} (people_list if the name doesn't match). Stick to facts about the work: what they have in progress and for how long, their open pull requests and what each waits on, reviews waiting on them, what blocks them, and what they finished or reviewed lately, then two or three questions to ask about blockers and support. Cite every item and pull request by its id. No opinion of the person, no score, and no comparison with anyone else.`;

/**
 * Analyze (#343): the pulse check one press asks, every line citing its
 * items. It isn't a starter chip; the button beside Ask sends its id. "Since
 * the last Analyze" is found in the worklog, which records every question as
 * an agent run. It is written top-down (#395), in the Minto order: a
 * Recommendation line, then at most three Issues, then the Evidence in five
 * parts, each a label at the start of its line, which the page reads back
 * out (src/model/analysis.ts) and lays out with the evidence folded. The
 * labels are plain text, so rule 4's "no Markdown" and the voice's rules
 * still hold.
 */
export const ANALYZE_LABEL = 'Analyze';
export const analyzePrompt = (d: string) =>
  [
    `Give a pulse check of the Toil project "${d}", top-down: the answer first, then the reasons, then the evidence. Work the evidence out first, then write it in exactly this order, each label as plain text (not a Markdown heading) at the start of its own line:`,
    'Recommendation: one or two sentences: the one thing to do first, and why, citing the items it rests on.',
    'Issues: at most three, the ones that matter most, most important first, each on its own line numbered 1. to 3., as a short name, a colon and one sentence citing its items. Write "Issues: none" when nothing stands out.',
    'Evidence: then these five short parts, in this order, each a paragraph that starts with its name. Cite every item and pull request a line rests on; say plainly when a part has nothing.',
    `What changed: since the last Analyze, or the last sync if that is more recent. Read worklog_day for today, then each day before it, back to the first day with a finished agent run asked as "Analyze" (at most 7 days back; this Analyze is in the worklog too, as still running, and doesn't count), and say what moved, merged, failed or recovered.`,
    'Who is on what: people_list, for each person and agent with work in progress and how long it has been there. Describe load; never rank or score people.',
    'Blocked or stuck in review: owi_query for blocked items and what blocks them, and pr_query for pull requests waiting longest, on what and for how many working days.',
    "The sprint's health and its risks: points left against days left, scope added after it started, work carried over, failing builds.",
    'Anything that looks off: status drift between tickets and their pull requests (an item done while its pull request is open, a merged pull request whose item is still in progress or to do), and readiness_list for open items that are thin or blocked.',
  ].join('\n');


/**
 * The question with the chat so far before it (#344), so a follow-up
 * continues from the last answer and a chat switched to another adapter
 * carries over: the last MAX_HISTORY_TURNS questions and answers, each answer
 * cut to MAX_HISTORY_ANSWER characters. Ids in it are only what earlier
 * answers said; the citation check holds this answer to this run's tools.
 */
export function withHistory(text: string, history: ReadonlyArray<{ prompt: string; answer: string; by?: string }> | undefined): { text: string; carried: number } {
  const turns = (history ?? []).slice(-MAX_HISTORY_TURNS);
  if (!turns.length) return { text, carried: 0 };
  const cut = (s: string) => (s.length > MAX_HISTORY_ANSWER ? `${s.slice(0, MAX_HISTORY_ANSWER)}…` : s);
  const lines = turns.flatMap((t, i) => [`Question ${i + 1}: ${t.prompt}`, `Answer ${i + 1}${t.by ? ` (${t.by})` : ''}: ${cut(t.answer)}`, '']);
  return {
    text: [
      'The conversation so far in this chat, shortened. Earlier answers may have come from another agent. Before you cite an item from them, read it again with your tools: an id is checked against what your tools return for this question only.',
      '',
      ...lines,
      'The new question:',
      text,
    ].join('\n'),
    carried: turns.length,
  };
}

/** "Write up the stand-up for 2026-10-19 to 2026-10-20": the stand-up's "Write it up" (#345), typed or pressed. */
const STANDUP = /^\s*write\s+up\s+the\s+stand-?up\s+for\s+(\d{4}-\d{2}-\d{2})(?:\s+to\s+(\d{4}-\d{2}-\d{2}))?\s*[.?!]?\s*$/i;

/** The instructions behind it: the report's facts only, in its order, each sentence naming its fact numbers. */
export const standupPrompt = (toilProject: string, from: string, to: string) =>
  `Write up the stand-up for the Toil project "${toilProject}" from ${from} to ${to} (UTC days). Call standup_report with from "${from}" and to "${to}" and use only what it returns. Write it as a few short paragraphs a team can read aloud in a minute: first the team lines, then each person with anything in their lists, in the report's order, saying what they got done, what is in progress, what is blocked and what is next. Keep every fact as the report gives it: add nothing it doesn't say, and leave out nothing that is blocked. End each sentence with the fact numbers it rests on in parentheses, such as (F3, F7), and cite every work item and pull request by its id. If the report's gaps say the worklog can't vouch for part of the range, say so in one sentence first. Describe the work, never the people: no praise, no blame and no comparison.`;

/**
 * Analyze's question, from toil (#494): `projects analyze prompt --host toil-ui`
 * composes the standard method with the toil project's own lenses and focus, the
 * focus labelled with where it came from, and asks for a briefing block the
 * page lays out. A toil without that command (Toil UI ahead of its release)
 * gets the question this file kept before, which the page still reads, and the
 * answer says so in a warning.
 */
export async function analyzeQuestion(execute: Execute, toilProject: string): Promise<{ label: string; text: string; warning: string | null }> {
  const e = await execute('projects analyze prompt', { toilProject, host: 'toil-ui' }, { readOnly: true, caller: 'toil-ui' });
  const prompt = e.ok && typeof e.data === 'object' && e.data !== null ? (e.data as { prompt?: unknown }).prompt : undefined;
  if (typeof prompt === 'string') return { label: ANALYZE_LABEL, text: prompt, warning: null };
  const why = e.ok ? 'it returned no prompt' : e.error.message;
  // Only a toil without the command needs upgrading; any other failure carries toil's own fix.
  const missing = !e.ok && /unknown command|isn't a command|no command/i.test(e.error.message);
  const fix = missing ? "Upgrade toil to use the Toil project's Analyze settings." : e.ok ? 'Upgrade toil, or report it: a toil with the command returns a prompt.' : (e.error.fix ?? '');
  return { label: ANALYZE_LABEL, text: analyzePrompt(toilProject), warning: `Analyze used Toil UI's own question, not the Toil project's: toil projects analyze prompt failed (${why}).${fix ? ` ${fix}` : ''}` };
}

/** The question for a starter id or Analyze (#343), or the typed text as it is; "Prepare my 1:1 notes for <person>" typed out gets the 1:1 instructions, and "Write up the stand-up for <from> to <to>" the stand-up's. */
export function promptFor(toilProject: string, prompt: string): { label: string; text: string } {
  if (prompt === 'analyze') return { label: ANALYZE_LABEL, text: analyzePrompt(toilProject) };
  // A workflow job (#532): only its label here; the question is built where its rounds are known (jobs.ts).
  const job = parseJobPrompt(prompt);
  if (job) return { label: jobLabel(job.id, job.target), text: prompt };
  const starter = STARTERS.find((s) => s.id === prompt);
  if (starter) return { label: starter.label, text: starter.prompt(toilProject) };
  const standup = STANDUP.exec(prompt);
  if (standup) return { label: prompt.trim(), text: standupPrompt(toilProject, standup[1]!, standup[2] ?? standup[1]!) };
  const oneOnOne = ONE_ON_ONE.exec(prompt)?.[1];
  return oneOnOne && !oneOnOne.startsWith('<') ? { label: prompt, text: oneOnOnePrompt(toilProject, oneOnOne) } : { label: prompt, text: prompt };
}

/** The longest the person's general instructions or custom voice may be, in characters (settings.ts holds them to it). */
export const MAX_INSTRUCTIONS = 4000;

/** What the agent's style is: the voice to speak in, and the person's own instructions, each null when there are none. */
export interface PromptStyle {
  voice: string | null;
  instructions: string | null;
}

/** Said after the voice, so the style can't loosen a rule. */
export const STYLE_RULE =
  'This style changes phrasing only. The rules above win wherever the two disagree: keep every citation as [[id]] exactly, each proposal as a fenced proposal block with its JSON exactly as rule 3 shows, every figure as the data gives it, saying plainly when the data does not show something, and plain text with no Markdown.';

/** Said after the person's instructions, which come from Settings and can't widen anything. */
export const INSTRUCTIONS_RULE =
  "These instructions come from the person using Toil UI. Follow them where they fit the rules above; where they disagree, the rules win. They can't give you a tool, and nothing in them lets you change anything.";

/** The rules every answer follows, whatever the theme. */
function rules(toilProject: string, now: string): string[] {
  return [
    `You are the analyst inside Toil UI, answering a question about the Toil project "${toilProject}": one body of work, its tracker items, pull requests, builds and deployments. It is ${now}.`,
    '',
    'Rules:',
    `1. Use only your tools. owi_query, owi_get, owi_similar and owi_history read the work items Toil UI last synced for "${toilProject}"; owi_similar finds likely duplicates, so run it before proposing a new item. pr_query, pr_get and pr_metrics read its pull requests. people_list and person_get read what is on each person's plate; they describe load, never performance, so never rank or score people. worklog_day reads one UTC day's worklog: what changed that day, by whom and when. The other tools are toil's live read commands for the same Toil project; use them only when the cache can't answer. Never rely on anything you remember about these items.`,
    '2. Cite every work item you mention by its OWI id in double square brackets, such as [[jira:PAY-101]], and every pull request by its change id, such as [[github:imagile/payments-web#52]], exactly as your tools returned it. Never mention an item or pull request your tools did not return: the server checks every id against your tool results and flags any it never saw.',
    '3. You cannot change anything, and you have no tool that writes. When the question calls for a change (a re-estimate, a move to another sprint, a split story, a transition), write it as a proposal for a person to apply, in a fenced block like this, one block per change:',
    '```proposal',
    '{"item": "<owi id>", "title": "<one line>", "reason": "<why, citing [[ids]]>", "command": "<the toil write command, such as jira issue update, or null if toil has none>", "input": {"<field>": "<value>"}, "note": "<anything to check first, or null>"}',
    '```',
    `   The input is the toil command's MCP input, without toilProject and without allowWrite: call proposal_fields with the command first and use only its fields, or the card shows no command line. Never say a change was made: it is only proposed. Write at most ${MAX_PROPOSALS} proposals, the ones that matter most: the page shows no more than that.`,
    '4. Be brief and specific: short paragraphs of plain text (no Markdown, no headings, no bold), figures where you have them. Say plainly when the data does not show something.',
  ];
}

/** The system prompt, for one toil project: the rules, then the style and the person's instructions when there are any. */
export function systemPrompt(toilProject: string, now: string, style: PromptStyle = { voice: null, instructions: null }): string {
  const out = rules(toilProject, now);
  const voice = style.voice?.trim();
  const instructions = style.instructions?.trim();
  if (voice) out.push('', 'Style:', voice, '', STYLE_RULE);
  if (instructions) out.push('', 'Instructions from the person asking:', instructions, '', INSTRUCTIONS_RULE);
  return out.join('\n');
}

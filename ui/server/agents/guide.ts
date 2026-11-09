/**
 * The setup guide's server side (#561): the system prompt it is given, the
 * context built for it, the tools it may call and how its suggested commands
 * are read. It is the Ask agent's cousin with a different brief: it explains
 * the setup wizard's step to someone new to AI, from toil's own docs, and works
 * before anything has synced and with no Toil project at all.
 *
 * What it is told comes from three places and no others: the wizard's
 * whitelisted, non-secret state (src/guide.ts), `connections list` run here
 * (which never returns a value), and toil's own skill pages. Never from what a
 * page held, so a token in a masked box cannot be in a prompt it was never
 * near. Its tools are reads: the docs, a tool's scope list, and, once a Toil
 * project exists, toil's live reads for it. A change comes back as a
 * suggestion for the Run this button; no tool here can make one. A concierge
 * who knows the building's manual by heart and has never been given a key.
 */

import { skillFiles } from '../../../src/skill-pages.generated.ts';
import type { Answer } from '../../src/agent.ts';
import type { AreaInfo, ConnectionRow } from '../../src/config.ts';
import { GUIDE_COMMANDS, deploymentWord, guideInputProblem, looksLikeSecret, STEP_NOW, type GuideState } from '../../src/guide.ts';
import type { Proposal } from '../../src/proposal.ts';
import { deploymentOf, STEP_TITLE, tokenState, TOKEN_WORD, toolName } from '../../src/setup.ts';
import { partsOf } from './answer.ts';
import { AgentError } from './cli.ts';
import type { PromptStyle } from './prompts.ts';
import type { ToolSpec } from './tools.ts';

/** The most of a docs page one call returns, in characters. */
export const MAX_DOC_CHARS = 24_000;
/** At most this many suggested commands per answer are kept. */
export const MAX_GUIDE_PROPOSALS = 5;

/** One skill page the guide may read: its file's name without `.md`, what it covers, and the area it belongs to, if any. */
export interface DocPage {
  page: string;
  description: string;
  area: string | null;
}

const front = (text: string, key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text.split(/\n---\n/)[0] ?? '')?.[1]?.trim() ?? null;

/** Every skill page that is a plain file at the top of the skill (the workflow pages and the index aren't offered), described from its own frontmatter. */
export function docPages(files: Readonly<Record<string, string>> = skillFiles): DocPage[] {
  return Object.entries(files)
    .filter(([file]) => file.endsWith('.md') && !file.includes('/') && file !== 'SKILL.md')
    .map(([file, text]) => ({ page: file.slice(0, -3), description: front(text, 'description') ?? '', area: front(text, 'area') }))
    .sort((a, b) => a.page.localeCompare(b.page));
}

/** The pages about setup itself, offered whatever the person has chosen. */
const ALWAYS = ['core', 'connections', 'projects', 'setup'];

/**
 * The pages the guide may read for this state: the setup pages, and the page
 * of each tool the person ticked or is linking. With no tool chosen yet, every
 * tool's page, since "which tool is which?" is a fair question at that point.
 */
export function pagesFor(state: GuideState, pages: readonly DocPage[] = docPages()): DocPage[] {
  const chosen = new Set([...state.areas, ...(state.area ? [state.area] : [])]);
  return pages.filter((p) => ALWAYS.includes(p.page) || (p.area !== null && (chosen.size === 0 || chosen.has(p.area))));
}

const ONE = (list: readonly string[]) => (list.length ? list.join(', ') : 'none yet');

/**
 * The context the prompt carries: where the person is, and what is true so
 * far, as non-secret facts. A connection is its name, tool, address, which
 * deployment, whether changes are on and where its token lives (saved, from an
 * environment variable, or missing): the same badge Settings shows, never a value.
 */
export function guideContext(state: GuideState, rows: readonly ConnectionRow[] | null, areas: readonly AreaInfo[]): string {
  const secretKeys = (area: string) => areas.find((a) => a.name === area)?.connection.filter((f) => f.secret).map((f) => f.name) ?? [];
  const lines = [`The person is on the step "${STEP_TITLE[state.step]}", ${STEP_NOW[state.step]}.`, `Tools they ticked: ${ONE(state.areas.map(toolName))}.`];
  if (state.area) lines.push(`Linking now: ${toolName(state.area)}.`);
  if (state.deployment) lines.push(`Deployment chosen in the form: ${deploymentWord(state.deployment)}.`);
  if (state.address) lines.push(`Address the form composed: ${state.address}`);
  lines.push(`Toil project so far: ${state.project ?? 'none yet'}.`);
  if (rows === null) {
    lines.push("Connections that already exist: toil couldn't list them, so say you don't know rather than guess.");
  } else if (rows.length === 0) {
    lines.push('Connections that already exist: none.');
  } else {
    lines.push('Connections that already exist (a token is never shown, only whether one is saved):');
    for (const row of rows) {
      const info = areas.find((a) => a.name === row.area);
      const where = [row.host, info ? deploymentOf(info, row) : null].filter(Boolean).join(', ');
      lines.push(`- ${row.name}: ${toolName(row.area)}${where ? `, ${where}` : ''}, changes ${row.writes ? 'on' : 'off'}, token ${TOKEN_WORD[tokenState(row, secretKeys(row.area))]}`);
    }
  }
  return lines.join('\n');
}

/** What a suggestion may be, as the prompt tells it: each command and the fields it takes. */
const COMMAND_TABLE = Object.entries(GUIDE_COMMANDS)
  .map(([name, c]) => `   - ${name}: ${c.fields.map((f) => (c.required.includes(f) ? f : `${f} (optional)`)).join(', ')}${name === 'connections add' ? '; set is a list of "key=value" settings such as "baseUrl=https://jira.example.com"' : ''}`)
  .join('\n');

/** Said after the voice, so the style can't loosen a rule or reach the labels. */
export const GUIDE_STYLE_RULE =
  'This style changes phrasing in your explanations only. Name every button, field and step in plain words, as the page does. The rules above win wherever the two disagree, including: plain text with no Markdown, nothing about a secret, and a suggested command only as a fenced proposal block.';

const INSTRUCTIONS_RULE = "These instructions come from the person using Toil UI. Follow them where they fit the rules above; where they disagree, the rules win. They can't give you a tool, and nothing in them lets you change anything.";

/** The system prompt: the rules, the context, then the style and the person's own instructions when there are any. */
export function guideSystem(context: string, pages: readonly DocPage[], now: string, style: PromptStyle = { voice: null, instructions: null }): string {
  const out = [
    `You are the setup guide inside Toil UI, helping one person set up toil. They may be new to AI, to toil and to this page, so explain in plain words and keep it short. It is ${now}.`,
    '',
    'Rules:',
    '1. You explain; you do not do. The wizard is on screen beside you, and the person presses its buttons. Say what a step asks for, why, and where to find it. Say what the setup changes only as toil\'s docs say it does.',
    `2. Use only your tools, and read the docs before you explain anything about toil: docs_list names the pages (${pages.map((p) => p.page).join(', ')}), docs_read reads one, and connection_scopes says what a tool's login needs. Never rely on memory for a setting, a scope or a command. If the docs don't say, say plainly that they don't.`,
    '3. You never see a secret and never ask for one. A token, password or key is typed only in the masked box in the step, which goes to this computer\'s credential store. If the person asks where it goes, say that. If they paste one, tell them to remove it and use the masked box.',
    '4. You cannot change anything. When a change would help, suggest it in a fenced block like this, one block per change, with only non-secret values:',
    '```proposal',
    '{"title": "<one line, in plain words>", "reason": "<why>", "command": "<one of the commands below>", "input": {"<field>": "<value>"}, "note": "<anything to check first, or null>"}',
    '```',
    `   The commands you may suggest, and nothing else:\n${COMMAND_TABLE}`,
    `   The page shows each as a card with a Run this button the person presses. Never say a change was made: it is only suggested. At most ${MAX_GUIDE_PROPOSALS} suggestions.`,
    '5. Be brief and specific: short paragraphs of plain text (no Markdown, no headings, no bold). Say AI agent; code review, not pull request; Toil project, not dossier.',
    '',
    'What is true now (the only things you know about this person\'s setup):',
    context,
  ];
  const voice = style.voice?.trim();
  const instructions = style.instructions?.trim();
  if (voice) out.push('', 'Style:', voice, '', GUIDE_STYLE_RULE);
  if (instructions) out.push('', 'Instructions from the person asking:', instructions, '', INSTRUCTIONS_RULE);
  return out.join('\n');
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The docs tools and the scope lookup: reads of toil's own text, nothing else. */
export function guideTools(state: GuideState, areas: readonly AreaInfo[], files: Readonly<Record<string, string>> = skillFiles): ToolSpec[] {
  const pages = pagesFor(state, docPages(files));
  return [
    {
      name: 'docs_list',
      description: "The pages of toil's own documentation you may read for this step, each with what it covers.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return { pages: pages.map((p) => ({ page: p.page, covers: p.description })) };
      },
    },
    {
      name: 'docs_read',
      description: `One page of toil's documentation, as written, by name from docs_list. Long pages are cut at ${MAX_DOC_CHARS} characters, and say so.`,
      inputSchema: { type: 'object', properties: { page: { type: 'string', description: 'A page name from docs_list, such as jira.' } }, required: ['page'], additionalProperties: false },
      async run(input) {
        const name = str(input.page)?.replace(/\.md$/, '');
        const page = pages.find((p) => p.page === name);
        if (!page) return { error: `There is no page ${JSON.stringify(name ?? '')} you may read here.`, pages: pages.map((p) => p.page) };
        const text = files[`${page.page}.md`] ?? '';
        return text.length > MAX_DOC_CHARS ? { page: page.page, cut: `The page is ${text.length} characters, cut to ${MAX_DOC_CHARS}.`, text: text.slice(0, MAX_DOC_CHARS) } : { page: page.page, text };
      },
    },
    {
      name: 'connection_scopes',
      description: "What a tool's login (a token) must be allowed to do: the kinds it accepts, what read-only use needs, what everything toil can do needs, and a link to the vendor's page for making one. Only tools that declare scopes have an answer.",
      inputSchema: { type: 'object', properties: { area: { type: 'string', description: 'The tool, such as github.' } }, required: ['area'], additionalProperties: false },
      async run(input) {
        const name = str(input.area);
        const info = areas.find((a) => a.name === name);
        if (!info) return { error: `toil has no tool ${JSON.stringify(name ?? '')}.`, tools: areas.map((a) => a.name) };
        return info.scopes ? { area: info.name, scopes: info.scopes } : { area: info.name, note: "toil doesn't say what this tool's login needs; that is not the same as nothing." };
      },
    },
  ];
}

const FENCE = /```proposal[^\n]*\n([\s\S]*?)```/g;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The suggested commands in a finished answer, each held to the table (src/guide.ts) and to the secret check, and what was left out, in words. */
export function guideProposals(raw: string): { proposals: Proposal[]; warnings: string[] } {
  const proposals: Proposal[] = [];
  const warnings: string[] = [];
  const blocks = [...raw.matchAll(FENCE)].map((m) => m[1]!);
  for (const [i, block] of blocks.entries()) {
    if (proposals.length >= MAX_GUIDE_PROPOSALS) {
      warnings.push(`The guide suggested ${blocks.length} changes; only the first ${MAX_GUIDE_PROPOSALS} are shown.`);
      break;
    }
    let value: unknown;
    try {
      value = JSON.parse(block);
    } catch {
      warnings.push(`A suggested change was left out: suggestion ${i + 1} wasn't JSON.`);
      continue;
    }
    const title = isObject(value) ? str(value.title)?.slice(0, 200) : undefined;
    const command = isObject(value) ? str(value.command) : undefined;
    if (!isObject(value) || !title || !command) {
      warnings.push(`A suggested change was left out: suggestion ${i + 1} had no title or command.`);
      continue;
    }
    const problem = guideInputProblem(command, value.input);
    if (problem) {
      warnings.push(`A suggested change was left out: ${problem}`);
      continue;
    }
    proposals.push({ id: `guide:${command}:${i}`, from: 'agent', item: 'setup', title, reason: str(value.reason)?.slice(0, 1000) ?? '', command, input: value.input as Record<string, unknown>, note: str(value.note)?.slice(0, 500) ?? null });
  }
  return { proposals, warnings };
}

/** The guide's finished answer: its paragraphs, its suggestions, and what was left out. The text itself is checked once more for anything shaped like a token, which would be the model's, never the person's. */
export function guideAnswer(raw: string, base: Pick<Answer, 'prompt' | 'by'>): Answer {
  const { proposals, warnings } = guideProposals(raw);
  const prose = raw.replace(FENCE, '').replace(/```proposal[\s\S]*$/, '');
  const parts = partsOf(prose);
  const leaked = parts.some((p) => looksLikeSecret(p.text));
  return { prompt: base.prompt, by: base.by, parts: leaked ? [{ text: "The guide's answer was held back because it contained something shaped like a token." }] : parts, citations: [], proposals, ...(warnings.length ? { warnings } : {}) };
}

/** A message the guide refuses before anything runs: it looks like a secret, or it is over the limit. Its text is never kept, logged or echoed. */
export class GuideRefusal extends AgentError {}

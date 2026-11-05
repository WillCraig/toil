/**
 * From a model's text to an `Answer` (#251), and the server-side checks on it:
 *
 * - **Citations.** The model cites items as `[[<owi id>]]`. Every id an answer
 *   names (cited, written bare as `<connection>:<key>`, or a tracker key such
 *   as PAY-101) must be one its tool calls returned, by the ledger
 *   (tools.ts). Anything else is listed in `unverified` and the pane flags it,
 *   because an id the tools never returned is one the model made up or
 *   remembered. An answer that read items and cites none gets a warning too.
 * - **Writes as proposals.** A change the model wants is a fenced
 *   ```` ```proposal ```` block of JSON. It becomes a `Proposal` the pane shows
 *   as a card, its command line rendered by the one safe renderer
 *   (src/proposal.ts). The command must be one toil's registry has and marks
 *   as a write; otherwise the card says toil has no such command. Nothing here
 *   or anywhere in the agent runs it: the agent's tools are reads only.
 *
 * The shape the model is asked to write is in prompts.ts. An editor with a
 * red pen and no publishing rights.
 */

import { readBriefing } from '../../../src/core/brief/answer.ts';
import { citationsOf, type Answer, type AnswerPart } from '../../src/agent.ts';
import { POSITIONAL_FIELDS, type Proposal } from '../../src/proposal.ts';
import type { Ledger } from './tools.ts';

/** A write command in toil's registry: the fields its input takes, and the ones it needs. */
export interface WriteCommand {
  name: string;
  fields: ReadonlySet<string>;
  required: readonly string[];
}

/** toil's write commands, by name, from its registry. */
export function writeCommands(registry: ReadonlyArray<{ name: string; writes: boolean; inputSchema: Record<string, unknown> }>): Map<string, WriteCommand> {
  return new Map(
    registry
      .filter((c) => c.writes)
      .map((c) => {
        const s = c.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
        return [c.name, { name: c.name, fields: new Set(Object.keys(s.properties ?? {})), required: s.required ?? [] }];
      }),
  );
}

export interface Finish {
  toilProject: string;
  prompt: string;
  by: string;
  ledger: Ledger;
  /** toil's write commands, by name: a proposal may name only one of these. */
  writes: ReadonlyMap<string, WriteCommand>;
}

const FENCE = /```proposal[^\n]*\n([\s\S]*?)```/g;
const OPEN_FENCE = /```proposal[\s\S]*$/;
const BARE_ID = /(?<![[\w/])([a-z][a-z0-9_-]*):([A-Za-z0-9][\w.#/-]*[\w#])/g;
const TRACKER_KEY = /(?<![\w:/-])([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
/** At most this many proposals per answer are kept (Bounds); the rest are listed as dropped. */
export const MAX_PROPOSALS = 10;

/** The paragraphs of a text, with any half-written citation at its end held back. */
export function partsOf(text: string): AnswerPart[] {
  // The pane shows plain text, so Markdown emphasis the model adds anyway is taken off rather than shown as asterisks.
  const tidy = text
    .replace(/\[\[[^\]]*$/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1');
  return tidy
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ text: p }));
}

/** The answer so far, while it streams: proposal blocks (whole or half-written) are held back until the end. */
export function partial(text: string, base: Pick<Answer, 'prompt' | 'by'>): Answer {
  const prose = text.replace(FENCE, '').replace(OPEN_FENCE, '');
  const parts = partsOf(prose);
  return { prompt: base.prompt, by: base.by, parts, citations: citationsOf(parts), proposals: [] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** One proposal block, checked; a reason string when it can't be one. */
export function proposalOf(raw: string, f: Pick<Finish, 'toilProject' | 'writes'>, index: number): Proposal | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return `proposal ${index + 1} wasn't JSON`;
  }
  if (!isObject(value)) return `proposal ${index + 1} wasn't a JSON object`;
  const item = text(value.item, 200);
  const title = text(value.title, 200);
  if (!item || !title) return `proposal ${index + 1} had no item or title`;
  const reason = text(value.reason, 2000) ?? '';
  let note = text(value.note, 1000);
  let command: string | null = null;
  let input: Record<string, unknown> | null = null;
  const named = text(value.command, 100);
  if (named) {
    const write = f.writes.get(named);
    if (!write) {
      note = [`toil has no write command "${named}", so there is nothing to run; make this change by hand.`, note].filter(Boolean).join(' ');
    } else if (!isObject(value.input)) {
      note = [`The agent named toil ${named} but gave no input for it, so there is no command line to show.`, note].filter(Boolean).join(' ');
    } else {
      // The toil project is this one, whatever the model wrote: a proposal never reaches past the toil project it is about.
      const rest = Object.fromEntries(Object.entries(value.input).filter(([k]) => k !== 'toilProject' && k !== 'allowWrite'));
      const unknown = Object.keys(rest).filter((k) => !write.fields.has(k));
      const absent = write.required.filter((k) => !(k in rest));
      if (unknown.length || absent.length) {
        // A command line toil would refuse is worse than none: say what was wrong instead.
        // A positional argument is named as --help shows it (<key>), every other field as its flag.
        const arg = (k: string) => (POSITIONAL_FIELDS.get(write.name)?.includes(k) ? `<${k}>` : `--${k}`);
        const why = [unknown.length ? `has no ${unknown.map((k) => `--${k}`).join(', ')}` : '', absent.length ? `needs ${absent.map(arg).join(', ')}` : ''].filter(Boolean).join(' and ');
        note = [`The agent's input doesn't fit toil ${write.name}, which ${why}, so there is no command line to show; see toil ${write.name} --help.`, note].filter(Boolean).join(' ');
      } else {
        command = write.name;
        input = write.fields.has('toilProject') ? { toilProject: f.toilProject, ...rest } : rest;
      }
    }
  }
  return { id: `agent:${item}:${command ?? 'none'}:${index}`, from: 'agent', item, title, reason, command, input, note };
}

/** The ids a text names: cited, bare `<connection>:<key>` for a connection the toil project has, and tracker keys. */
export function named(text: string, connections: ReadonlySet<string>): { cited: string[]; bare: string[]; keys: string[] } {
  const cited = citationsOf([{ text }]);
  const outside = text.replace(/\[\[[^\]]+\]\]/g, ' ');
  const bare = [...outside.matchAll(BARE_ID)].filter((m) => connections.has(m[1]!)).map((m) => `${m[1]}:${m[2]}`);
  const keys = [...outside.matchAll(TRACKER_KEY)].map((m) => m[1]!);
  return { cited, bare, keys };
}

/** The finished answer: parts, citations, proposals, and what the checks flagged. */
export function finish(raw: string, f: Finish): Answer {
  const blocks = [...raw.matchAll(FENCE)].map((m) => m[1]!);
  const stripped = raw.replace(FENCE, '').replace(OPEN_FENCE, '');
  // Analyze's briefing block (#494) is data for the page, not text for the pane: it's lifted out, and its ids are checked with the rest.
  const read = stripped.includes('```briefing') ? readBriefing(stripped) : null;
  const prose = read ? read.rest : stripped;
  const parts = partsOf(prose);
  const warnings: string[] = [];
  const proposals: Proposal[] = [];
  for (const [i, block] of blocks.entries()) {
    if (proposals.length >= MAX_PROPOSALS) {
      warnings.push(`The agent suggested ${blocks.length} changes; only the first ${MAX_PROPOSALS} are shown.`);
      break;
    }
    const p = proposalOf(block, f, i);
    if (typeof p === 'string') warnings.push(`A suggested change was left out: ${p}.`);
    else proposals.push(p);
  }

  const ledgerIds = f.ledger.ids;
  const connections = new Set([...ledgerIds].map((id) => id.slice(0, id.indexOf(':'))));
  const keyOf = new Set([...ledgerIds].map((id) => id.slice(id.indexOf(':') + 1)));
  const unverified = new Set<string>();
  // Every field of the briefing the page shows with citations: its ids and its sentences alike.
  const b = read?.briefing;
  const briefed = b ? [b.recommendation, b.onTrack ?? '', ...b.changed, ...b.reasons.flatMap((r) => [r.line, r.text ?? '', ...r.items.flatMap((i) => [i.id, i.why, i.next ?? ''])]), ...b.leftOut.flatMap((l) => [l.id, l.why])] : [];
  const all = [...parts.map((p) => p.text), ...proposals.map((p) => p.reason), ...briefed].join('\n\n');
  const { cited, bare, keys } = named(all, connections);
  for (const id of [...cited, ...bare, ...proposals.map((p) => p.item)]) if (!ledgerIds.has(id)) unverified.add(id);
  // A bare tracker key (PAY-999) in a project the tools returned items from must be one of those items. UTF-8 is not a ticket.
  const projects = new Set([...keyOf].map((k) => /^([A-Z][A-Z0-9]{1,9})-\d+$/.exec(k)?.[1]).filter(Boolean));
  for (const key of keys) if (projects.has(key.split('-')[0]) && !keyOf.has(key) && ![...unverified].some((id) => id.endsWith(`:${key}`))) unverified.add(key);

  // A briefing's items and the [[ids]] in its sentences are citations too, so an answer that is only a briefing still cites what it rests on.
  const citations = [...new Set([...citationsOf(parts), ...(b ? [...b.reasons.flatMap((r) => r.items.map((i) => i.id)), ...citationsOf(briefed.map((text) => ({ text })))] : [])])];
  if (unverified.size) warnings.unshift(`This answer names ${unverified.size === 1 ? 'an item' : `${unverified.size} items`} its tools never returned: ${[...unverified].join(', ')}. Treat ${unverified.size === 1 ? 'it' : 'them'} as unverified.`);
  if (read?.problems.length) warnings.push(...read.problems.map((p) => `The briefing: ${p}`));
  if (parts.length && !citations.length && !read?.briefing && ledgerIds.size) warnings.push('This answer cites none of the items its tools read, so nothing in it is traced to a source.');
  if (parts.length && !ledgerIds.size) warnings.push("The agent's tools returned no work items, so this answer rests on none.");

  return { prompt: f.prompt, by: f.by, parts, citations, proposals, unverified: [...unverified], warnings, ...(read ? { briefing: read.briefing, briefingProblems: read.problems } : {}) };
}

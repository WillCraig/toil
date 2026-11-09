/**
 * The setup guide's pure parts (#561): what the wizard may tell the AI agent
 * about where the person is, the check that keeps a pasted secret out of the
 * chat, the questions each step offers, and the one table of what the guide's
 * suggested commands may be. The page and the server both import this file, so
 * the page's refusal and the server's cannot drift apart: what is refused in
 * one is refused in the other. Nothing here reads or sends anything.
 *
 * The guide's context is a short list of non-secret facts, built from a
 * whitelist (areas chosen, the step, a deployment, an address, a Toil project's
 * name), never from what a form holds. A secret box and a question box are
 * different boxes, and this is the wall between them, filed in triplicate.
 */

import { checkSecret } from '../../src/core/secret-input.ts';
import { SETUP_STEPS, toolName, type SetupStep } from './setup.ts';

/** What the page and the server say when a message looks like a token. Said in these words, never with the text. */
export const GUIDE_REFUSAL = 'That looks like a token. Type it in the masked box in the step instead; the guide never needs it.';
export const GUIDE_REFUSAL_FIX = 'Nothing was sent. Remove it from the question, then ask again.';

/** The longest question the guide takes, in characters. */
export const GUIDE_MAX = 2000;

/** Prefixes of the credentials people most often paste: GitHub, Atlassian, GitLab, Slack and AWS, plus bearer headers, JWTs and private keys. */
const SHAPES: readonly RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/,
  /\bATATT[A-Za-z0-9_=-]{10,}/,
  /\bglpat-[A-Za-z0-9_-]{10,}/,
  /\bxox[abprso]-[A-Za-z0-9-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // https://user:secret@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

/** `password: hunter2`, `token=abc123...`: a label that says what follows is a secret, and a value that looks like one. */
const LABELLED = /\b(?:password|passwd|pwd|secret|token|api[ _-]?key|apikey)\b\s*(?:is\s*)?[:=]\s*["'`]?([^\s"'`]{6,})/gi;

const TRIM = /^[\s"'`()[\]<>{},.;:?!]+|[\s"'`()[\]<>{},.;:?!]+$/g;

/** A long run of letters and digits with enough variety to be a key rather than a word. */
function keyShaped(word: string): boolean {
  if (word.length < 28 || !/^[A-Za-z0-9+/_=-]+$/.test(word)) return false;
  if (/^[0-9a-f]{32,}$/i.test(word)) return true;
  return /[A-Za-z]/.test(word) && /\d/.test(word) && new Set(word).size >= 10;
}

/**
 * Whether a message looks like it carries a secret. Conservative on purpose:
 * a question that trips it is refused whole, and the person is told why and
 * where the token goes instead. It runs `checkSecret()` (the paste check every
 * way of entering a secret uses) on the message, each word and each pair of
 * words, which finds a `Bearer ` or `TOKEN=` wrapper, then looks for the usual
 * credential prefixes, a labelled value, and one long key-shaped word.
 */
export function looksLikeSecret(message: string): boolean {
  if (SHAPES.some((s) => s.test(message))) return true;
  for (const m of message.matchAll(LABELLED)) {
    const value = m[1]!;
    if (/\d/.test(value) || value.length >= 16) return true;
  }
  const words = message.split(/\s+/).map((w) => w.replace(TRIM, '')).filter(Boolean);
  if (words.some(keyShaped)) return true;
  const pieces = [message.trim(), ...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
  return pieces.some((p) => {
    const c = checkSecret(p, { empty: 'skip' });
    return c.status === 'ok' && c.wrapper !== null && c.wrapper.withoutLength >= 8;
  });
}

/** The steps the guide may be told about: the wizard's own. */
export type GuideStep = SetupStep;

/**
 * What the guide is told about the wizard, and all of it. Every field is a
 * name or an address the person typed into a plain box, never a secret.
 */
export interface GuideState {
  step: GuideStep;
  /** The tools ticked, by area name. */
  areas: string[];
  /** The tool the person is linking now. */
  area?: string;
  /** Cloud or Data Center, as the form's choice names it. */
  deployment?: string;
  /** The address the form composed, as a plain address with no login in it. */
  address?: string;
  /** The Toil project made or chosen so far. */
  project?: string;
}

/** One question to the guide: the chat it belongs to, the question, where the person is, and how to sound. */
export interface GuideRequest {
  chat: string;
  message: string;
  state: GuideState;
  theme?: string;
  voice?: boolean;
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DEPLOYMENT = /^[A-Za-z][A-Za-z0-9 .-]{0,39}$/;

/**
 * An address as a plain address: https or http, a host and a path, no login,
 * no query and no fragment, and nothing that looks like a secret. A bare host
 * (`jira.imagile.dev`) is read as https. Null for anything else, so a half
 * typed or odd address is left out, never guessed at.
 */
export function cleanAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 200 || looksLikeSecret(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !url.hostname.includes('.')) return null;
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

/** A guide state's fields, from a connection form's non-secret settings and the wizard's own state. Nothing else is read from either. */
export interface GuideInputs {
  step: GuideStep;
  areas: readonly string[];
  area?: string | undefined;
  /** The form's non-secret settings as it would send them; only `deployment` and `baseUrl` are read from it. */
  draft?: Readonly<Record<string, unknown>> | undefined;
  project?: string | null | undefined;
}

/** The state the page sends: a whitelist of the wizard's non-secret fields, cleaned the way the server cleans it. */
export function guideStateOf(i: GuideInputs): GuideState {
  const deployment = typeof i.draft?.deployment === 'string' && DEPLOYMENT.test(i.draft.deployment) ? i.draft.deployment : undefined;
  const address = cleanAddress(i.draft?.baseUrl);
  return {
    step: i.step,
    areas: i.areas.filter((a) => NAME.test(a)),
    ...(i.area && NAME.test(i.area) ? { area: i.area } : {}),
    ...(deployment ? { deployment } : {}),
    ...(address ? { address } : {}),
    ...(i.project && NAME.test(i.project) ? { project: i.project } : {}),
  };
}

/**
 * A state from a request body, held to the same shape: an unknown key, a wrong
 * type or a name that isn't an area name is refused with the reason, never
 * dropped quietly, so a page that sends more than it should hears about it.
 * Area names are checked against the registry's by the caller.
 */
export function readGuideState(raw: unknown): GuideState | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'The guide takes a state: { step, areas }.';
  const body = raw as Record<string, unknown>;
  const known = new Set(['step', 'areas', 'area', 'deployment', 'address', 'project']);
  const extra = Object.keys(body).filter((k) => !known.has(k));
  if (extra.length) return `The guide's state takes step, areas, area, deployment, address and project, not ${extra.join(', ')}.`;
  if (typeof body.step !== 'string' || !(SETUP_STEPS as readonly string[]).includes(body.step)) return `The guide's step is one of ${SETUP_STEPS.join(', ')}.`;
  if (!Array.isArray(body.areas) || body.areas.length > 40 || body.areas.some((a) => typeof a !== 'string' || !NAME.test(a))) return 'The guide\'s areas are a list of area names such as "jira".';
  const out: GuideState = { step: body.step as GuideStep, areas: body.areas as string[] };
  if (body.area !== undefined) {
    if (typeof body.area !== 'string' || !NAME.test(body.area)) return 'The guide\'s area is an area name such as "jira".';
    out.area = body.area;
  }
  if (body.deployment !== undefined) {
    if (typeof body.deployment !== 'string' || !DEPLOYMENT.test(body.deployment)) return "The guide's deployment is a short name such as Cloud or Data Center.";
    out.deployment = body.deployment;
  }
  if (body.address !== undefined) {
    // An address with a login in it, or one that looks like a secret, is dropped as the page would have: it is context, not a reason to refuse the question.
    const address = cleanAddress(body.address);
    if (address) out.address = address;
  }
  if (body.project !== undefined) {
    if (typeof body.project !== 'string' || !NAME.test(body.project)) return 'The guide\'s Toil project is a name such as "payments".';
    out.project = body.project;
  }
  return out;
}

/** What the form's deployment values mean, in words: toil says `server` for what the vendor calls Data Center (or on-premises). */
export const deploymentWord = (value: string): string => (value === 'cloud' ? 'Cloud' : value === 'server' ? 'Data Center (the one your organization hosts; toil calls it server)' : value);

/** The areas that come as Cloud or Data Center, so a question about the choice is worth offering. */
const TWO_DEPLOYMENTS = new Set(['jira', 'confluence', 'bitbucket', 'ado']);

/** The questions a step offers before anyone types, in plain words. */
export function guideStarters(step: GuideStep, area?: string): string[] {
  switch (step) {
    case 'tools':
      return ['Which tools should I pick first?', 'What does toil do with these tools?'];
    case 'connect': {
      const tool = area ? toolName(area) : 'this tool';
      return [
        'Which scopes does my token need?',
        `Where do I find the address for ${tool}?`,
        ...(area === 'jira' ? ['Where do I find my Jira site name?'] : []),
        ...(!area || TWO_DEPLOYMENTS.has(area) ? ['Cloud or Data Center?'] : []),
      ];
    }
    case 'project':
      return ['What is a Toil project?', 'Should I add a folder or a repository address?'];
    case 'fields':
      return ['What does Sprint mean here?', 'What are Jira fields, and why does toil read them?'];
    default:
      return [];
  }
}

/** What the guide's context line says the person is doing, in words the prompt and a test can both read. */
export const STEP_NOW: Record<GuideStep, string> = {
  welcome: 'reading the welcome screen',
  helper: 'choosing an AI agent',
  tools: 'choosing which tools to link',
  connect: 'linking a tool: entering its address and, in a masked box, its login',
  project: 'making or choosing a Toil project',
  fields: "choosing which of Jira's fields toil should learn",
  done: 'finished',
};

/**
 * What a suggested command may be (the guide proposes, a person presses Run
 * this): the wizard's own commands, with the fields each takes and which are
 * positional on a terminal. Run through the same allowlisted config path the
 * wizard's buttons use; a command that is not here is not offered a button.
 * `secret` fields don't exist: no command here takes one.
 */
export interface GuideCommand {
  fields: readonly string[];
  required: readonly string[];
  positional: readonly string[];
}

export const GUIDE_COMMANDS: Readonly<Record<string, GuideCommand>> = {
  'connections add': { fields: ['name', 'area', 'set'], required: ['name', 'area'], positional: ['name'] },
  'projects init': { fields: ['name', 'description'], required: ['name'], positional: ['name'] },
  'projects add-repo': { fields: ['toilProject', 'location'], required: ['toilProject', 'location'], positional: ['toilProject', 'location'] },
  'projects link': { fields: ['toilProject', 'area', 'connection'], required: ['toilProject', 'area'], positional: ['toilProject', 'area'] },
};

const flagOf = (key: string) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const single = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

/**
 * The line a suggested command would type, shown beside Run this: the
 * positional arguments first, then each flag, every value single quoted. Null
 * when the command is not one the guide may suggest or a value holds a line break.
 */
export function guideLine(command: string, input: Record<string, unknown>): string | null {
  const spec = GUIDE_COMMANDS[command];
  if (!spec) return null;
  const text = (v: unknown) => (typeof v === 'string' && !/[\r\n\0]/.test(v) ? v : null);
  const args: string[] = [];
  for (const k of spec.positional) {
    const v = text(input[k]);
    if (v === null) return null;
    args.push(single(v));
  }
  for (const [k, v] of Object.entries(input)) {
    if (spec.positional.includes(k)) continue;
    if (k === 'set') {
      if (!Array.isArray(v)) return null;
      for (const s of v) {
        const t = text(s);
        if (t === null) return null;
        args.push('--set', single(t));
      }
      continue;
    }
    const t = text(v);
    if (t === null) return null;
    args.push(flagOf(k), single(t));
  }
  return ['toil', command, ...args].join(' ');
}

/** Whether a suggested command's input may be run as it stands: every field known, every required one present, every value text and none a secret. */
export function guideInputProblem(command: string, input: unknown): string | null {
  const spec = GUIDE_COMMANDS[command];
  if (!spec) return `toil ${command} isn't one of the commands the guide may suggest.`;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'It gave no input.';
  const body = input as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !spec.fields.includes(k));
  if (unknown.length) return `toil ${command} has no ${unknown.join(', ')}.`;
  const absent = spec.required.filter((k) => typeof body[k] !== 'string' || body[k] === '');
  if (absent.length) return `toil ${command} needs ${absent.join(', ')}.`;
  for (const [k, v] of Object.entries(body)) {
    if (k === 'set') {
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !/^[A-Za-z][A-Za-z0-9]*=/.test(s))) return 'set takes settings written key=value.';
    } else if (typeof v !== 'string') return `${k} must be text.`;
  }
  const flat = Object.values(body).flatMap((v) => (Array.isArray(v) ? v : [v])).join('\n');
  return looksLikeSecret(flat) ? 'A value in it looks like a token, which a command here never takes.' : null;
}

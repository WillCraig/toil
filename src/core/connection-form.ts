/**
 * What a connection form asks, and when it is allowed to be saved (#561), as
 * pure functions of an area's description and what the person has entered so
 * far. Toil UI's Settings page and its setup wizard are both this form, and
 * both read the same few functions, so they ask the same things in the same
 * words. The rules come from the area itself: its `choices`, the keys each
 * `variants` entry requires or uses, `appliesTo`, and its credential kinds.
 * Nothing is hardcoded per area here, and nothing is sent anywhere: a
 * validator that phoned a vendor to ask whether your address was real would be
 * a reasonable idea in an organization that has not met one.
 *
 * Nothing here repeats a secret. A message names a kind of token by what the
 * area declares ("a fine-grained token"), never by any part of the value.
 */

import { checkSecret, type SecretRules } from './secret-input.js';

export interface FormOption {
  label: string;
  value: string | null;
  when?: Readonly<Record<string, string>>;
  placeholder?: string;
  compose?: { prefix: string; suffix?: string; label: string; placeholder: string };
  hosts?: readonly string[];
  expectPath?: string;
}

export interface FormChoices {
  question?: string;
  required?: boolean;
  options: readonly FormOption[];
}

export interface FormField {
  name: string;
  description: string | null;
  secret: boolean;
  password: boolean;
  default: string | null;
  required: boolean;
  choices?: FormChoices;
  appliesTo?: readonly string[];
  requiredFor?: readonly string[];
}

export interface FormArea {
  name: string;
  /** The setting whose value picks the variant (`deployment`), when the area has variants. */
  variantBy?: string;
  connection: readonly FormField[];
  scopes?: { secret: string; kinds: ReadonlyArray<{ id: string; label: string; tokenPrefix: string | null }>; otherPrefixes?: Readonly<Record<string, string>> };
}

/** Everything the person has entered: the picked option per choice setting, the text typed per setting, and the secrets. */
export interface FormState {
  name: string;
  /** Index into `field.choices.options`, by setting. */
  picks: Record<string, number>;
  text: Record<string, string>;
  secrets: Record<string, string>;
  /** Which kind of token the person says they hold (a credential kind's id). */
  tokenKind: string | null;
}

export type Need = 'required' | 'optional' | 'hidden';

export interface Problem {
  level: 'error' | 'warning' | 'note';
  message: string;
  fix?: string;
  /** Pressing "switch" picks this option of this choice setting. */
  switchTo?: { field: string; index: number };
  /** Pressing "switch" selects this credential kind. */
  switchToken?: string;
}

/** What is in the way of saving: the first one is the line shown beside the disabled button. */
export interface Blocker {
  field: string;
  reason: string;
}

export interface Report {
  needs: Record<string, Need>;
  /** The value each setting would be saved with, for the applicable ones only. */
  settings: Record<string, string>;
  problems: Record<string, Problem[]>;
  blockers: Blocker[];
}

export const CONNECTION_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emptyState = (name = ''): FormState => ({ name, picks: {}, text: {}, secrets: {}, tokenKind: null });

const fieldOf = (area: FormArea, name: string) => area.connection.find((f) => f.name === name);

/** `*.atlassian.net` matches a site name under it, not `atlassian.net` itself. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  return pattern.startsWith('*.') ? h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1 : h === pattern.toLowerCase();
}

/** What a person typed into a "site name" box, cleaned of the scheme, the suffix and any path. */
function cleanWord(text: string, o: FormOption): string {
  let t = text.trim();
  const prefix = o.compose?.prefix ?? '';
  if (prefix && t.toLowerCase().startsWith(prefix.toLowerCase())) t = t.slice(prefix.length);
  t = t.replace(/^[a-z]+:\/\//i, '');
  t = t.split(/[/?#]/)[0] ?? '';
  const suffix = o.compose?.suffix ?? '';
  if (suffix && t.toLowerCase().endsWith(suffix.toLowerCase())) t = t.slice(0, t.length - suffix.length);
  return t;
}

/** The options of a choice setting that apply, given the other settings' values (`when`). */
function visibleOptions(area: FormArea, field: FormField, state: FormState, depth: number): Array<{ option: FormOption; index: number }> {
  const all = (field.choices?.options ?? []).map((option, index) => ({ option, index }));
  return all.filter(({ option }) => Object.entries(option.when ?? {}).every(([k, v]) => depth < 4 && valueOf(area, k, state, depth + 1) === v));
}

/** The option a choice setting has now: the person's pick if it still applies, else the only one left, else the first unless the person must choose. */
export function selectedOption(area: FormArea, field: FormField, state: FormState, depth = 0): { option: FormOption; index: number } | null {
  const visible = visibleOptions(area, field, state, depth);
  const picked = visible.find((v) => v.index === state.picks[field.name]);
  if (picked) return picked;
  if (visible.length === 1) return visible[0]!;
  if (field.choices?.required) return null;
  return visible[0] ?? null;
}

/** The options a form shows as radio buttons for a setting: those that apply now. */
export function shownOptions(area: FormArea, field: FormField, state: FormState): Array<{ option: FormOption; index: number }> {
  return visibleOptions(area, field, state, 0);
}

/** A setting's value as it would be saved, before normalising; '' for none. */
function valueOf(area: FormArea, name: string, state: FormState, depth = 0): string {
  const field = fieldOf(area, name);
  if (!field) return '';
  if (!field.choices) return (state.text[name] ?? '').trim();
  const sel = selectedOption(area, field, state, depth);
  if (!sel) return '';
  if (sel.option.value !== null) return sel.option.value;
  const text = state.text[name] ?? '';
  if (sel.option.compose) {
    const word = cleanWord(text, sel.option);
    return word === '' ? '' : `${sel.option.compose.prefix}${word}${sel.option.compose.suffix ?? ''}`;
  }
  return text.trim();
}

/** The label of the chosen variant, for "Needed for Cloud". */
export function variantLabel(area: FormArea, state: FormState): string | null {
  if (!area.variantBy) return null;
  const f = fieldOf(area, area.variantBy);
  const sel = f ? selectedOption(area, f, state) : null;
  return sel?.option.label ?? null;
}

/** Whether every choice the person must make has been made. */
export function chosen(area: FormArea, state: FormState): boolean {
  return area.connection.every((f) => !f.choices?.required || selectedOption(area, f, state) !== null);
}

/** Whether a setting is asked for, optional, or has nothing to do with the chosen variant. Derived from the area's `variants` and `appliesTo`. */
export function needOf(area: FormArea, field: FormField, state: FormState): Need {
  const by = area.variantBy ? fieldOf(area, area.variantBy) : undefined;
  const variant = by ? valueOf(area, by.name, state) : '';
  // A variant the person picks from radios gates the rest of the form until it is picked. One they type (a database's engine) gates nothing until typed.
  if (by?.choices && field.name !== by.name && variant === '') return 'hidden';
  if (field.appliesTo && variant !== '' && !field.appliesTo.includes(variant)) return 'hidden';
  if (field.required || (variant !== '' && field.requiredFor?.includes(variant))) return 'required';
  return 'optional';
}

/** What the box under a radio shows: the cleaned word for a composed address, else what was typed. */
export function boxText(area: FormArea, field: FormField, state: FormState): string {
  const sel = selectedOption(area, field, state);
  const text = state.text[field.name] ?? '';
  return sel?.option.compose ? cleanWord(text, sel.option) : text;
}

/** Strips what toil adds itself or what only decorates: a trailing slash and, unless the option says it stays, a `/rest/api…` tail. */
export function normalizeUrl(url: string, pathStays: boolean): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!pathStays) u = u.replace(/\/rest\/api(\/.*)?$/i, '');
  return u;
}

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.(localhost|test|local))$/i;

function urlProblems(area: FormArea, field: FormField, state: FormState, value: string): Problem[] {
  const out: Problem[] = [];
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return [{ level: 'error', message: "That isn't a web address.", fix: 'Start it with https://, for example https://jira.imagile.dev.' }];
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return [{ level: 'error', message: `Addresses here start with https://, not ${u.protocol}//.`, fix: 'Use the https:// address of the service.' }];
  if (u.protocol === 'http:') {
    if (PRIVATE_HOST.test(u.hostname)) out.push({ level: 'warning', message: 'This address is not encrypted (http://). That is fine for a test server on this machine or your own network, and nowhere else.' });
    else return [{ level: 'error', message: 'This address is not encrypted (http://), so your login would cross the network readable by anyone on the way.', fix: 'Use the https:// address.' }];
  }
  if (u.username || u.password) return [{ level: 'error', message: 'The address has a user name or password in it.', fix: 'Remove it. The login goes in its own box, and stays out of the address.' }];
  if (u.search || u.hash) out.push({ level: 'error', message: `The address has ${u.search ? 'a query (?…)' : 'a fragment (#…)'} in it, which toil would send on every request.`, fix: 'Remove everything from the ? or # onward.' });
  const sel = selectedOption(area, field, state);
  const expect = sel?.option.expectPath;
  if (value.replace(/\/+$/, '') !== value) out.push({ level: 'note', message: 'The trailing / is dropped when this is saved.' });
  if (!expect && /\/rest\/api(\/|$)/i.test(u.pathname)) out.push({ level: 'note', message: "That's an API path. toil adds it itself, so it is dropped when this is saved." });
  if (expect && sel?.option.value === null && !u.pathname.replace(/\/+$/, '').endsWith(expect)) {
    out.push({ level: 'warning', message: `The REST address usually ends in ${expect}.`, fix: `Check it, for example ${sel.option.placeholder ?? `…${expect}`}.` });
  }
  // The chosen option against the host: a Cloud address under "Data Center", or the reverse.
  for (const set of area.connection) {
    if (!set.choices) continue;
    const current = selectedOption(area, set, state);
    if (!current) continue;
    for (const [index, option] of set.choices.options.entries()) {
      if (index === current.index || !option.hosts?.some((h) => hostMatches(u.hostname, h))) continue;
      if (current.option.hosts?.some((h) => hostMatches(u.hostname, h))) continue;
      out.push({ level: 'warning', message: `That looks like a ${option.label} address, and you chose ${current.option.label}.`, fix: `Switch to ${option.label}, or keep your choice if this is right.`, switchTo: { field: set.name, index } });
    }
  }
  return out;
}

/** The whole form's rules, given what has been entered. `existing` are the connection names already taken. */
export function reportOf(area: FormArea, state: FormState, existing: readonly string[], secretRules: (f: FormField) => SecretRules): Report {
  const needs: Record<string, Need> = {};
  const settings: Record<string, string> = {};
  const problems: Record<string, Problem[]> = {};
  const blockers: Blocker[] = [];
  const add = (key: string, p: Problem) => (problems[key] ??= []).push(p);
  const block = (field: string, reason: string) => blockers.push({ field, reason });

  if (state.name === '') block('name', 'Name the link, for example corp-jira.');
  else if (!CONNECTION_NAME.test(state.name)) {
    add('name', { level: 'error', message: `"${state.name}" isn't a valid name.`, fix: 'Use lowercase letters, digits and single hyphens, starting with a letter, e.g. corp-jira.' });
    block('name', 'Fix the name: lowercase letters, digits and single hyphens.');
  } else if (existing.includes(state.name)) {
    add('name', { level: 'error', message: `A connection called ${state.name} already exists.`, fix: 'Pick another name, or choose to replace it.' });
    block('name', `Pick another name: ${state.name} is taken.`);
  }

  for (const f of area.connection) needs[f.name] = needOf(area, f, state);
  for (const f of area.connection) {
    if (f.choices?.required && !selectedOption(area, f, state)) block(f.name, `Choose ${f.choices.options.map((o) => o.label).join(' or ')} first.`);
  }
  if (!chosen(area, state)) return { needs, settings, problems, blockers };

  const label = variantLabel(area, state);
  for (const f of area.connection) {
    const need = needs[f.name]!;
    if (need === 'hidden') continue;
    const sel = f.choices ? selectedOption(area, f, state) : null;
    if (f.secret) {
      const check = checkSecret(state.secrets[f.name] ?? '', secretRules(f));
      if (check.status === 'refused') {
        add(f.name, { level: 'error', message: check.message, fix: check.fix });
        block(f.name, `Fix the ${f.name}: ${check.message}`);
      } else if (check.status === 'empty' && need === 'required') {
        block(f.name, `Add the ${f.name}${label ? `: ${label} needs it` : ''}.`);
      } else if (check.status === 'ok') {
        const body = check.wrapper ? check.wrapper.without : check.value;
        const kinds = area.scopes?.secret === f.name ? area.scopes.kinds : [];
        const other = kinds.find((k) => k.tokenPrefix && body.startsWith(k.tokenPrefix));
        if (other && state.tokenKind && other.id !== state.tokenKind) {
          const mine = kinds.find((k) => k.id === state.tokenKind);
          add(f.name, { level: 'warning', message: `That starts with ${other.tokenPrefix}, which is a ${other.label.toLowerCase()}, and you chose ${mine?.label.toLowerCase() ?? 'another kind'}.`, fix: `Switch the type to ${other.label.toLowerCase()}, or keep it if this is right.`, switchToken: other.id });
        } else if (area.scopes?.secret === f.name) {
          const odd = Object.entries(area.scopes.otherPrefixes ?? {}).find(([prefix]) => body.startsWith(prefix));
          if (odd) add(f.name, { level: 'warning', message: `That starts with ${odd[0]}, which is ${odd[1]}.`, fix: 'toil takes a personal access token. Make one from the link below, or keep this if you are sure.' });
        }
      }
      continue;
    }
    const value = valueOf(area, f.name, state);
    if (value === '' && need === 'required') {
      add(f.name, { level: 'note', message: label && f.requiredFor?.length ? `Needed for ${label}.` : 'Needed.' });
      block(f.name, f.name === 'email' ? `Add your email: ${label ?? 'this'} signs in with email and token.` : `Fill in ${f.name === 'baseUrl' ? 'the address' : f.name}.`);
      continue;
    }
    if (value === '') continue;
    if (f.name === 'email' && !EMAIL.test(value)) {
      add(f.name, { level: 'error', message: "That doesn't look like an email address.", fix: 'Use the address of the account the token belongs to, like you@example.com.' });
      block(f.name, 'Fix the email address.');
      continue;
    }
    if (sel?.option.compose) {
      const typed = (state.text[f.name] ?? '').trim();
      const word = boxText(area, f, state);
      if (typed !== word) add(f.name, { level: 'note', message: `Type just the ${sel.option.compose.label.toLowerCase()}, like ${sel.option.compose.placeholder}. The rest was removed.` });
    }
    if (f.name === 'baseUrl') {
      for (const p of urlProblems(area, f, state, value)) {
        add(f.name, p);
        if (p.level === 'error') block(f.name, `Fix the address: ${p.message}`);
      }
      settings[f.name] = normalizeUrl(value, Boolean(sel?.option.expectPath));
    } else settings[f.name] = value;
  }
  return { needs, settings, problems, blockers };
}

/**
 * A choice made: the state after it, with every setting that stopped applying
 * emptied, and a note for each, so nothing disappears without a word.
 */
export function afterChoice(area: FormArea, state: FormState, field: string, index: number): { state: FormState; notes: string[] } {
  const next: FormState = { ...state, picks: { ...state.picks, [field]: index }, text: { ...state.text }, secrets: { ...state.secrets } };
  const notes: string[] = [];
  const label = variantLabel(area, next);
  for (const f of area.connection) {
    if (needOf(area, f, next) !== 'hidden') continue;
    const had = f.secret ? (next.secrets[f.name] ?? '') !== '' : (next.text[f.name] ?? '') !== '';
    delete next.secrets[f.name];
    delete next.text[f.name];
    if (f.name !== field) delete next.picks[f.name];
    if (had) notes.push(`${f.name} was cleared: it isn't needed for ${label ?? 'this choice'}.`);
  }
  return { state: next, notes };
}

/** Where to start: suggested values (a toil project's host) picked into the matching option, or typed. */
export function initialState(area: FormArea, suggest: { name?: string; values?: Record<string, string> } = {}): FormState {
  let state = emptyState(suggest.name ?? '');
  for (const [key, value] of Object.entries(suggest.values ?? {})) {
    const f = fieldOf(area, key);
    if (!f) continue;
    if (f.choices) {
      const exact = f.choices.options.findIndex((o) => o.value === value);
      if (exact >= 0) {
        state = { ...state, picks: { ...state.picks, [key]: exact } };
        continue;
      }
      const typedIndex = f.choices.options.findIndex((o) => o.value === null);
      if (typedIndex >= 0 && !f.choices.required) state = { ...state, picks: { ...state.picks, [key]: typedIndex } };
    }
    state = { ...state, text: { ...state.text, [key]: value } };
  }
  return state;
}

/**
 * The settings a save would send, only the applicable ones: what `toil
 * connections add --set key=value` is given, and what the form's "Saves" line
 * lists. A setting that doesn't apply is never in it, however it got filled.
 */
export function submission(area: FormArea, report: Report): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of area.connection) {
    if (f.secret || report.needs[f.name] === 'hidden') continue;
    const v = report.settings[f.name];
    if (v !== undefined && v !== '') out[f.name] = v;
  }
  return out;
}

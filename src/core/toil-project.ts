import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import type { ToilProjectLookup, GitRemoteReader } from './call-context.js';
import { deprecatedName } from './deprecation.js';
import { CONNECTION_NAME, connectionsOf, type ResolvedConfig } from './config.js';
import type { ToilProjectReport, Warning } from './envelope.js';
import { StrandedInput, ToilError } from './errors.js';
import { forwardSlashes, isSystemPath, type Workspace } from './files.js';
import { findGitRepo, readGitBranch, readGitRemotes, type GitContext } from './git-repo.js';
import { assertLocalPath } from './local-path.js';
import { RENAMED_AREAS } from './renamed-areas.js';
import { findSecrets } from './secret-shapes.js';
import { JsonSyntaxError, parseStrictJson } from './strict-json.js';
import { INTENTS, type TransitionPins } from './transition-intent.js';
import { isLensId, lensDef, LENSES, type LensId } from './brief/brief.js';
import { AUDIENCES, MAX_FOCUS, type Audience, type ToilProjectAnalyze } from './brief/prompt.js';

export type { ToilProjectAnalyze } from './brief/prompt.js';

/**
 * Toil projects: what toil knows about one body of work (its repositories, the
 * keys and boards it lives under, each environment's resources), kept apart
 * from connections so it can be shared (docs/projects.md). A toil project holds no
 * secret and no `writes`, and it can't create a connection: an area section
 * only selects among the reader's own connections, by name or by a host that
 * is compared and never contacted. That's why one may be checked into a
 * repository when config may not.
 *
 * This module reads them from the three places they live (your own folder,
 * listed folders, the repository you're in) or from one file named on the
 * call, validates each on every read, picks the one that applies to a call,
 * and turns it into the lookup core's context resolver asks
 * (`ToilProjectLookup`, src/core/call-context.ts). It never writes.
 *
 * A toil project is a briefing pack: everyone agrees it should exist, nobody agrees
 * who keeps it current. This one is read fresh every time, which is more than
 * most briefing packs can say.
 */

export type ToilProjectSource = ToilProjectReport['source'];

export interface ToilProjectRepo {
  name: string;
  /** A local checkout, as written. Machine-specific, so an export drops it. */
  path?: string;
  /** Remote URLs, userinfo stripped. Only ever compared, never contacted. */
  remotes: string[];
}

/** Whether someone on the team is a person or an agent. Agents are members too (#292). */
export const PERSON_KINDS = ['human', 'agent'] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

/**
 * Someone on the team, by name, with the identity each system knows them by
 * (`ids`, keyed by area: `{ "jira": "pat", "github": "pat-ex" }`). An identity
 * is a user name, login or email the system shows, never a credential: the
 * reader refuses one shaped like a token. `email` is only compared, to
 * suggest which unmapped identities are probably this person.
 */
export interface ToilProjectPerson {
  name: string;
  kind?: PersonKind;
  email?: string;
  ids: Record<string, string>;
}

/** One area's section: `connection` or `host`, `fields`, context input values, and reference data kept as written. */
export type Section = Record<string, unknown>;

export interface ToilProject {
  /** A JSON schema reference, kept as written. */
  $schema?: string;
  name: string;
  description?: string;
  /** The environment the toil project works in by default; a key of `environments`. */
  env?: string;
  repos: ToilProjectRepo[];
  /** Area name to section, unknown areas included (kept, and reported). */
  sections: Record<string, Section>;
  /** Environment name to area name to section. */
  environments: Record<string, Record<string, Section>>;
  /** The team: who works on it, and who each is in every system (#292). */
  people: ToilProjectPerson[];
  /** How many items one person may have in progress at once, as the team agreed; absent when it set none. */
  wipLimit?: number;
  /** Set by `toil projects archive`: the person is done looking at it for now. Hidden from lists, never from resolution; absent when not archived. */
  archived?: true;
  /** How Analyze briefs it (#494): its reader, its lenses, and its focus; absent for the standard. */
  analyze?: ToilProjectAnalyze;
}



export interface ToilProjectProblem {
  /** An `error` stops the toil project loading; a `warning` is reported and the toil project still loads. */
  level: 'error' | 'warning';
  code: string;
  /** Key path in the file (`jira.fields.storyPoints`), or '' for the file as a whole. */
  path: string;
  message: string;
}

/** One toil project file as read: where it is, where it counts as coming from, and what was wrong with it. */
export interface ToilProjectFile {
  file: string;
  source: ToilProjectSource;
  /** Absent when an error stopped it loading. */
  toilProject?: ToilProject;
  problems: ToilProjectProblem[];
}

/** What a toil project needs to know about an area: its name and the context inputs a section may supply. */
export interface ToilProjectArea {
  name: string;
  context: readonly string[];
  /** Hosts people know the service by, to the API base URL its connections use (`defineArea({ siteApis })`). */
  siteApis?: Readonly<Record<string, string>>;
}

/** Keys of a section that core reads itself; every other key is a context input or reference data. */
const CORE_SECTION_KEYS = new Set(['connection', 'host', 'fields', 'transitions']);
const TOP_LEVEL = new Set(['$schema', 'name', 'description', 'env', 'repos', 'environments', 'people', 'wipLimit', 'archived', 'analyze']);
const ALIAS = /^[a-z][a-zA-Z0-9]*$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/**
 * The largest toil project file toil reads (docs/bounds.md, `projects.size`). Every
 * call to an area command reads the toil projects that may apply, so a file far
 * larger than any team's would cost every call the time to parse it.
 */
export const MAX_TOIL_PROJECT_BYTES = 1024 * 1024;

/**
 * Keys no toil project may use, anywhere in it. Each names part of how JavaScript
 * objects work rather than data, so a section, environment or field called one
 * of them would be read through the object machinery instead of as written.
 */
export const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** An object's own value for a key, never one it inherits: `constructor` is not a section. */
export const ownValue = <T>(record: Record<string, T> | undefined, key: string): T | undefined => (record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined);

/** Every key path in a parsed toil project that uses a reserved key, walked with a list so depth can't overflow the stack. */
function reservedKeyPaths(raw: unknown): string[] {
  const found: string[] = [];
  const stack: Array<[unknown, string]> = [[raw, '']];
  while (stack.length > 0) {
    const [value, path] = stack.pop()!;
    if (Array.isArray(value)) value.forEach((item, i) => stack.push([item, at(path, i)]));
    else if (isRecord(value)) {
      for (const key of Object.keys(value)) {
        if (RESERVED_OBJECT_KEYS.has(key)) found.push(at(path, key));
        else stack.push([value[key], at(path, key)]);
      }
    }
  }
  return found.sort();
}

/** Enough of an email address to compare: something, an @, something. */
export const EMAIL = /^[^@\s]+@[^@\s]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`);

/**
 * A remote with a credential in it: any http(s) userinfo, or a password in any
 * URL. `git@host:path` and `ssh://git@host/...` carry a login name, not a
 * secret, so they're left as they are.
 */
export function hasSecretUserinfo(url: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/@]*)@/i.exec(url);
  if (!match) return false;
  return /^https?$/i.test(match[1]!) || match[2]!.includes(':');
}

/** The remote with any secret userinfo removed: `https://user:<token>@host/x` becomes `https://host/x`. */
export function stripUserinfo(url: string): string {
  return hasSecretUserinfo(url) ? url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1') : url;
}

/**
 * A remote reduced to what identifies the repository, so the SSH and HTTPS
 * remotes of one repo compare equal: no scheme, no userinfo, no port, host
 * lowercased, scp-style `git@host:path` read as `host/path`, and a trailing
 * `.git` and `/` dropped. A local path compares with forward slashes.
 */
export function normalizeRemote(url: string): string {
  const trimmed = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(trimmed);
  // `user@host:path`, but not `C:\x` or `C:/x`, which are Windows paths.
  const scp = scheme || /^[a-z]:[\\/]/i.test(trimmed) ? null : /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(trimmed);
  const parts = scheme ?? scp;
  if (!parts) return forwardSlashes(trimmed).replace(/\/+$/, '').replace(/\.git$/, '');
  const path = (parts[2] ?? '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return `${parts[1]!.toLowerCase()}/${path}`;
}

/** Paths compared as the platform compares them: case-insensitively on Windows, with one kind of slash. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => {
    const slashed = forwardSlashes(resolve(p)).replace(/\/+$/, '');
    return platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * A toil project written for an area that is now another (`jira-cloud` is `jira`,
 * #495) is read as the new one: its section, its environments' sections and the
 * `people` identities it names. Where the toil project already has the new area's
 * entry, that one wins and the warning says the old one was ignored. Either
 * way each is a warning by key path, so `toil projects check` reports it.
 */
function foldRenamedSections(raw: Record<string, unknown>, warn: (code: string, path: string, message: string) => void): Record<string, unknown> {
  // Moves `holder[old]` to `holder[new]`, or drops it when the new entry exists; `where` is the holder's key path.
  const fold = (holder: Record<string, unknown>, where: string): Record<string, unknown> => {
    const out = { ...holder };
    for (const [old, renamed] of Object.entries(RENAMED_AREAS)) {
      if (!Object.hasOwn(out, old)) continue;
      const path = at(where, old);
      const next = renamed.area;
      if (Object.hasOwn(out, next)) {
        warn('TOIL_PROJECT_RENAMED_AREA', path, `"${old}" is now "${next}", and this toil project has both: the "${next}" entry is used and "${old}" is ignored. Merge anything you need into "${next}" and remove "${old}".`);
      } else {
        out[next] = out[old];
        warn('TOIL_PROJECT_RENAMED_AREA', path, `"${old}" is now "${next}", so this is read as "${next}". Rename it to "${next}" in the file.`);
      }
      delete out[old];
    }
    return out;
  };
  const out = fold(raw, '');
  if (isRecord(out.environments)) {
    out.environments = Object.fromEntries(Object.entries(out.environments).map(([env, areas]) => [env, isRecord(areas) ? fold(areas, at('environments', env)) : areas]));
  }
  if (Array.isArray(out.people)) {
    out.people = out.people.map((person: unknown, i) => (isRecord(person) && isRecord(person.ids) ? { ...person, ids: fold(person.ids, at(at('people', i), 'ids')) } : person));
  }
  return out;
}

/**
 * Validates a parsed toil project, section by section. Unknown areas' sections are
 * kept and reported, never dropped. Remotes come back without userinfo.
 */
export function validateToilProject(input: unknown, areas: readonly ToilProjectArea[]): { toilProject?: ToilProject; problems: ToilProjectProblem[] } {
  const problems: ToilProjectProblem[] = [];
  const error = (path: string, message: string) => problems.push({ level: 'error', code: 'TOIL_PROJECT_INVALID', path, message });
  const warn = (code: string, path: string, message: string) => problems.push({ level: 'warning', code, path, message });
  if (!isRecord(input)) {
    error('', 'A toil project must be a JSON object.');
    return { problems };
  }
  // A section for an area that was folded into another is read as the new one, and the warning says to rename it.
  const raw = foldRenamedSections(input, warn);
  const byName = new Map(areas.map((a) => [a.name, a]));
  for (const path of reservedKeyPaths(raw)) {
    const key = path.slice(path.lastIndexOf('.') + 1);
    error(path, `"${key}" can't be a key in a toil project: __proto__, constructor and prototype are reserved. Rename it.`);
  }

  if (typeof raw.name !== 'string' || !CONNECTION_NAME.test(raw.name)) error('name', '"name" must be lowercase letters, digits and single hyphens, starting with a letter, e.g. "payments".');
  if (raw.description !== undefined && typeof raw.description !== 'string') error('description', '"description" must be text.');

  const repos: ToilProjectRepo[] = [];
  if (raw.repos !== undefined && !Array.isArray(raw.repos)) error('repos', '"repos" must be a list of repositories.');
  const seenRepo = new Map<string, string>();
  const seenRemote = new Map<string, string>();
  const seenPath: string[] = [];
  (Array.isArray(raw.repos) ? raw.repos : []).forEach((entry: unknown, i) => {
    const path = at('repos', i);
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') return error(path, 'Each repo needs a "name".');
    if (entry.path !== undefined && (typeof entry.path !== 'string' || entry.path === '')) return error(at(path, 'path'), '"path" must be a folder.');
    if (entry.remotes !== undefined && (!Array.isArray(entry.remotes) || !entry.remotes.every((r) => typeof r === 'string' && r !== ''))) return error(at(path, 'remotes'), '"remotes" must be a list of remote URLs.');
    for (const key of Object.keys(entry)) if (!['name', 'path', 'remotes'].includes(key)) warn('TOIL_PROJECT_UNKNOWN_KEY', at(path, key), `"${key}" isn't a repo key; repos take name, path and remotes. It was ignored.`);
    if (seenRepo.has(entry.name)) warn('TOIL_PROJECT_DUPLICATE', at(path, 'name'), `Repo "${entry.name}" is listed twice (also ${seenRepo.get(entry.name)}).`);
    seenRepo.set(entry.name, path);
    if (typeof entry.path === 'string') {
      if (seenPath.some((p) => samePath(p, entry.path as string))) warn('TOIL_PROJECT_DUPLICATE', at(path, 'path'), `Path ${forwardSlashes(entry.path)} is listed for two repos.`);
      seenPath.push(entry.path);
    }
    const remotes = ((entry.remotes as string[] | undefined) ?? []).map((remote, j) => {
      const where = at(at(path, 'remotes'), j);
      if (hasSecretUserinfo(remote)) warn('TOIL_PROJECT_REMOTE_USERINFO', where, 'This remote has a credential in its userinfo. toil ignores it, but it shouldn\'t be in a toil project: remove the "user:token@" part.');
      const key = normalizeRemote(remote);
      if (seenRemote.has(key)) warn('TOIL_PROJECT_DUPLICATE', where, `This remote is listed twice (also ${seenRemote.get(key)}).`);
      seenRemote.set(key, where);
      return stripUserinfo(remote);
    });
    repos.push({ name: entry.name, ...(typeof entry.path === 'string' ? { path: entry.path } : {}), remotes });
  });

  // Pinned transitions: work item type to intent to a transition or status name (src/core/transition-intent.ts).
  const readTransitions = (pins: unknown, path: string): void => {
    if (!isRecord(pins)) {
      error(path, '"transitions" must map each work item type to its intents, e.g. { "Story": { "review": "Peer Review" } }.');
      return;
    }
    for (const [type, byIntent] of Object.entries(pins)) {
      const where = at(path, type);
      if (!isRecord(byIntent)) {
        error(where, `"${type}" must map intents (${INTENTS.join(', ')}) to a transition or status name.`);
        continue;
      }
      for (const [intent, name] of Object.entries(byIntent)) {
        if (!(INTENTS as readonly string[]).includes(intent)) error(at(where, intent), `"${intent}" isn't an intent: pin one of ${INTENTS.join(', ')}.`);
        else if (typeof name !== 'string' || name.trim() === '') error(at(where, intent), `The ${intent} pin for ${type} must name a transition or status.`);
      }
    }
  };

  const readSection = (area: string, value: unknown, path: string): Section | undefined => {
    const known = byName.get(area);
    if (!known) warn('TOIL_PROJECT_UNKNOWN_SECTION', path, `"${area}" isn't an area this toil has, so its section is kept but not used.`);
    if (!isRecord(value)) {
      error(path, `The ${area} section must be an object.`);
      return undefined;
    }
    if (value.connection !== undefined && (typeof value.connection !== 'string' || !CONNECTION_NAME.test(value.connection))) error(at(path, 'connection'), '"connection" must be a connection name, e.g. "corp-jira".');
    if (value.host !== undefined && (typeof value.host !== 'string' || !HOST.test(value.host))) error(at(path, 'host'), '"host" must be a host name, optionally with a port, e.g. "jira.imagile.dev"; no scheme or path.');
    if (value.connection !== undefined && value.host !== undefined) error(path, 'Give "connection" or "host", not both: each picks the connection on its own.');
    if (value.fields !== undefined) {
      if (!isRecord(value.fields)) error(at(path, 'fields'), '"fields" must map each alias to a field id.');
      else {
        const ids = new Map<string, string>();
        for (const [alias, id] of Object.entries(value.fields)) {
          const where = at(at(path, 'fields'), alias);
          if (!ALIAS.test(alias)) error(where, `Field alias "${alias}" must be a camelCase identifier, e.g. "storyPoints".`);
          if (typeof id !== 'string' || id === '') error(where, `Field alias "${alias}" must name a field id.`);
          else {
            if (ids.has(id)) warn('TOIL_PROJECT_DUPLICATE', where, `Field id ${id} has two aliases ("${ids.get(id)}" and "${alias}").`);
            ids.set(id, alias);
          }
        }
      }
    }
    if (value.transitions !== undefined) readTransitions(value.transitions, at(path, 'transitions'));
    for (const [key, entry] of Object.entries(value)) {
      if (CORE_SECTION_KEYS.has(key)) continue;
      const where = at(path, key);
      if (key === 'env' && known?.context.includes('env')) {
        warn('TOIL_PROJECT_UNUSED_KEY', where, `"env" in a section isn't used: the environment is the toil project's own "env", or the call's --env. Set it with toil projects env <toil-project> <env> ${area} --default.`);
        continue;
      }
      if (known?.context.includes(key)) {
        // A context input: one value, or one per repo (`{ "payments-api": "PAY" }`).
        const ok = (typeof entry === 'string' && entry !== '') || (isRecord(entry) && Object.values(entry).every((v) => typeof v === 'string' && v !== ''));
        if (!ok) error(where, `"${key}" supplies ${area}'s ${key}: give it as text, or as an object of repo name to text.`);
      } else if (Array.isArray(entry)) {
        // Reference data (`projects`, `deployments`) is kept as written; a value listed twice is still worth saying.
        const seen = new Set<string>();
        entry.forEach((item, i) => {
          if (typeof item !== 'string' && typeof item !== 'number') return;
          const k = String(item);
          if (seen.has(k)) warn('TOIL_PROJECT_DUPLICATE', at(where, i), `${JSON.stringify(item)} is listed twice in ${where}.`);
          seen.add(k);
        });
      }
    }
    return value;
  };

  // No prototype, so a key can only ever be a section, whatever it's called.
  const sections = Object.create(null) as Record<string, Section>;
  for (const [key, value] of Object.entries(raw)) {
    if (TOP_LEVEL.has(key) || RESERVED_OBJECT_KEYS.has(key)) continue;
    const section = readSection(key, value, key);
    if (section) sections[key] = section;
  }

  const environments = Object.create(null) as Record<string, Record<string, Section>>;
  if (raw.environments !== undefined && !isRecord(raw.environments)) error('environments', '"environments" must map each environment to its areas.');
  for (const [env, areasOf] of Object.entries(isRecord(raw.environments) ? raw.environments : {})) {
    if (RESERVED_OBJECT_KEYS.has(env)) continue;
    const path = at('environments', env);
    if (!isRecord(areasOf)) {
      error(path, `Environment "${env}" must map areas to their sections.`);
      continue;
    }
    environments[env] = Object.create(null) as Record<string, Section>;
    for (const [area, value] of Object.entries(areasOf)) {
      if (RESERVED_OBJECT_KEYS.has(area)) continue;
      const section = readSection(area, value, at(path, area));
      if (section) environments[env]![area] = section;
    }
  }
  if (raw.env !== undefined && (typeof raw.env !== 'string' || !Object.hasOwn(environments, raw.env))) {
    error('env', `"env" must name one of the toil project's environments${Object.keys(environments).length ? ` (${Object.keys(environments).join(', ')})` : ', and it has none'}.`);
  }

  const people = readPeople(raw.people, byName, error, warn);
  if (raw.wipLimit !== undefined && !(typeof raw.wipLimit === 'number' && Number.isInteger(raw.wipLimit) && raw.wipLimit > 0)) error('wipLimit', '"wipLimit" must be a whole number above 0: how many items one person may have in progress at once.');

  if (raw.archived !== undefined && typeof raw.archived !== 'boolean') error('archived', '"archived" must be true or false.');

  const analyze = readAnalyze(raw.analyze, error, warn);

  if (problems.some((p) => p.level === 'error')) return { problems };
  return {
    toilProject: {
      ...(typeof raw.$schema === 'string' ? { $schema: raw.$schema } : {}),
      name: raw.name as string,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.env === 'string' ? { env: raw.env } : {}),
      repos,
      sections,
      environments,
      people,
      ...(typeof raw.wipLimit === 'number' ? { wipLimit: raw.wipLimit } : {}),
      ...(raw.archived === true ? { archived: true as const } : {}),
      ...(analyze ? { analyze } : {}),
    },
    problems,
  };
}

const ANALYZE_KEYS = ['goal', 'audience', 'lenses', 'watchFor', 'leaveOut'];

/**
 * The `analyze` object (#494): words for the agent, and lens settings. Each
 * text is at most MAX_FOCUS characters and never shaped like a credential,
 * since a toil project never holds one; a lens is named once, and only a lens with
 * a unit takes a threshold.
 */
function readAnalyze(value: unknown, error: (path: string, message: string) => void, warn: (code: string, path: string, message: string) => void): ToilProjectAnalyze | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    error('analyze', '"analyze" must be an object: { goal, audience, lenses, watchFor, leaveOut }.');
    return undefined;
  }
  const out: ToilProjectAnalyze = {};
  for (const key of Object.keys(value)) if (!ANALYZE_KEYS.includes(key)) warn('TOIL_PROJECT_UNKNOWN_KEY', `analyze.${key}`, `"${key}" isn't an analyze key; analyze takes ${ANALYZE_KEYS.join(', ')}. It was ignored.`);
  for (const key of ['goal', 'watchFor', 'leaveOut'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.trim() === '') error(`analyze.${key}`, `"${key}" must be text.`);
    else if (v.length > MAX_FOCUS) error(`analyze.${key}`, `"${key}" is ${v.length} characters; the most is ${MAX_FOCUS}.`);
    else if (findSecrets(v).length > 0) error(`analyze.${key}`, `"${key}" holds something shaped like a credential, and a toil project never holds one.`);
    // One line each: a line break would let a checked-in toil project's words pass as another label in the prompt.
    else if ([...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) error(`analyze.${key}`, `"${key}" must be one line of text, with no line breaks or control characters.`);
    else out[key] = v.trim();
  }
  if (value.audience !== undefined) {
    if (AUDIENCES.includes(value.audience as Audience)) out.audience = value.audience as Audience;
    else error('analyze.audience', `"audience" must be one of ${AUDIENCES.join(', ')}.`);
  }
  if (value.lenses !== undefined) {
    if (!Array.isArray(value.lenses)) error('analyze.lenses', '"lenses" must be a list: [{ "id": "failing", "on": true, "threshold": 4 }, …].');
    else {
      const seen = new Set<string>();
      const lenses: NonNullable<ToilProjectAnalyze['lenses']> = [];
      value.lenses.forEach((l: unknown, i: number) => {
        const path = `analyze.lenses[${i}]`;
        if (!isRecord(l) || typeof l.id !== 'string' || !isLensId(l.id)) return void error(path, `Each lens needs an id, one of ${LENSES.map((d) => d.id).join(', ')}.`);
        if (seen.has(l.id)) return void error(path, `"${l.id}" is listed twice.`);
        seen.add(l.id);
        for (const key of Object.keys(l)) if (!['id', 'on', 'threshold'].includes(key)) warn('TOIL_PROJECT_UNKNOWN_KEY', `${path}.${key}`, `"${key}" isn't a lens key; a lens takes id, on and threshold. It was ignored.`);
        const lens: { id: LensId; on?: boolean; threshold?: number } = { id: l.id };
        if (l.on !== undefined) {
          if (typeof l.on === 'boolean') lens.on = l.on;
          else error(`${path}.on`, '"on" must be true or false.');
        }
        if (l.threshold !== undefined) {
          const unit = lensDef(l.id).unit;
          if (!unit) error(`${path}.threshold`, `The ${l.id} lens takes no threshold.`);
          else if (typeof l.threshold !== 'number' || !(l.threshold > 0) || l.threshold > 365) error(`${path}.threshold`, `"threshold" must be a number of ${unit} above 0 and at most 365.`);
          else lens.threshold = l.threshold;
        }
        lenses.push(lens);
      });
      out.lenses = lenses;
    }
  }
  return out;
}

/** Why a value can't be an identity: it's shaped like a credential, which a toil project never holds. Undefined when it can. */
export function identityProblem(value: string): string | undefined {
  if (findSecrets(value).length > 0) return "it's shaped like a credential, and a toil project never holds one. Give the user name, login or email the system shows";
  return undefined;
}

/** The key one identity is held under: system ids compare without case, as every one of those systems compares them. */
export const identityKey = (area: string, id: string) => `${area}\u0000${id.trim().toLowerCase()}`;

/**
 * The `people` list: each entry a name, an optional kind and email, and the
 * identity each area knows them by. A name or an identity listed twice is
 * refused, since one account can only be one person's. A roll call, taken
 * once and read on every call, which is more often than most org charts.
 */
function readPeople(
  raw: unknown,
  areas: Map<string, ToilProjectArea>,
  error: (path: string, message: string) => void,
  warn: (code: string, path: string, message: string) => void,
): ToilProjectPerson[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    error('people', '"people" must be a list of people, e.g. [{ "name": "Pat Example", "ids": { "jira": "pat", "github": "pat-ex" } }].');
    return [];
  }
  const out: ToilProjectPerson[] = [];
  const names = new Map<string, string>();
  const owners = new Map<string, string>();
  raw.forEach((entry: unknown, i) => {
    const path = at('people', i);
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.trim() === '') return error(path, 'Each person needs a "name".');
    const name = entry.name.trim();
    // Where, never what: a name or email shaped like a credential is refused by key path, as an identity is.
    if (identityProblem(name)) return error(at(path, 'name'), `This name can't be used: ${identityProblem(name)}.`);
    const seen = names.get(name.toLowerCase());
    if (seen) error(at(path, 'name'), `"${name}" is listed twice (also ${seen}).`);
    names.set(name.toLowerCase(), path);
    for (const key of Object.keys(entry)) if (!['name', 'kind', 'email', 'ids'].includes(key)) warn('TOIL_PROJECT_UNKNOWN_KEY', at(path, key), `"${key}" isn't a person key; people take name, kind, email and ids. It was ignored.`);
    if (entry.kind !== undefined && !(PERSON_KINDS as readonly unknown[]).includes(entry.kind)) error(at(path, 'kind'), `"kind" must be ${PERSON_KINDS.join(' or ')}.`);
    if (entry.email !== undefined && (typeof entry.email !== 'string' || !EMAIL.test(entry.email) || identityProblem(entry.email))) error(at(path, 'email'), '"email" must be an email address, e.g. you@example.com, and never a credential.');
    if (entry.ids !== undefined && !isRecord(entry.ids)) error(at(path, 'ids'), '"ids" must map each area to the identity it knows this person by, e.g. { "github": "pat-ex" }.');
    const ids: Record<string, string> = {};
    for (const [area, value] of Object.entries(isRecord(entry.ids) ? entry.ids : {})) {
      const where = at(at(path, 'ids'), area);
      if (typeof value !== 'string' || value.trim() === '') {
        error(where, `The ${area} identity must be text: the user name, login or email ${area} shows.`);
        continue;
      }
      // Where, never what: the value stays in the file, and the message names the key to look at.
      const problem = identityProblem(value);
      if (problem) {
        error(where, `This identity can't be used: ${problem}.`);
        continue;
      }
      if (!areas.has(area)) warn('TOIL_PROJECT_UNKNOWN_SECTION', where, `"${area}" isn't an area this toil has, so this identity is kept but matches nothing.`);
      const key = identityKey(area, value);
      const owner = owners.get(key);
      if (owner) error(where, `The ${area} identity ${value.trim()} is already ${owner}'s: one account can only be one person's.`);
      owners.set(key, name);
      ids[area] = value.trim();
    }
    out.push({ name, ...(typeof entry.kind === 'string' ? { kind: entry.kind as PersonKind } : {}), ...(typeof entry.email === 'string' ? { email: entry.email } : {}), ids });
  });
  return out;
}

/**
 * Whether a connection is on a toil project host selector (`host` or `host:port`): its
 * base URL's host, with the scheme's default port filled in, or its `host` setting.
 * A selector with no port also matches a connection on the API host the area
 * names for it (`siteApis`: `github.com` matches a base URL on api.github.com).
 * Exported so the menu asks about writes on exactly the connections a call would pick.
 */
export function hostMatches(settings: Record<string, unknown>, selector: string, siteApis?: Readonly<Record<string, string>>): boolean {
  const [host, port] = selector.toLowerCase().split(':');
  if (typeof settings.baseUrl === 'string') {
    try {
      const url = new URL(settings.baseUrl);
      const actual = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
      if (port === undefined && host !== undefined && Object.hasOwn(siteApis ?? {}, host) && apiHostOf(siteApis![host]!) === url.host.toLowerCase()) return true;
      return url.hostname.toLowerCase() === host && (port === undefined || actual === port);
    } catch {
      return false;
    }
  }
  if (typeof settings.host === 'string') return settings.host.toLowerCase() === host && (port === undefined || String(settings.port ?? '') === port);
  return false;
}

function apiHostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * A connection's host as a shareable selector: its base URL's host (with a port
 * that isn't the scheme's default), or its `host` setting. A base URL on an API
 * host the area names (`siteApis`) gives the host people know instead, so a
 * GitHub connection on api.github.com is shared as `github.com`.
 */
export function selectorHost(settings: Record<string, unknown> | undefined, siteApis?: Readonly<Record<string, string>>): string | undefined {
  if (!settings) return undefined;
  if (typeof settings.baseUrl === 'string') {
    let host: string;
    try {
      host = new URL(settings.baseUrl).host.toLowerCase();
    } catch {
      return undefined;
    }
    const site = Object.entries(siteApis ?? {}).find(([, url]) => apiHostOf(url) === host);
    return site ? site[0] : host;
  }
  if (typeof settings.host === 'string') return settings.host.toLowerCase() + (settings.port !== undefined ? `:${String(settings.port)}` : '');
  return undefined;
}

/** The toil project as it's written to a file and shown: remotes without userinfo, every section and reference key kept. */
export function toilProjectContent(toilProject: ToilProject): Record<string, unknown> {
  return {
    ...(toilProject.$schema !== undefined ? { $schema: toilProject.$schema } : {}),
    name: toilProject.name,
    ...(toilProject.description !== undefined ? { description: toilProject.description } : {}),
    ...(toilProject.env !== undefined ? { env: toilProject.env } : {}),
    repos: toilProject.repos,
    ...toilProject.sections,
    ...(Object.keys(toilProject.environments).length > 0 ? { environments: toilProject.environments } : {}),
    ...(toilProject.people.length > 0 ? { people: toilProject.people } : {}),
    ...(toilProject.wipLimit !== undefined ? { wipLimit: toilProject.wipLimit } : {}),
    ...(toilProject.archived ? { archived: true } : {}),
    ...(toilProject.analyze !== undefined ? { analyze: toilProject.analyze } : {}),
  };
}

/** Reads and validates one file. A file that can't be read or parsed is an error problem, never a throw. */
export function readToilProjectFile(file: string, source: ToilProjectSource, areas: readonly ToilProjectArea[]): ToilProjectFile {
  let text: string;
  try {
    const read = readCapped(file, MAX_TOIL_PROJECT_BYTES);
    if (read === undefined) {
      return {
        file,
        source,
        problems: [{ level: 'error', code: 'TOIL_PROJECT_INVALID', path: '', message: `It is larger than ${MAX_TOIL_PROJECT_BYTES / 1024 / 1024} MiB, the most a toil project file may be, so it wasn't read. A toil project holds names and keys; move anything else out of it.` }],
      };
    }
    text = read;
  } catch (err) {
    return { file, source, problems: [{ level: 'error', code: 'TOIL_PROJECT_INVALID', path: '', message: `It couldn't be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}.` }] };
  }
  let parsed: ReturnType<typeof parseStrictJson>;
  try {
    parsed = parseStrictJson(text);
  } catch (err) {
    // Where, never what: the content stays in the file (docs/projects.md, What import reveals).
    const where = err instanceof JsonSyntaxError ? err.message : 'unreadable';
    return { file, source, problems: [{ level: 'error', code: 'TOIL_PROJECT_INVALID', path: '', message: `It isn't valid JSON: ${where}.` }] };
  }
  const { toilProject, problems } = validateToilProject(parsed.value, areas);
  const duplicates: ToilProjectProblem[] = parsed.duplicates.map((path) => ({ level: 'warning', code: 'TOIL_PROJECT_DUPLICATE_KEY', path, message: `"${path}" is set twice; the last one is used.` }));
  return { file, source, ...(toilProject ? { toilProject } : {}), problems: [...duplicates, ...problems] };
}

/**
 * A file's text, or undefined when it holds more than `max` bytes. The size
 * is taken from the open file and the read stops one byte past the cap, so a
 * file that grows between the two still can't be read whole.
 */
function readCapped(file: string, max: number): string | undefined {
  const fd = openSync(file, 'r');
  try {
    if (fstatSync(fd).size > max) return undefined;
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    for (;;) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
      if (length > max) return undefined;
    }
    return buffer.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}

/** A problem as a meta.warnings entry, naming the file and key. */
export function problemWarning(file: ToilProjectFile, problem: ToilProjectProblem): Warning {
  return { code: problem.code, message: `${forwardSlashes(file.file)}${problem.path ? ` (${problem.path})` : ''}: ${problem.message}` };
}

/** The error for a toil project that can't load: which file, which key, what's wrong. Never the content. */
export function brokenToilProject(file: ToilProjectFile): ToilError {
  const errors = file.problems.filter((p) => p.level === 'error');
  const first = errors[0]!;
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more problem${errors.length > 2 ? 's' : ''})` : '';
  return new ToilError('CONFIG_INVALID', `Toil project ${forwardSlashes(file.file)} can't be used${first.path ? `: ${first.path}` : ''}: ${first.message}${more}`, {
    fix: `Fix it in ${forwardSlashes(file.file)}; toil projects check ${forwardSlashes(file.file)} lists every problem.`,
    details: errors.map((p) => ({ path: p.path, message: p.message })),
  });
}

/** Where a toil project's folder came from: the call's `cwd`, or the workspace (`--workspace`, TOIL_WORKSPACE, the CLI's working directory, the MCP client's root). */
export type FolderSource = NonNullable<ToilProjectReport['folder']>['from'];

export interface Folder {
  path?: string;
  from: FolderSource;
}

/** The repository a folder is in, as toil projects match it: its root and its `origin` remote. */
export interface FolderRepo {
  root: string;
  origin?: string;
}

export interface Selection {
  folder: Folder;
  repo?: FolderRepo;
  /** The toil project that applies, and how it was found. */
  applied?: Applied;
  /** Every toil project that matched the folder, after same-name precedence; more than one means none applies. */
  candidates: Applied[];
  /** Files read on the way that are broken, and same-name collisions: worth saying, not worth failing for. */
  warnings: Warning[];
}

export interface Applied {
  file: ToilProjectFile & { toilProject: ToilProject };
  by: ToilProjectReport['by'];
  match?: NonNullable<ToilProjectReport['match']>;
  /** The toil project's repo the folder is, when one matched. */
  repo?: string;
}

/** What execute() gets for one call: the lookup for core's resolver, adoption, and the folder's git. */
export interface Place {
  /** The toil project's values; the first call works out which toil project applies, and may fail (two match). */
  lookup: ToilProjectLookup;
  /** Whether a write may use a connection the toil project chose: only when the toil project is your own (`toil projects import`). */
  adopted: (area: string, connection: string, by: 'toil-project' | 'git') => boolean;
  /** The host selector that picked `area`'s connection, for meta.context. */
  hostFor: (area: string, input: Record<string, unknown>) => string | undefined;
  /** meta.context.toilProject, once the lookup has been asked and a toil project applied; undefined before. */
  report: () => ToilProjectReport | undefined;
  /** Problems found reading toil projects, once the lookup has been asked. */
  warnings: () => Warning[];
  /** The toil project's field aliases for an area, alias to field id; asking consults the toil project, as the lookup does. */
  fields: (area: string, input: Record<string, unknown>) => Record<string, string>;
  /** Every section the toil project has for an area, for `<area> check-toil-project`; asking consults the toil project. */
  view: (area: string) => ToilProjectView | undefined;
  /** The transitions the toil project pins for an area, lowercased type to intent to name; asking consults the toil project, as the lookup does. */
  transitions: (area: string, input: Record<string, unknown>) => TransitionPins;
  /** The folder's git, when the call named a `cwd`; otherwise the workspace's. */
  gitRemote?: GitRemoteReader;
  repo?: () => GitContext | undefined;
}

/** A repository `toil repos scan` found. */
export interface ScannedRepo {
  /** The folder's name, which `toil projects add-repo` uses as the repo's name too. */
  name: string;
  /** The work tree's root, absolute, forward slashes. */
  path: string;
  branch: string;
  /** Fetch URLs by remote name, userinfo stripped. */
  remotes: Record<string, string>;
}

/** The most folders one scan visits; past it the result says it's truncated. */
const SCAN_LIMIT = 20_000;
/** Folders no repository lives in, skipped by name. */
const SCAN_SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', 'bin', 'obj']);

/** One area's part of a toil project, as `<area> check-toil-project` reads it: read-only, and never a connection's settings. */
export interface ToilProjectView {
  name: string;
  source: ToilProjectSource;
  file: string;
  /** The toil project's default environment, if it names one. */
  env: string | null;
  /** The area's own section and each environment's, with their key paths. */
  sections: Array<{ path: string; env: string | null; values: Section }>;
}

/** A group of values that belong together, as `viewScopes` finds them: each key's value and where in the toil project it came from. */
export interface ViewScope {
  repo: string | null;
  values: Record<string, string>;
  paths: Record<string, string>;
}

/**
 * The values of several keys that belong together (a project and its repo),
 * per repo, read the way the resolver reads them: for each key, the call's
 * environment's section first, then the area's own, and in each a plain value
 * for every repo or a per-repo one (`{ "payments-api": "PAY" }`) for its repo.
 * A scope that finds some of `keys` but not all goes in `incomplete`, so the
 * caller can say it couldn't be checked rather than leave it out.
 */
export function viewScopes(view: ToilProjectView, keys: readonly string[]): { scopes: ViewScope[]; incomplete: Array<{ repo: string | null; found: Record<string, string>; lacks: string[] }> } {
  // The environment's section first, as the resolver reads it (sectionsFor).
  const ordered = [...view.sections].sort((a, b) => Number(a.env === null) - Number(b.env === null));
  const repos = [...new Set(ordered.flatMap((s) => keys.flatMap((k) => (isRecord(s.values[k]) ? Object.keys(s.values[k] as Record<string, unknown>) : []))))];
  const scopes: ViewScope[] = [];
  const incomplete: Array<{ repo: string | null; found: Record<string, string>; lacks: string[] }> = [];
  for (const repo of repos.length > 0 ? repos : [null]) {
    const values: Record<string, string> = {};
    const paths: Record<string, string> = {};
    for (const key of keys) {
      for (const section of ordered) {
        const value = section.values[key];
        if (typeof value === 'string') {
          values[key] = value;
          paths[key] = `${section.path}.${key}`;
          break;
        }
        if (isRecord(value) && repo !== null && typeof value[repo] === 'string') {
          values[key] = value[repo] as string;
          paths[key] = `${section.path}.${key}.${repo}`;
          break;
        }
      }
    }
    const lacks = keys.filter((k) => !(k in values));
    if (lacks.length === 0) scopes.push({ repo, values, paths });
    else if (lacks.length < keys.length) incomplete.push({ repo, found: Object.fromEntries(Object.entries(paths).map(([k, path]) => [path, values[k]!])), lacks });
  }
  return { scopes, incomplete };
}

/**
 * Every text value a view holds under `keys`, with its key path: a plain
 * value, each repo's value in a per-repo map, each item of a list. What a
 * check-toil-project command looks up on its service.
 */
export function viewValues(view: ToilProjectView, keys: readonly string[]): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  for (const { path, values } of view.sections) {
    for (const key of keys) {
      const value = values[key];
      const at = `${path}.${key}`;
      if (typeof value === 'string') out.push({ path: at, value });
      else if (Array.isArray(value)) value.forEach((v, i) => typeof v === 'string' && out.push({ path: `${at}[${i}]`, value: v }));
      else if (isRecord(value)) for (const [repo, v] of Object.entries(value)) if (typeof v === 'string') out.push({ path: `${at}.${repo}`, value: v });
    }
  }
  return out;
}

export interface CatalogOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  config: ResolvedConfig;
  areas: readonly ToilProjectArea[];
  /** The default folder: the workspace. */
  workspace: Pick<Workspace, 'dir' | 'source'>;
  /** What a relative `cwd` or toil project path resolves against: the CLI's working directory; under MCP, the workspace. */
  base: string | undefined;
  /** toil's own files beyond `~/.toil` (the --config file), which a toil project path may not name. */
  protect: readonly string[];
  /** The git context for a folder (its remotes for the git step, and `ctx.repo()`), used when a call names a `cwd`: the same readers the workspace gets. */
  git: (dir: string) => Pick<Place, 'gitRemote' | 'repo'>;
}

export interface ToilProjectCatalog {
  /**
   * Your own folder, the listed folders, and the repository toil project folder for `folder` when it's in one.
   * `userOld` and `repoOld` are the folders toil projects were kept in as dossiers (`dossiers/`): still read, never written to.
   */
  places(cwd?: string): { user: string; userOld: string; listed: string[]; repo?: string; repoOld?: string };
  /** Every toil project file in every place, in precedence order (yours, listed, the repository's). */
  scan(cwd?: string): { files: ToilProjectFile[]; folder: Folder; repo?: FolderRepo; warnings: Warning[] };
  /** One toil project by name or by path; broken is CONFIG_INVALID, unknown INVALID_INPUT. */
  find(nameOrPath: string, cwd?: string): ToilProjectFile & { toilProject: ToilProject };
  /** Which toil project applies, from the explicit `toilProject` (or TOIL_PROJECT), else the folder. */
  select(request: { toilProject?: string | undefined; cwd?: string | undefined }): Selection;
  /** The same, as what a call's context resolution needs. */
  place(request: { toilProject?: string | undefined; cwd?: string | undefined }): Place;
  /** The connection `area` uses under `toilProject`'s binding, without a call: for `toil projects show` and `check`. */
  binding(toilProject: ToilProject, area: string, env: string | undefined, config?: ResolvedConfig): { connection?: string; host?: string; section?: Section };
  /** Where your own toil project named `name` lives: `~/.toil/projects/<name>.json`. */
  userFile(name: string): string;
  /** The lookup a call would get from `toilProject`, as if the folder were its repo `repo`: for judging a change before it's saved. */
  lookupOf(toilProject: ToilProject, repo?: string): ToilProjectLookup;
  /**
   * The toil project files an import reads from `value`: the file, or every `.json`
   * in the folder. The bounds are checked before anything is looked at, so a
   * path outside them can't be probed for whether it exists.
   */
  importFiles(value: string): { folder: boolean; files: string[] };
  /** A path a call gave, absolute: relative to the CLI's working directory, or under MCP the workspace. */
  pathFor(value: string, what: string): string;
  /** A folder on this machine and the repository it's in, for `add-repo`; INVALID_INPUT when it isn't there. */
  inspect(dir: string): { path: string; repo?: FolderRepo };
  /**
   * The git repositories under `dir` (default: the workspace), for `toil repos
   * scan`: each one's root, branch and remotes, credentials stripped. `dir`
   * must be inside the workspace. Folders are walked to `depth` levels below
   * it, links aren't followed, and a repository's own folders aren't entered.
   */
  scanRepos(dir: string | undefined, depth: number): { folder: string; repos: ScannedRepo[]; truncated: boolean };
  /** `.toil/projects/` in the repository whose root is `dir`; INVALID_INPUT when `dir` isn't a repository's root. */
  repoFolder(dir: string): string;
  /**
   * Writes a toil project, validated, to `path`: `create` refuses a file that's
   * there, `replace` replaces only a valid toil project, `edit` rewrites the one it
   * was read from. The path must be a `.json` file in a toil project folder or the
   * workspace, never toil's own files, /proc or /sys. Files in your own folder
   * are readable by you only. Returns the absolute path written.
   */
  save(path: string, toilProject: ToilProject, mode: 'create' | 'replace' | 'edit'): string;
}

const FROM_WORKSPACE: Record<Workspace['source'], FolderSource> = { flag: 'flag', env: 'env', cwd: 'cwd', 'mcp-root': 'mcp-root', none: 'cwd' };

export function createToilProjectCatalog(o: CatalogOptions): ToilProjectCatalog {
  const user = join(o.home, '.toil', 'projects');
  // Toil projects were dossiers, kept in `dossiers/`. That folder is still read, as your own, until `toil projects migrate` moves it.
  const userOld = join(o.home, '.toil', 'dossiers');
  const own = join(o.home, '.toil');
  const guard = { home: o.home, env: o.env, protect: o.protect };
  const areaNames = new Map(o.areas.map((a) => [a.name, a]));
  /**
   * A folder's one canonical form, whether or not it exists yet: the nearest
   * folder above it that exists, real-pathed, with the rest added back. So
   * `~/.toil/projects` before the first toil project is made compares equal to a
   * real-pathed file inside it, even when the home is spelled another way
   * (a Windows 8.3 name such as RUNNER~1, macOS's /var for /private/var).
   */
  const real = (path: string) => {
    let existing = resolve(path);
    const rest: string[] = [];
    for (;;) {
      try {
        return join(realpathSync.native(existing), ...rest);
      } catch {
        const parent = resolve(existing, '..');
        if (parent === existing) return resolve(path);
        rest.unshift(basename(existing));
        existing = parent;
      }
    }
  };

  const listed = (): string[] => {
    const fromEnv = o.env.TOIL_PROJECT_PATHS ?? o.env.TOIL_DOSSIER_PATHS;
    const raw = fromEnv !== undefined ? fromEnv.split(delimiter).filter((p) => p !== '') : (o.config.projectPaths ?? []);
    return raw.map((p) => resolve(p));
  };

  /**
   * A path on the call (`cwd`, a toil project file, an import source, a folder to
   * scan), resolved from its text alone. A network or device path is refused
   * here, before anything stats, realpaths or reads it (src/core/local-path.ts).
   */
  const fromBase = (value: string, what: string): string => {
    assertLocalPath(value, o.workspace.dir, what);
    const path = isAbsolute(value) ? resolve(value) : o.base === undefined ? undefined : resolve(o.base, value);
    if (path !== undefined) {
      assertLocalPath(path, o.workspace.dir, what);
      return path;
    }
    throw new ToilError('INVALID_INPUT', `${what} "${value}" is relative, and there's no folder to resolve it against.`, {
      fix: 'Pass an absolute path, or give the MCP server a workspace with --workspace <dir> or TOIL_WORKSPACE.',
    });
  };

  const folder = (cwd?: string): Folder => {
    if (cwd === undefined) return o.workspace.dir ? { path: o.workspace.dir, from: FROM_WORKSPACE[o.workspace.source] } : { from: FROM_WORKSPACE[o.workspace.source] };
    const path = fromBase(cwd, 'The folder');
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      // said below
    }
    if (!isDir) {
      throw new ToilError('INVALID_INPUT', `The folder ${forwardSlashes(path)} (from cwd) doesn't exist where toil is running.`, {
        fix: "Pass a folder on this machine. If toil runs somewhere else (a container, WSL, another host), its paths aren't yours: pass toil project by name instead.",
      });
    }
    return { path, from: 'input' };
  };

  const repoOf = (dir: string | undefined): FolderRepo | undefined => {
    if (!dir) return undefined;
    const repo = findGitRepo(dir, guard);
    if (!repo) return undefined;
    const origin = readGitRemotes(repo, guard).find((r) => r.name === 'origin');
    return { root: repo.root, ...(origin ? { origin: origin.url } : {}) };
  };

  /** The old env names that are set, each saying what replaced it; the new name wins when both are, and the warning says so. */
  const oldEnvWarnings = (): Warning[] => [
    ...(o.env.TOIL_DOSSIER ? [deprecatedName('TOIL_DOSSIER', 'TOIL_PROJECT', Boolean(o.env.TOIL_PROJECT))] : []),
    ...(o.env.TOIL_DOSSIER_PATHS !== undefined ? [deprecatedName('TOIL_DOSSIER_PATHS', 'TOIL_PROJECT_PATHS', o.env.TOIL_PROJECT_PATHS !== undefined)] : []),
  ];

  /** One warning for a folder still named `dossiers`: yours has a command that moves it, a repository's is the repository's to rename. */
  const oldFolderWarning = (dir: string, mine: boolean): Warning => ({
    code: 'TOIL_PROJECT_OLD_FOLDER',
    message: mine
      ? `Toil projects are still in ${forwardSlashes(dir)}, the old folder name, and are read from there (one with the same name in ${forwardSlashes(user)} wins). Run toil projects migrate to move them to ${forwardSlashes(user)}.`
      : `${forwardSlashes(dir)} is the old folder name for a repository's toil projects, and its files are read from there. toil projects migrate moves only ${forwardSlashes(userOld)}: rename this one in the repository with git mv (to a folder named projects).`,
  });

  /** toil's own files (but your toil project folders), the --config file, /proc and /sys: never read as a toil project. */
  const forbidden = (realPath: string) => (!inside(realPath, real(user)) && !inside(realPath, real(userOld)) && [own, ...o.protect].some((p) => inside(realPath, real(p)))) || isSystemPath(realPath);

  /** Every `.json` in `dir`. A repository's folder must really be inside the repository (`within`), and no file may lead out of its folder. */
  const readFolder = (dir: string, source: ToilProjectSource, warnings: Warning[], within?: string): ToilProjectFile[] => {
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) {
        warnings.push({ code: 'TOIL_PROJECT_PATH_INVALID', message: `${forwardSlashes(dir)} is listed as a toil project folder but isn't a folder.` });
        return [];
      }
      names = readdirSync(dir);
    } catch {
      // A folder that isn't there yet (no toil projects made) is simply empty; a listed one is worth saying.
      if (source === 'listed') warnings.push({ code: 'TOIL_PROJECT_PATH_INVALID', message: `${forwardSlashes(dir)} is listed as a toil project folder but doesn't exist.` });
      return [];
    }
    const realDir = real(dir);
    if ((within !== undefined && !inside(realDir, real(within))) || forbidden(realDir)) {
      warnings.push({ code: 'TOIL_PROJECT_PATH_INVALID', message: `${forwardSlashes(dir)} was skipped: it's a link to a folder outside ${within ? forwardSlashes(within) : 'the toil project folders'}.` });
      return [];
    }
    return names
      .filter((n) => n.toLowerCase().endsWith('.json'))
      .sort()
      .flatMap((n) => {
        // A repository can check in a symlink. One that leads out of its folder
        // could make any JSON file on the machine read as a toil project, so it's skipped.
        const file = join(dir, n);
        if (!inside(real(file), realDir) || forbidden(real(file))) {
          warnings.push({ code: 'TOIL_PROJECT_PATH_INVALID', message: `${forwardSlashes(file)} was skipped: it's a link to a file outside ${forwardSlashes(dir)}.` });
          return [];
        }
        return [readToilProjectFile(file, source, o.areas)];
      });
  };

  const places = (cwd?: string) => {
    const repo = repoOf(folder(cwd).path);
    const repoDir = repo ? join(repo.root, '.toil', 'projects') : undefined;
    const repoOldDir = repo ? join(repo.root, '.toil', 'dossiers') : undefined;
    // A home folder that is itself a repository has one toil project folder, not two.
    return {
      user,
      userOld,
      listed: listed(),
      ...(repoDir && !samePath(real(repoDir), real(user)) ? { repo: repoDir } : {}),
      ...(repoOldDir && !samePath(real(repoOldDir), real(userOld)) ? { repoOld: repoOldDir } : {}),
    };
  };

  const scan = (cwd?: string) => {
    const f = folder(cwd);
    const repo = repoOf(f.path);
    const where = places(cwd);
    const warnings: Warning[] = [];
    const old = readFolder(where.userOld, 'user', warnings);
    const repoOld = where.repoOld && repo ? readFolder(where.repoOld, 'repo', warnings, repo.root) : [];
    // The new folder comes first, so a name in both is the new one's.
    const files = [
      ...readFolder(where.user, 'user', warnings),
      ...old,
      ...where.listed.flatMap((dir) => readFolder(dir, 'listed', warnings)),
      ...(where.repo && repo ? readFolder(where.repo, 'repo', warnings, repo.root) : []),
      ...repoOld,
    ];
    warnings.push(...oldEnvWarnings());
    if (old.length > 0) warnings.push(oldFolderWarning(where.userOld, true));
    if (repoOld.length > 0 && where.repoOld) warnings.push(oldFolderWarning(where.repoOld, false));
    return { files, folder: f, ...(repo ? { repo } : {}), warnings };
  };

  /** Which of the toil project's repos the folder is: by path first, then by `origin`. */
  const matchRepo = (toilProject: ToilProject, f: Folder, repo: FolderRepo | undefined): { name: string; by: 'path' | 'remote' } | undefined => {
    const root = repo?.root ?? f.path;
    if (root) {
      const byPath = toilProject.repos.find((r) => r.path !== undefined && samePath(r.path, root));
      if (byPath) return { name: byPath.name, by: 'path' };
    }
    if (repo?.origin) {
      const origin = normalizeRemote(repo.origin);
      const byRemote = toilProject.repos.find((r) => r.remotes.some((remote) => normalizeRemote(remote) === origin));
      if (byRemote) return { name: byRemote.name, by: 'remote' };
    }
    return undefined;
  };

  const usable = (file: ToilProjectFile): file is ToilProjectFile & { toilProject: ToilProject } => file.toilProject !== undefined;

  /**
   * Where a path a call names may be read from, decided before anything is
   * looked at: not toil's own files or a system path, and inside a toil project
   * folder or the workspace (anywhere, with the workspace bound relaxed).
   * Checking first means a path outside can't be probed for whether it exists.
   * Returns where it lies, as a source.
   */
  const bounded = (path: string, cwd: string | undefined, refuse: (why: string, fix: string) => ToilError): ToilProjectSource => {
    const target = real(path);
    if (forbidden(target)) throw refuse("that's one of toil's own files, or a system path.", 'Pass a toil project file, or a toil project by name.');
    const where = places(cwd);
    // ~/.toil/projects (and the old ~/.toil/dossiers) are the only parts of toil's own folder a toil project path may name.
    const source: ToilProjectSource = inside(target, real(user)) || inside(target, real(userOld))
      ? 'user'
      : where.listed.some((d) => inside(target, real(d)))
        ? 'listed'
        : (where.repo && inside(target, real(where.repo))) || (where.repoOld && inside(target, real(where.repoOld)))
          ? 'repo'
          : 'file';
    if (source === 'file' && o.config.bounds?.files !== 'unbounded' && !(o.workspace.dir && inside(target, real(o.workspace.dir)))) {
      throw refuse(
        `it's outside the workspace${o.workspace.dir ? ` (${forwardSlashes(o.workspace.dir)})` : ''} and outside every toil project folder.`,
        'Move it into the workspace, list its folder in projectPaths (or TOIL_PROJECT_PATHS), copy it in with toil projects import, or pass the toil project by name.',
      );
    }
    return source;
  };

  const missing = (path: string) =>
    new ToilError('INVALID_INPUT', `${forwardSlashes(path)} doesn't exist where toil is running.`, {
      fix: "Check the path. If toil runs somewhere else (a container, WSL, another host), its paths aren't yours: pass the toil project by name instead.",
    });

  /** A path on the call, bounded: a `.json` file in the workspace or a toil project place, never toil's config or /proc and /sys. */
  const readPath = (value: string, cwd?: string): ToilProjectFile => {
    const path = fromBase(value, 'The toil project file');
    const refuse = (why: string, fix: string) => new ToilError('INVALID_INPUT', `${forwardSlashes(path)} can't be read as a toil project: ${why}`, { fix });
    if (!path.toLowerCase().endsWith('.json')) throw refuse('a toil project file ends in .json.', 'Pass a toil project file, or a toil project by name.');
    const source = bounded(path, cwd, refuse);
    let realPath: string;
    try {
      realPath = realpathSync.native(path);
      if (!statSync(realPath).isFile()) throw new Error('not a file');
    } catch {
      throw missing(path);
    }
    return readToilProjectFile(realPath, source, o.areas);
  };

  const importFiles: ToilProjectCatalog['importFiles'] = (value) => {
    const path = fromBase(value, 'The import source');
    bounded(path, undefined, (why, fix) => new ToilError('INVALID_INPUT', `toil won't import from ${forwardSlashes(path)}: ${why}`, { fix }));
    let folder: boolean;
    try {
      folder = statSync(path).isDirectory();
    } catch {
      throw missing(path);
    }
    if (!folder) return { folder, files: [path] };
    return { folder, files: readdirSync(path).filter((n) => n.toLowerCase().endsWith('.json')).sort().map((n) => join(path, n)) };
  };

  const find = (nameOrPath: string, cwd?: string): ToilProjectFile & { toilProject: ToilProject } => {
    // A toil project's name is lowercase letters, digits and hyphens; anything else is a path.
    if (!CONNECTION_NAME.test(nameOrPath)) {
      const file = readPath(nameOrPath, cwd);
      if (!usable(file)) throw brokenToilProject(file);
      return file;
    }
    const { files } = scan(cwd);
    // Yours, then a listed folder, then the repository's: the scan's order.
    const named = files.filter((f) => f.toilProject?.name === nameOrPath || (!f.toilProject && basename(f.file).replace(/\.json$/i, '') === nameOrPath));
    const first = named[0];
    if (!first) {
      const known = [...new Set(files.flatMap((f) => (f.toilProject ? [f.toilProject.name] : [])))].sort();
      throw new ToilError('INVALID_INPUT', `There's no toil project named "${nameOrPath}" here.`, {
        fix: known.length ? `Use one of: ${known.join(', ')}; or pass a path to a toil project file.` : 'Create one with toil projects init <name>, or pass a path to a toil project file.',
      });
    }
    if (!usable(first)) throw brokenToilProject(first);
    return first;
  };

  /** Same name in two places: worth saying, naming both files, even when precedence settles it. */
  const sameName = (files: readonly ToilProjectFile[], name: string): Warning[] => {
    const all = files.filter((f) => f.toilProject?.name === name);
    if (all.length < 2) return [];
    return [{ code: 'TOIL_PROJECT_DUPLICATE_NAME', message: `Toil project "${name}" is in ${all.length} places: ${all.map((f) => `${forwardSlashes(f.file)} (${f.source})`).join(', ')}. The first is used.` }];
  };

  const select = (request: { toilProject?: string | undefined; cwd?: string | undefined }): Selection => {
    const explicit = request.toilProject ?? (o.env.TOIL_PROJECT || o.env.TOIL_DOSSIER || undefined);
    const by: ToilProjectReport['by'] = request.toilProject !== undefined ? 'input' : 'env';
    const f = folder(request.cwd);
    const repo = repoOf(f.path);
    if (explicit !== undefined) {
      const file = find(explicit, request.cwd);
      const matched = matchRepo(file.toilProject, f, repo);
      const applied: Applied = { file, by, ...(matched ? { match: matched.by, repo: matched.name } : {}) };
      const warnings = [...oldEnvWarnings(), ...(CONNECTION_NAME.test(explicit) ? sameName(scan(request.cwd).files, file.toilProject.name) : [])];
      // A file read from the old folder says so, whichever way it was named.
      const where = places(request.cwd);
      if (inside(real(file.file), real(where.userOld))) warnings.push(oldFolderWarning(where.userOld, true));
      else if (where.repoOld && inside(real(file.file), real(where.repoOld))) warnings.push(oldFolderWarning(where.repoOld, false));
      return { folder: f, ...(repo ? { repo } : {}), applied, candidates: [applied], warnings };
    }
    const scanned = scan(request.cwd);
    const warnings = [...scanned.warnings];
    for (const file of scanned.files) {
      const broken = file.toilProject ? undefined : file.problems.find((p) => p.level === 'error');
      if (broken) warnings.push(problemWarning(file, { ...broken, message: `skipped, because ${broken.message.charAt(0).toLowerCase()}${broken.message.slice(1)}` }));
    }
    const candidates: Applied[] = [];
    const taken = new Set<string>();
    const files = scanned.files.filter(usable);
    for (const found of files) {
      const matched = matchRepo(found.toilProject, f, repo);
      // A toil project checked into the repository you're in applies there, listed repo or not.
      if (!matched && found.source !== 'repo') continue;
      if (taken.has(found.toilProject.name)) continue;
      taken.add(found.toilProject.name);
      // Your own copy of a checked-in toil project (an import) wins wherever the checked-in one applies,
      // then a listed folder's: same name, the scan's order.
      const file = matched ? found : (files.find((x) => x.toilProject.name === found.toilProject.name) ?? found);
      const own = file === found ? matched : matchRepo(file.toilProject, f, repo);
      candidates.push({ file, by: 'folder', match: own?.by ?? 'checked-in', ...(own ? { repo: own.name } : {}) });
    }
    const applied = candidates.length === 1 ? candidates[0] : undefined;
    if (applied) warnings.push(...sameName(scanned.files, applied.file.toilProject.name));
    return { folder: f, ...(repo ? { repo } : {}), ...(applied ? { applied } : {}), candidates, warnings };
  };

  /** The reader's connection that a host selector picks. Never a fallback to the default: that could point the toil project somewhere its author didn't mean. */
  const byHost = (toilProject: ToilProject, area: string, host: string, config: ResolvedConfig = o.config): string => {
    const matches = connectionsOf(config, area).filter((name) => hostMatches(config.connections[name]!, host, areaNames.get(area)?.siteApis));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new ToilError('NOT_CONFIGURED', `Toil project ${toilProject.name} uses the ${area} connection on ${host}, and you have no ${area} connection with that host.`, {
        fix: `Add one with toil connections add <name> --area ${area} (base URL on ${host}), or pass --connection.`,
      });
    }
    throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name} uses the ${area} connection on ${host}, and ${matches.length} of yours are on that host: ${matches.join(', ')}.`, {
      fix: `Pass --connection, or set "connection" instead of "host" in your own copy of the toil project (toil projects import).`,
    });
  };

  const sectionsFor = (toilProject: ToilProject, area: string, env: string | undefined): Section[] =>
    [env === undefined ? undefined : ownValue(ownValue(toilProject.environments, env), area), ownValue(toilProject.sections, area)].filter((s): s is Section => s !== undefined);

  const binding: ToilProjectCatalog['binding'] = (toilProject, area, env, config) => {
    for (const section of sectionsFor(toilProject, area, env)) {
      if (typeof section.connection === 'string') return { connection: section.connection, section };
      if (typeof section.host === 'string') return { connection: byHost(toilProject, area, section.host, config), host: section.host, section };
    }
    return {};
  };

  /** The environment a call works in: its own `--env` where the area has one, else the toil project's. */
  const envOf = (toilProject: ToilProject, area: string, input: Record<string, unknown>): string | undefined => {
    const explicit = areaNames.get(area)?.context.includes('env') ? input.env : undefined;
    return typeof explicit === 'string' ? explicit : toilProject.env;
  };

  const lookupFor = (applied: Applied): ToilProjectLookup => {
    const toilProject = applied.file.toilProject;
    return (area, key, input = {}) => {
      const env = envOf(toilProject, area, input);
      if (key === 'connection') return binding(toilProject, area, env).connection;
      // The toil project's environment is the same `--env` an area already has; it
      // applies to the areas the environment lists (docs/projects.md, One --env).
      if (key === 'env' && areaNames.get(area)?.context.includes('env')) return toilProject.env !== undefined && ownValue(ownValue(toilProject.environments, toilProject.env), area) ? toilProject.env : undefined;
      let stranded: string[] | undefined;
      for (const section of sectionsFor(toilProject, area, env)) {
        const value = ownValue(section, key);
        if (typeof value === 'string') return value;
        if (isRecord(value) && applied.repo !== undefined && typeof ownValue(value, applied.repo) === 'string') return ownValue(value, applied.repo) as string;
        if (isRecord(value) && stranded === undefined) stranded = Object.keys(value);
      }
      // A per-repo value with no repo to read it for must not hand the key to git or the connection: the other inputs
      // came from this toil project, so the pair would be one nobody configured (#540). The call's own value never reaches here.
      // A call that names another per-repo input itself (`--repo`) has chosen its target: the rest is the caller's pairing, not the toil project's.
      const named = (): boolean => sectionsFor(toilProject, area, env).some((section) => Object.keys(section).some((k) => k !== key && (areaNames.get(area)?.context.includes(k) ?? false) && isRecord(ownValue(section, k)) && typeof input[k] === 'string'));
      // A folder that matched a repo the map doesn't name keeps the old fall-through; only a folder matching none is stranded.
      if (stranded !== undefined && applied.repo === undefined) {
        const callNamed = named();
        const repos = toilProject.repos.map((r) => r.name);
        const same = repos.length === stranded.length && repos.every((r) => stranded!.includes(r));
        throw new StrandedInput('INVALID_INPUT', `Toil project ${toilProject.name} sets ${area} ${key} per repo (${stranded.join(', ')}), and the call's folder is none of its repos${repos.length > 0 && !same ? ` (${repos.join(', ')})` : ''}.`, {
          callNamed,
          fix: `Run from inside one of the toil project's repos (--cwd <repo folder>), pass --${key} yourself, or give ${key} a plain value in the toil project.`,
        });
      }
      return undefined;
    };
  };

  const place = (request: { toilProject?: string | undefined; cwd?: string | undefined }): Place => {
    // The folder a call names is checked now: it's the call's own input, and
    // its git applies whether or not any toil project does.
    const named = request.cwd !== undefined ? folder(request.cwd) : undefined;
    const git = named?.path ? o.git(named.path) : {};
    // Which toil project applies is worked out only when the resolver first asks,
    // so a call that never reaches the toil project step (every input given, or an
    // area with nothing set up) can't fail on a toil project it doesn't use.
    let chosen: { applied?: Applied; selection: Selection } | undefined;
    const choose = () => {
      if (chosen) return chosen;
      const selection = select(request);
      if (!selection.applied && selection.candidates.length > 1) {
        throw new ToilError('INVALID_INPUT', `${selection.candidates.length} toil projects apply to ${forwardSlashes(selection.folder.path ?? '')}: ${selection.candidates.map((c) => `${c.file.toilProject.name} (${forwardSlashes(c.file.file)})`).join(', ')}.`, {
          fix: `Pass --toil-project <name>, or set TOIL_PROJECT, to pick one: ${selection.candidates.map((c) => c.file.toilProject.name).join(', ')}.`,
        });
      }
      chosen = { ...(selection.applied ? { applied: selection.applied } : {}), selection };
      return chosen;
    };
    // A toil project the call or TOIL_PROJECT names is checked now, as cwd is: it
    // can't be ambiguous, and a mistyped, broken or out-of-bounds one must
    // fail the call that named it, not wait for one that consults it. Only a
    // match from the folder waits.
    if (request.toilProject !== undefined || o.env.TOIL_PROJECT || o.env.TOIL_DOSSIER) choose();
    let lookup: ToilProjectLookup | undefined;
    return {
      lookup: (area, key, input) => {
        const { applied } = choose();
        if (!applied) return undefined;
        lookup ??= lookupFor(applied);
        return lookup(area, key, input);
      },
      // Your own toil project's bindings are yours; a checked-in, listed or loose
      // file's are suggestions until you import it (docs/projects.md, Writes ask once).
      adopted: (_area, _connection, by) => by === 'toil-project' && chosen?.applied?.file.source === 'user',
      hostFor: (area, input) => {
        const applied = chosen?.applied;
        return applied ? binding(applied.file.toilProject, area, envOf(applied.file.toilProject, area, input)).host : undefined;
      },
      // Only once a toil project was consulted: one that never mattered isn't reported.
      report: () => {
        const applied = chosen?.applied;
        if (!applied) return undefined;
        const f = chosen!.selection.folder;
        const folderReport = (applied.by === 'folder' || request.cwd !== undefined) && f.path ? { folder: { path: forwardSlashes(f.path), from: f.from } } : {};
        return {
          name: applied.file.toilProject.name,
          source: applied.file.source,
          file: forwardSlashes(applied.file.file),
          by: applied.by,
          ...(applied.match ? { match: applied.match } : {}),
          ...(applied.repo ? { repo: applied.repo } : {}),
          ...folderReport,
        };
      },
      fields: (area, input) => {
        const { applied } = choose();
        if (!applied) return {};
        const toilProject = applied.file.toilProject;
        const sections = sectionsFor(toilProject, area, envOf(toilProject, area, input));
        // The environment's section first, so its aliases win.
        return Object.assign({}, ...sections.map((s) => (isRecord(s.fields) ? s.fields : {})).reverse()) as Record<string, string>;
      },
      transitions: (area, input) => {
        const { applied } = choose();
        if (!applied) return {};
        const toilProject = applied.file.toilProject;
        // The area's own section first, so the environment's pins land over it, type by type.
        const out: TransitionPins = {};
        for (const section of sectionsFor(toilProject, area, envOf(toilProject, area, input)).reverse()) {
          if (!isRecord(section.transitions)) continue;
          for (const [type, byIntent] of Object.entries(section.transitions)) {
            if (!isRecord(byIntent)) continue;
            // Types compare ignoring case, so `story` and `Story` are one entry, the environment's landing last.
            const pins = (out[type.toLowerCase()] ??= {});
            for (const [intent, name] of Object.entries(byIntent)) if (typeof name === 'string') pins[intent] = name;
          }
        }
        return out;
      },
      view: (area) => {
        const { applied } = choose();
        if (!applied) return undefined;
        const d = applied.file.toilProject;
        const top = ownValue(d.sections, area);
        const sections = [
          ...(top ? [{ path: area, env: null, values: top }] : []),
          ...Object.entries(d.environments).flatMap(([env, byArea]) => {
            const section = ownValue(byArea, area);
            return section ? [{ path: `environments.${env}.${area}`, env, values: section }] : [];
          }),
        ];
        return { name: d.name, source: applied.file.source, file: forwardSlashes(applied.file.file), env: d.env ?? null, sections };
      },
      warnings: () => {
        if (!chosen) return [];
        const applied = chosen.applied;
        return [...chosen.selection.warnings, ...(applied ? applied.file.problems.filter((p) => p.level === 'warning').map((p) => problemWarning(applied.file, p)) : [])];
      },
      ...git,
    };
  };

  const userFile = (name: string) => join(user, `${name}.json`);

  const repoFolder = (dir: string): string => {
    const path = fromBase(dir, 'The repository');
    const repo = findGitRepo(path, guard);
    if (!repo || !samePath(repo.root, path)) {
      throw new ToilError('INVALID_INPUT', `${forwardSlashes(path)} isn't the root of a git repository${repo ? ` (its root is ${repo.root})` : ''}.`, {
        fix: repo ? `Pass ${repo.root}.` : 'Pass the top folder of a working tree, the one that holds .git.',
      });
    }
    return join(path, '.toil', 'projects');
  };

  const save: ToilProjectCatalog['save'] = (path, toilProject, mode) => {
    assertLocalPath(path, o.workspace.dir, 'The toil project file');
    const target = resolve(path);
    assertLocalPath(target, o.workspace.dir, 'The toil project file');
    const refuse = (why: string, fix: string) => new ToilError('INVALID_INPUT', `toil won't write a toil project to ${forwardSlashes(target)}: ${why}`, { fix });
    if (!target.toLowerCase().endsWith('.json')) throw refuse('a toil project file ends in .json.', 'Name a .json file.');
    // Judged where it would really land, through any link in the folders above it.
    const realTarget = real(target);
    if (forbidden(realTarget)) throw refuse("that's one of toil's own files, or a system path.", 'Write it to your toil project folder, a repository, or the workspace.');
    const where = places();
    // A repository's toil project folder: `.toil/projects/` right under a working tree's root.
    const folderOf = resolve(realTarget, '..');
    const rootOf = resolve(folderOf, '..', '..');
    const inRepoFolder = (basename(folderOf) === 'projects' || basename(folderOf) === 'dossiers') && basename(resolve(folderOf, '..')) === '.toil' && samePath(findGitRepo(rootOf, guard)?.root ?? '', rootOf);
    const inPlace = [user, userOld, ...where.listed].some((d) => inside(realTarget, real(d))) || inRepoFolder;
    const inWorkspace = o.workspace.dir !== undefined && inside(realTarget, real(o.workspace.dir));
    if (!inPlace && !inWorkspace && o.config.bounds?.files !== 'unbounded') {
      throw refuse(`it's outside the workspace${o.workspace.dir ? ` (${forwardSlashes(o.workspace.dir)})` : ''} and outside every toil project folder.`, 'Write it inside the workspace (--workspace <dir> chooses another), or to a repository with --repo.');
    }
    let exists = false;
    try {
      exists = statSync(realTarget).isFile();
    } catch {
      // nothing there yet
    }
    if (exists && mode === 'create') throw refuse('a file is already there.', 'Pass --replace to replace a toil project, or choose another name.');
    if (exists && mode === 'replace' && !readToilProjectFile(realTarget, 'file', o.areas).toilProject) {
      throw refuse("the file there isn't a valid toil project, and toil only ever replaces a toil project.", 'Choose another path, or move that file aside.');
    }
    if (!exists && mode === 'edit') throw refuse('the toil project it was read from is gone.', 'Run the command again.');
    const checked = validateToilProject(toilProjectContent(toilProject), o.areas);
    const errors = checked.problems.filter((p) => p.level === 'error');
    if (errors.length > 0) {
      throw new ToilError('INVALID_INPUT', `That change would leave toil project ${toilProject.name} invalid: ${errors[0]!.path ? `${errors[0]!.path}: ` : ''}${errors[0]!.message} Nothing was written.`, {
        fix: 'Correct the value and run the command again.',
        details: errors.map((p) => ({ path: p.path, message: p.message })),
      });
    }
    // Your own folder is yours alone, as the config is; a repository's files take the repository's.
    const yours = inside(realTarget, real(user)) || inside(realTarget, real(userOld));
    mkdirSync(resolve(realTarget, '..'), { recursive: true, ...(yours ? { mode: 0o700 } : {}) });
    // Written alongside and renamed into place, so a crash halfway leaves the old file, not half a new one.
    const temp = `${realTarget}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(toilProjectContent(toilProject), null, 2)}\n`, { encoding: 'utf8', ...(yours ? { mode: 0o600 } : {}) });
    renameSync(temp, realTarget);
    return forwardSlashes(realTarget);
  };

  const inspect = (dir: string) => {
    const f = folder(dir);
    const repo = repoOf(f.path);
    return { path: f.path!, ...(repo ? { repo } : {}) };
  };

  const scanRepos: ToilProjectCatalog['scanRepos'] = (dir, depth) => {
    const start = dir === undefined ? o.workspace.dir : fromBase(dir, 'The folder');
    if (start === undefined) {
      throw new ToilError('NOT_CONFIGURED', "There's no folder to scan: no workspace is set and none was given.", { fix: 'Pass a folder, or give the MCP server a workspace with --workspace <dir>.' });
    }
    const root = folder(start).path!;
    if (o.config.bounds?.files !== 'unbounded' && !(o.workspace.dir && inside(real(root), real(o.workspace.dir)))) {
      throw new ToilError('INVALID_INPUT', `${forwardSlashes(root)} is outside the workspace${o.workspace.dir ? `, ${forwardSlashes(o.workspace.dir)}` : ''}. Scans stay inside it.`, {
        fix: 'Scan a folder inside the workspace, or choose another workspace with --workspace <dir>.',
      });
    }
    const repos: ScannedRepo[] = [];
    let visited = 0;
    let truncated = false;
    const queue: Array<[string, number]> = [[root, 0]];
    while (queue.length > 0) {
      const [dir, level] = queue.shift()!;
      if (++visited > SCAN_LIMIT) {
        truncated = true;
        break;
      }
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => e.name === '.git')) {
        const repo = findGitRepo(dir, guard);
        if (repo && samePath(repo.root, dir)) {
          const branch = readGitBranch(repo) ?? 'unknown';
          const remotes = Object.fromEntries(readGitRemotes(repo, guard).map((r) => [r.name, stripUserinfo(r.url.split(' ')[0]!)]));
          repos.push({ name: basename(dir), path: repo.root, branch, remotes });
          // A repository's own folders hold its files, not other repositories.
          continue;
        }
      }
      if (level >= depth) continue;
      // Links aren't followed, so a scan can't wander out of the folder it was given.
      for (const e of entries.filter((x) => x.isDirectory() && !x.isSymbolicLink() && !SCAN_SKIP.has(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        queue.push([join(dir, e.name), level + 1]);
      }
    }
    repos.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { folder: forwardSlashes(root), repos, truncated };
  };

  const lookupOf: ToilProjectCatalog['lookupOf'] = (toilProject, repo) => lookupFor({ file: { file: '', source: 'user', problems: [], toilProject }, by: 'input', ...(repo !== undefined ? { repo } : {}) });

  return { places, scan, find, select, place, binding, userFile, lookupOf, importFiles, pathFor: fromBase, inspect, scanRepos, repoFolder, save };
}


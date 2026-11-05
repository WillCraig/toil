/**
 * Stale sessions (#305): what an agent session started on, and whether the
 * ground has moved under it since. A chat or an assignment records an
 * install fingerprint when it starts; every check works out the current one
 * and compares. Pure, so the server, the page and the preview all say the
 * same thing in the same words.
 *
 * - **toil** and **Toil UI**: each one's version and the commit it was built
 *   from. A session records what the server runs; the current one is what is
 *   on disk, so an upgrade marks the sessions stale before anyone restarts.
 * - **skills**: one SHA-256 per toil area of the tools the agent was handed
 *   (each tool's name, description and input). Toil UI loads no skill page:
 *   those tools are the toil instructions its agents read.
 * - **toil project**: SHA-256 of the toil project as `toil projects show` reads it.
 * - **prompts**: SHA-256 of the system prompt and the starter or task
 *   prompts, with the person's own instructions and voice.
 *
 * A session Toil UI didn't start (or one recorded before fingerprints were)
 * records `null`: nobody knows what it started on, so it is never called
 * stale or renewed. A best-before date, printed on the carton, which the
 * carton is not allowed to argue with.
 */

/** One build: its version, and the commit it was built from, or null when the build didn't record one. */
export interface Build {
  version: string;
  commit: string | null;
}

export interface Fingerprint {
  toil: Build;
  toilUi: Build;
  /** One hash per toil area of the tools a session was handed, by area name. */
  skills: Record<string, string>;
  /** The toil project's hash, or null when toil couldn't read it. */
  toilProject: string | null;
  prompts: string;
}

/** Whether a session is stale, and why, in the words every badge and notice shows. */
export interface Staleness {
  /** Each thing that changed, in a few words: "skills changed: jira, util". */
  reasons: string[];
  /** The whole reason on one line: "started on toil 0.1.0-alpha.3 · now alpha.4 · toil project changed". */
  text: string;
  /**
   * Set while the server itself is older than what is on disk: a session
   * renewed now would start on the old build and be stale at once, so renew
   * waits for a restart, and this says why with the command that does it.
   */
  restart?: string | null;
}

/** The newer version, shortened where it shares the older one's release line: 0.1.0-alpha.3 then "alpha.4". */
export function shortVersion(from: string, to: string): string {
  const dash = to.indexOf('-');
  if (dash > 0 && from.startsWith(to.slice(0, dash + 1))) return to.slice(dash + 1);
  return to;
}

const short = (commit: string | null) => (commit ? commit.slice(0, 7) : 'an unrecorded commit');

/** "toil 0.1.0-alpha.3 · now alpha.4", or the commits when only they differ; null when the builds are the same. */
function buildChange(name: string, from: Build, to: Build): string | null {
  if (from.version !== to.version) return `${name} ${from.version} · now ${shortVersion(from.version, to.version)}`;
  if (from.commit !== to.commit) return `${name} ${from.version} at ${short(from.commit)} · now ${short(to.commit)}`;
  return null;
}

/**
 * How a session's fingerprint differs from the current one, or null when it
 * doesn't (or when nobody knows what it started on). The reasons come in a
 * fixed order: toil, Toil UI, skills, toil project, prompts.
 */
export function staleness(origin: Fingerprint | null | undefined, current: Fingerprint): Staleness | null {
  if (!origin) return null;
  const reasons: string[] = [];
  const builds = [buildChange('toil', origin.toil, current.toil), buildChange('Toil UI', origin.toilUi, current.toilUi)].filter((b): b is string => b !== null);
  const areas = [...new Set([...Object.keys(origin.skills), ...Object.keys(current.skills)])].filter((a) => origin.skills[a] !== current.skills[a]).sort();
  if (areas.length) reasons.push(`skills changed: ${areas.join(', ')}`);
  if (origin.toilProject !== current.toilProject) reasons.push('Toil project changed');
  if (origin.prompts !== current.prompts) reasons.push('prompts changed');
  if (!builds.length && !reasons.length) return null;
  const all = [...builds, ...reasons];
  const text = builds.length ? `started on ${all.join(' · ')}` : `${all.join(' · ')} since it started`;
  return { reasons: all, text };
}

/**
 * The server itself, when the toil or Toil UI on disk isn't the one it runs
 * (#305): what the header shows, with the command that restarts it.
 */
export interface ServerStatus {
  running: { toil: Build; toilUi: Build };
  /** What is on disk now; a part Toil UI couldn't read is the running one. */
  disk: { toil: Build; toilUi: Build };
  /** Why the server is out of date, or null when it isn't. */
  stale: string | null;
  /** The command that starts it again as it was started. */
  restart: string;
}

/** Why the server is out of date: "Toil UI is running toil 0.1.0-alpha.3, and 0.1.0-alpha.4 is installed", or null. */
export function serverStale(running: ServerStatus['running'], disk: ServerStatus['disk']): string | null {
  const parts: string[] = [];
  for (const [name, key] of [['toil', 'toil'], ['Toil UI', 'toilUi']] as const) {
    const r = running[key];
    const d = disk[key];
    if (r.version !== d.version) parts.push(`${name} ${d.version} is installed, and this server runs ${r.version}`);
    else if (r.commit !== d.commit) parts.push(`${name} on disk is at ${short(d.commit)}, and this server runs ${short(r.commit)}`);
  }
  return parts.length ? `${parts.join('; ')}.` : null;
}

/** What a chat's session is: when it started, and whether that has gone stale. */
export interface ChatSession {
  /** When the server recorded its fingerprint: its first question, or its last renew. */
  startedAt: string;
  stale: Staleness | null;
  /** Renewals so far. */
  renewals: number;
}

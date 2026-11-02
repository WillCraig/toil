/**
 * Which GitHub repositories a dossier covers, worked out from the dossier
 * itself and nothing else: the `github` section's `owner` and `repo` (one
 * value for the whole dossier, or one per repo name, `{ "app": "app-repo" }`),
 * the owner and repo `dossiers show` resolved, and the dossier's own `repos`
 * remotes that sit on the same GitHub host. The loader reads each one with
 * `owner` and `repo` passed explicitly, so it never depends on toil guessing a
 * repository from a folder the dossier may not have.
 *
 * A remote has no label saying which service it belongs to, so a host counts
 * as GitHub's when it is github.com or the host of a remote whose owner and
 * repo are the ones the github section already names. The registry of record
 * for which host is which was a spreadsheet, and it has not been consulted.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface GithubRepo {
  owner: string;
  repo: string;
  /** `owner/repo`, the form GitHub items are keyed by. */
  slug: string;
}

const make = (owner: string, repo: string): GithubRepo => ({ owner, repo, slug: `${owner}/${repo}` });

/** A remote as `host`, `owner`, `repo`, for the two-segment paths GitHub uses; null for anything else. */
export function parseRemote(url: string): { host: string; owner: string; repo: string } | null {
  const trimmed = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(trimmed);
  const scp = scheme || /^[a-z]:[\\/]/i.test(trimmed) ? null : /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(trimmed);
  const parts = scheme ?? scp;
  if (!parts) return null;
  const segments = parts[2]!.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return { host: parts[1]!.toLowerCase(), owner: segments[0], repo: segments[1] };
}

/** A section value for one repo name: the plain value for all, or the map's entry for that name. */
const forName = (value: unknown, name: string): string | undefined => {
  if (typeof value === 'string' && value) return value;
  const entry = isRec(value) ? value[name] : undefined;
  return typeof entry === 'string' && entry ? entry : undefined;
};

/**
 * The dossier's GitHub repositories, deduplicated without regard to case:
 * the ones the dossier names first, then the ones only a remote shows.
 * `resolved` is `areas.github.inputs` from `dossiers show` (it follows the
 * dossier's environment); `dossier` is the dossier as written.
 */
export function githubRepos(dossier: Rec, resolved: Record<string, string> | undefined): GithubRepo[] {
  const found: GithubRepo[] = [];
  const has = (owner: string, repo: string) => found.some((f) => f.slug.toLowerCase() === `${owner}/${repo}`.toLowerCase());
  const add = (owner: string | undefined, repo: string | undefined) => {
    if (owner && repo && !has(owner, repo)) found.push(make(owner, repo));
  };
  const section = isRec(dossier.github) ? dossier.github : {};
  add(resolved?.owner, resolved?.repo);

  const names = new Set([...(isRec(section.owner) ? Object.keys(section.owner) : []), ...(isRec(section.repo) ? Object.keys(section.repo) : [])]);
  if (names.size) for (const name of names) add(forName(section.owner, name), forName(section.repo, name));
  else add(forName(section.owner, ''), forName(section.repo, ''));

  const remotes = (Array.isArray(dossier.repos) ? dossier.repos : []).flatMap((r) =>
    isRec(r) && Array.isArray(r.remotes) ? r.remotes.flatMap((u) => (typeof u === 'string' ? [parseRemote(u)] : [])) : [],
  );
  const hosts = new Set(['github.com']);
  for (const remote of remotes) if (remote && has(remote.owner, remote.repo)) hosts.add(remote.host);
  for (const remote of remotes) if (remote && hosts.has(remote.host)) add(remote.owner, remote.repo);
  return found;
}

/**
 * What a credential must be allowed to do for toil to do its job (#561). An
 * area that signs in with a scoped credential (GitHub's personal access
 * tokens) declares, per kind of credential, each scope or permission toil
 * uses and the commands that need it. Core turns that into two lists, what
 * read-only use needs and what everything toil can do needs, which the CLI
 * (`toil connections scopes`), MCP and Toil UI all show from this one place.
 *
 * Declaring is not enforcing: toil never checks a credential's scopes, and a
 * service that refuses a call still answers with its own error. This is the
 * list a person reads before filling in the "scopes" page of a vendor's form,
 * a form that, like most of them, asks for all of it and explains none of it.
 * `test/scopes.test.ts` fails when a command exists that no entry lists.
 */

/** How much a scope lets toil do. */
export type ScopeUse = 'read' | 'write';

/** One scope or permission, and what in toil needs it. */
export interface ScopeEntry {
  /** The vendor's name for it: `repo`, `read:project`, `Pull requests`. */
  name: string;
  /**
   * For a credential that grants each permission at levels (fine-grained
   * tokens): the level this entry is. Left out for a scope that is all or
   * nothing (a classic token's `repo`).
   */
  access?: ScopeUse;
  /** The least use that needs it: `read` if a read-only command does, else `write`. */
  required: ScopeUse;
  /** Every command that needs it, as `toil` is typed without the `toil`: `github pr list`. */
  commands: readonly string[];
  /** Anything a person should know that the name doesn't say. */
  note?: string;
}

/** One kind of credential an area accepts. */
export interface CredentialKind {
  /** `classic`, `fine-grained`. */
  id: string;
  /** What a person calls it, for a radio button. */
  label: string;
  /** How the credential starts, when it does, so a person can tell which they hold. */
  tokenPrefix?: string;
  /** One sentence on what it is and what to know about it. */
  summary: string;
  /** The vendor's page for making one. toil never calls it; a person follows the link. */
  createUrl: string;
  /** Where the vendor takes the scopes in the link, so the form opens filled in. */
  prefill?: { param: string; also?: Record<string, string> };
  entries: readonly ScopeEntry[];
}

/** See {@link AreaSpec.scopes}. */
export interface AreaScopes {
  /** The connection's secret these credentials are (`token`). */
  secret: string;
  kinds: readonly CredentialKind[];
  /** Prefixes of credentials that look right and aren't what toil takes (`gho_`: an OAuth token), to what they are, so a form can say so. */
  otherPrefixes?: Readonly<Record<string, string>>;
}

/** What one use needs from one credential kind: the names, and a link to make a token that has them. */
export interface ScopeNeeds {
  needs: string[];
  createUrl: string;
}

/** A kind as `toil connections scopes` and the registry hand it out. */
export interface DescribedKind {
  id: string;
  label: string;
  tokenPrefix: string | null;
  summary: string;
  createUrl: string;
  readOnly: ScopeNeeds;
  everything: ScopeNeeds;
  entries: ScopeEntry[];
}

export interface DescribedScopes {
  secret: string;
  otherPrefixes?: Record<string, string>;
  kinds: DescribedKind[];
}

const LEVEL: Record<ScopeUse, string> = { read: 'Read', write: 'Read and write' };

/** The entries a use needs, one line each, the highest level per name. */
function needsFor(kind: CredentialKind, use: ScopeUse): ScopeNeeds {
  const entries = kind.entries.filter((e) => use === 'write' || e.required === 'read');
  const best = new Map<string, ScopeUse | null>();
  for (const e of entries) {
    const had = best.get(e.name);
    const level = e.access ?? null;
    best.set(e.name, had === 'write' || level === 'write' ? 'write' : (had ?? level));
  }
  const names = [...best.keys()];
  const needs = names.map((name) => {
    const level = best.get(name);
    return level ? `${name}: ${LEVEL[level]}` : name;
  });
  const createUrl = kind.prefill ? `${kind.createUrl}?${kind.prefill.param}=${names.join(',')}${Object.entries(kind.prefill.also ?? {}).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('')}` : kind.createUrl;
  return { needs, createUrl };
}

/** An area's declaration as the two lists a person reads. Pure, so the page and the command say the same. */
export function describeScopes(scopes: AreaScopes): DescribedScopes {
  return {
    secret: scopes.secret,
    ...(scopes.otherPrefixes ? { otherPrefixes: { ...scopes.otherPrefixes } } : {}),
    kinds: scopes.kinds.map((kind) => ({
      id: kind.id,
      label: kind.label,
      tokenPrefix: kind.tokenPrefix ?? null,
      summary: kind.summary,
      createUrl: kind.createUrl,
      readOnly: needsFor(kind, 'read'),
      everything: needsFor(kind, 'write'),
      entries: kind.entries.map((e) => ({ ...e, commands: [...e.commands] })),
    })),
  };
}

/** A declaration that can't be right, said at startup rather than shown to a person. */
export function assertScopes(area: string, scopes: AreaScopes, secrets: readonly string[]): void {
  if (!secrets.includes(scopes.secret)) throw new Error(`Area ${area}: scopes describe "${scopes.secret}", which isn't one of its secrets.`);
  const ids = new Set<string>();
  for (const kind of scopes.kinds) {
    if (ids.has(kind.id)) throw new Error(`Area ${area}: two credential kinds are called "${kind.id}".`);
    ids.add(kind.id);
    if (!/^https:\/\//.test(kind.createUrl)) throw new Error(`Area ${area}: credential kind "${kind.id}" needs an https createUrl.`);
    if (kind.entries.length === 0) throw new Error(`Area ${area}: credential kind "${kind.id}" lists no scopes.`);
    for (const e of kind.entries) {
      if (e.commands.length === 0) throw new Error(`Area ${area}: scope "${e.name}" of "${kind.id}" lists no commands.`);
      if (e.access !== undefined && e.access !== e.required) throw new Error(`Area ${area}: scope "${e.name}" of "${kind.id}" is the ${e.access} level, so it is required for ${e.access}, not ${e.required}.`);
    }
  }
}

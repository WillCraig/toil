import { pairingKey, type AnyArea } from '../core/area.js';
import { defaultConnectionName, type Settings } from '../core/config.js';
import { resolveConnection } from '../core/connection.js';
import type { ConfigAccess } from '../core/context.js';
import type { SecretStore } from '../core/keychain.js';
import { ToilError } from '../core/errors.js';
import type { Prompter } from '../core/prompt.js';
import { answerYes } from '../core/secret-input.js';

/**
 * Offers to borrow another area's secret instead of asking for one again
 * (`defineArea({ shares: { offer } })`): an Atlassian API token works on Jira
 * Cloud and Confluence Cloud on the same site, so the person who just typed it
 * for one shouldn't have to paste it for the other. Only the person answers.
 * A yes writes the `<key>From` pairing and stores nothing; the secret stays
 * where it was, under the connection that already held it. Filing the same
 * document twice in two departments is a tradition we were happy to retire.
 */

/** One connection whose secret a new or existing connection could borrow, and the settings that secret only works with. */
export interface BorrowOffer {
  key: string;
  from: string;
  /** The lender's values for the area's `match` settings (Jira's email), as text. */
  match: Record<string, string>;
}

const hostOf = (url: unknown): string | null => {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * The offers that apply to a connection of `area` holding `own` (as it
 * resolves: area defaults, `defaults.<area>`, then its own settings), at most
 * one per shared key: the other area's default connection first, then the
 * rest by name. A lender is offered only when the config file holds it and
 * its secret (a store reference, never an env var that the next shell may not
 * have), and that secret actually resolves, so a yes never points at a
 * connection that can't sign in. `self` is left out,
 * should the areas ever be the same.
 */
export async function borrowOffers(
  config: ConfigAccess['config'],
  area: AnyArea,
  own: Settings,
  secrets: SecretStore | undefined,
  signal: AbortSignal,
  self?: string,
): Promise<{ offers: BorrowOffer[]; unreadable: Unreadable[] }> {
  const none = { offers: [], unreadable: [] };
  const shares = area.shares;
  const offer = shares?.offer;
  if (!shares || !offer) return none;
  const other = shares.area;
  const when = Object.entries(offer.when ?? {});
  if (!when.every(([k, v]) => String(own[k] ?? '') === v)) return none;
  const ownHost = hostOf(own.baseUrl);
  if (offer.sameHost && !ownHost) return none;
  const first = defaultConnectionName(config, other.name);
  const names = Object.keys(config.connections)
    .filter((n) => n !== self && config.connections[n]!.area === other.name)
    .sort((a, b) => Number(b === first) - Number(a === first) || a.localeCompare(b));
  const found: BorrowOffer[] = [];
  const unreadable: Unreadable[] = [];
  for (const key of shares.keys) {
    for (const name of names) {
      const theirs: Settings = { ...(other.defaults ?? {}), ...(config.defaults[other.name] ?? {}), ...config.connections[name]! };
      if (!when.every(([k, v]) => String(theirs[k] ?? '') === v)) continue;
      if (offer.sameHost && hostOf(theirs.baseUrl) !== ownHost) continue;
      // The pairing is written to the file, so it may only point at a connection the file holds, whose
      // token the file names (a store reference): one made of this shell's env vars is gone in the next.
      if (config.sources[`${name}.${key}`] !== 'global') continue;
      let lender: Record<string, unknown>;
      try {
        lender = await resolveConnection(config, other, name, () => {}, secrets, signal);
      } catch (err) {
        unreadable.push({ from: name, message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (lender[key] === undefined || lender[key] === '') {
        unreadable.push({ from: name, message: `${name} has no ${key}.` });
        continue;
      }
      const match = Object.fromEntries((offer.match ?? []).filter((m) => lender[m] !== undefined).map((m) => [m, String(lender[m])]));
      found.push({ key, from: name, match });
      break;
    }
  }
  // A lender skipped before the one offered doesn't matter; one skipped with nothing offered does.
  return { offers: found, unreadable: found.length > 0 ? [] : unreadable };
}

/** The warning for each would-be lender whose secret didn't read, with the command that shows why. */
export function warnUnreadable(warn: (w: { code: string; message: string }) => void, area: AnyArea, unreadable: Unreadable[]): void {
  const other = area.shares?.area.name;
  for (const u of unreadable) {
    warn({
      code: 'SECRET_REUSE_UNAVAILABLE',
      message: `${u.from} (${other}) is on the same site and its token would work here, but it couldn't be read, so it wasn't offered: ${u.message} Run toil connections test ${u.from} to check it.`,
    });
  }
}

/**
 * The other area's connections that would have been offered but whose secret
 * didn't read, each with why. Said as a warning rather than skipped in
 * silence, so a person asked for a token they already hold learns the reason.
 */
export interface Unreadable {
  from: string;
  message: string;
}

/** The match settings whose value here differs from the lender's (case aside: an email is one address in any case). */
export function mismatched(offer: BorrowOffer, own: Settings): string[] {
  return Object.entries(offer.match).filter(([k, v]) => own[k] !== undefined && String(own[k]).toLowerCase() !== v.toLowerCase()).map(([k]) => k);
}

/**
 * Asks whether to borrow, `y` by default. When a match setting differs, the
 * question says the secret won't work with it, and `n` is the default instead.
 * Its id is `borrow:<key>`, which Toil UI answers from its radio buttons.
 */
export async function askBorrow(prompt: Prompter, area: AnyArea, offer: BorrowOffer, own: Settings): Promise<boolean> {
  const other = area.shares!.area.name;
  const off = mismatched(offer, own);
  const warning = off.length > 0 ? ` It works only with ${off.map((k) => `${k} ${offer.match[k]}`).join(', ')}, which this connection doesn't use, so it won't sign in here.` : '';
  for (;;) {
    const answer = await prompt.ask(`Use the ${offer.key} from ${offer.from} (${other}) instead of entering one?${warning} y/n`, off.length > 0 ? 'n' : 'y', `borrow:${offer.key}`);
    // An empty answer is the default the question showed, which the prompter has already filled in.
    const yes = answer.trim() === '' ? off.length === 0 : answerYes(answer);
    if (yes !== undefined) return yes;
    if (!prompt.canAskAgain) throw new ToilError('INVALID_INPUT', `The answer to "Use the ${offer.key} from ${offer.from}?" must be y or n. Nothing was saved.`, { fix: `Answer y to use ${offer.from}'s ${offer.key}, or n to enter one.` });
  }
}

/** The pairing setting a yes writes: `apiTokenFrom: corp-jira`. */
export const borrowSetting = (offer: BorrowOffer): Settings => ({ [pairingKey(offer.key)]: offer.from });

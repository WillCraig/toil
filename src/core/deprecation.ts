import type { Warning } from './envelope.js';

/**
 * The warning every retired spelling of a toil project name gets: the CLI path
 * `toil dossiers`, the `--dossier` flag, the TOIL_DOSSIER variables. Each old
 * name keeps working for at least one beta (principle 7); this is how a caller
 * learns what to type instead. The old name was retired with a memo, an
 * all-hands and a slide of the new logo, and this warning is the memo.
 */
export const TOIL_PROJECT_DEPRECATED_NAME = 'TOIL_PROJECT_DEPRECATED_NAME';

/** The warning for one old name, naming what replaces it. `ignored`: the new name is set too, so the old one has no effect here. */
export function deprecatedName(old: string, replacement: string, ignored = false): Warning {
  return {
    code: TOIL_PROJECT_DEPRECATED_NAME,
    message: `${old} is now ${replacement}: dossiers are called toil projects. ${old} still works for now, so change it to ${replacement} before a later release drops it.${ignored ? ` ${replacement} is also set, so ${old} is ignored.` : ''}`,
  };
}

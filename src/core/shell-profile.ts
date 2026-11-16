import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ToilError } from './errors.js';
import { forwardSlashes, nodeFiles } from './files.js';

/**
 * The `toil` alias that `toil setup alias` writes into a shell profile, so a
 * clone runs as `toil` with no npm install, no executable and no admin rights.
 * The alias is a shell function (bash, zsh) or a PowerShell function, because
 * an alias proper doesn't expand in a non-interactive bash, which is where an
 * agent's commands run.
 *
 * The profile is the person's own file, outside the workspace, so this is a
 * documented exception to two bounds (docs/bounds.md, `shell-profile`): it's
 * CLI only, the person running it names the shell or the file, and it touches
 * only the lines between its own two markers, leaving every other byte as it
 * was. It still refuses toil's own files and /proc and /sys. Edits to a
 * personal dotfile are otherwise reviewed by nobody, which is the one review
 * process everybody already follows.
 */
export const SHELLS = ['bash', 'zsh', 'powershell'] as const;
export type Shell = (typeof SHELLS)[number];

export const BEGIN = '# >>> toil alias >>>';
export const END = '# <<< toil alias <<<';
// Leading and trailing spaces on a marker line are tolerated, as the count below tolerates them.
const BLOCK = /^[^\S\r\n]*# >>> toil alias >>>[^\S\r\n]*\r?\n[\s\S]*?^[^\S\r\n]*# <<< toil alias <<<[^\S\r\n]*(?:\r?\n|$)/m;

/** What the alias command needs to know about the machine; tests pass their own. */
export interface SetupHost {
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
  /** `SHELL` and `ZDOTDIR`; nothing else is read. */
  env: { SHELL?: string | undefined; ZDOTDIR?: string | undefined };
  /** Absolute path of the toil.js that is running. */
  bundle: string;
}

/** The lines written between the markers, ending in a newline. */
export function aliasBlock(shell: Shell, bundle: string): string {
  const body =
    shell === 'powershell'
      ? `function toil { node '${bundle.replace(/'/g, "''")}' @args }`
      : `toil() { node '${bundle.replace(/'/g, `'\\''`)}' "$@"; }`;
  return `${BEGIN}\n# Added by \`toil setup alias\`; \`toil setup remove-alias\` takes it out.\n${body}\n${END}\n`;
}

/** `text` with the block added, or put in place of the one already there. */
export function withBlock(text: string, block: string, profile: string): { text: string; change: 'added' | 'updated' | 'unchanged' } {
  unterminated(text, profile);
  const found = BLOCK.exec(text);
  if (found) {
    if (found[0].replace(/\r\n/g, '\n') === block) return { text, change: 'unchanged' };
    return { text: text.slice(0, found.index) + block + text.slice(found.index + found[0].length), change: 'updated' };
  }
  return { text: `${text}${text && !text.endsWith('\n') ? '\n' : ''}${block}`, change: 'added' };
}

/** `text` with the block taken out, if it had one. */
export function withoutBlock(text: string, profile: string): { text: string; removed: boolean } {
  unterminated(text, profile);
  const found = BLOCK.exec(text);
  if (!found) return { text, removed: false };
  return { text: text.slice(0, found.index) + text.slice(found.index + found[0].length), removed: true };
}

/** A start marker with no end would make "the block" mean the rest of the file. */
function unterminated(text: string, profile: string): void {
  const begins = text.split(/\r?\n/).filter((line) => line.trim() === BEGIN).length;
  const ends = text.split(/\r?\n/).filter((line) => line.trim() === END).length;
  if (begins !== ends || begins > 1 || (begins === 1 && !BLOCK.test(text))) {
    throw new ToilError('INVALID_INPUT', `${forwardSlashes(profile)} has ${begins} "${BEGIN}" line(s) and ${ends} "${END}" line(s), so toil can't tell which lines are its own.`, {
      fix: 'Edit the profile by hand so it has at most one toil block, with both marker lines, then run the command again.',
    });
  }
}

/** The shell asked for, else the one `--profile`'s extension or `SHELL` names, else PowerShell on Windows. */
export function pickShell(asked: Shell | undefined, profile: string | undefined, host: SetupHost): Shell {
  if (asked) return asked;
  if (profile?.toLowerCase().endsWith('.ps1')) return 'powershell';
  const named = basename(host.env.SHELL ?? '').replace(/\.exe$/i, '');
  if (named === 'bash' || named === 'zsh') return named;
  if (named === 'pwsh' || host.platform === 'win32') return 'powershell';
  throw new ToilError('INVALID_INPUT', `toil couldn't tell which shell to set up${named ? ` (SHELL is "${named}")` : ' (SHELL is not set)'}.`, {
    fix: `Pass --shell with one of: ${SHELLS.join(', ')}.`,
  });
}

/**
 * Where each shell reads its interactive profile. PowerShell has none toil can
 * work out without asking PowerShell (the Documents folder moves, and the two
 * editions keep separate profiles), so it takes `--profile $PROFILE`.
 */
export function profileFor(shell: Shell, host: SetupHost): string {
  if (shell === 'bash') return join(host.home, '.bashrc');
  if (shell === 'zsh') return join(host.env.ZDOTDIR || host.home, '.zshrc');
  throw new ToilError('INVALID_INPUT', "PowerShell keeps its profile in a folder toil can't work out on its own.", {
    fix: `In the PowerShell you use, run: node '${host.bundle}' setup alias --profile $PROFILE`,
  });
}

/** Refuses a bundle npm installed: npm already put `toil` on PATH, and an alias would only shadow it. */
export function fromClone(bundle: string): void {
  if (forwardSlashes(bundle).split('/').includes('node_modules')) {
    throw new ToilError('INVALID_INPUT', `This toil (${forwardSlashes(bundle)}) was installed by npm, which already put toil on PATH.`, {
      fix: 'setup alias is for running toil from a clone: run it as node <clone>/dist/toil.js setup alias.',
    });
  }
}

/**
 * Reads, changes and writes a profile, through the same refusals every file
 * flag gets: nothing under toil's own config (`protect`), /proc or /sys. The
 * file is written in place, after realpath, so a profile that is a symlink
 * into a dotfiles repository stays one.
 */
export async function editProfile(
  o: { path: string; cwd: string; protect: string[] },
  change: (text: string, path: string) => { text: string },
): Promise<{ path: string; text: string; written: boolean }> {
  const files = nodeFiles({ cwd: o.cwd, stdin: false, unbounded: true, protect: o.protect });
  const path = files.resolve(o.path);
  const exists = files.exists(path);
  const bytes = exists ? await files.readBytes(path) : new Uint8Array();
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new ToilError('INVALID_INPUT', `${forwardSlashes(path)} is saved as UTF-16, which toil doesn't edit.`, {
      fix: 'Save it as UTF-8 (in PowerShell: (Get-Content $PROFILE) | Set-Content -Encoding utf8 $PROFILE), then run the command again.',
    });
  }
  // ignoreBOM keeps a UTF-8 byte-order mark in the text, so it is written back too.
  const before = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const after = change(before, path).text;
  if (after === before) return { path, text: after, written: false };
  try {
    const target = exists ? realpathSync(path) : path;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, after, 'utf8');
  } catch (err) {
    throw new ToilError('INVALID_INPUT', `toil couldn't write ${forwardSlashes(path)}: ${(err as Error).message}`, {
      fix: 'Check the file is writable by you, or pass --profile with another file.',
    });
  }
  return { path, text: after, written: true };
}

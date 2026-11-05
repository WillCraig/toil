import { win32 } from 'node:path';
import { ToilError } from './errors.js';

/**
 * Paths a call hands toil name a file on this machine. On Windows a path that
 * starts with two slashes (`\\host\share\x`, `//host/share/x`) names a file on
 * another machine, and simply asking whether it exists makes Windows open a
 * connection to that host. A device path
 * (`\\?\C:\x`, `\\.\pipe\x`, `\??\x`) skips the normal path rules altogether.
 * So both are refused by looking at the text alone, before any `node:fs` call
 * sees them, and the realpath-based bounds (docs/bounds.md) run only on what's
 * left.
 *
 * The one place a network path is fine is inside a workspace that is itself
 * on a share: the user chose that folder, so a file in it is as local as the
 * workspace is. A device path is never fine.
 *
 * The check reads both slash kinds on every platform, so the same input is
 * refused the same way on Windows, macOS and Linux (principle 8). A file on a
 * share is, for filing purposes, held at another branch office.
 */

/** What kind of path `path` is, from its text alone: a network (UNC) path, a Windows device path, or neither. */
export function remotePathKind(path: string): 'unc' | 'device' | undefined {
  const p = path.replace(/\//g, '\\');
  if (/^\\\\[?.](\\|$)/.test(p) || /^\\\?\?(\\|$)/.test(p)) return 'device';
  if (p.startsWith('\\\\')) return 'unc';
  return undefined;
}

/** `child` is `parent` or under it, compared as Windows compares: slashes alike, case ignored, `.` and `..` resolved in the text. */
function lexicallyInside(child: string, parent: string): boolean {
  const norm = (p: string) => win32.normalize(p.replace(/\//g, '\\')).replace(/\\+$/, '').toLowerCase();
  const c = norm(child);
  const w = norm(parent);
  return c === w || c.startsWith(`${w}\\`);
}

/**
 * Throws INVALID_INPUT when `path` is a network or device path, unless it's a
 * network path inside `workspace` and the workspace is itself a network path.
 * Touches nothing on disk. `what` names the value in the message ("The
 * folder", "The toil project file").
 */
export function assertLocalPath(path: string, workspace?: string, what = 'The path'): void {
  const kind = remotePathKind(path);
  if (kind === undefined) return;
  const shown = path.replace(/\\/g, '/');
  if (kind === 'device') {
    throw new ToilError('INVALID_INPUT', `${what} "${shown}" is a Windows device path. toil reads and writes only ordinary files.`, {
      fix: 'Pass an ordinary path, such as C:\\folder\\file, or a path relative to the workspace.',
    });
  }
  if (workspace !== undefined && remotePathKind(workspace) === 'unc' && lexicallyInside(path, workspace)) return;
  throw new ToilError('INVALID_INPUT', `${what} "${shown}" is a network (UNC) path, and toil doesn't open files on other machines${workspace ? ` outside the workspace (${workspace.replace(/\\/g, '/')})` : ''}.`, {
    fix: 'Copy the file into the workspace and pass that path. To work on a share, make a folder on it the workspace: --workspace \\\\<host>\\<share>\\<folder>, or TOIL_WORKSPACE.',
  });
}

/**
 * Local paths as a screen shows them: anything under a home folder starts
 * with `~/`, so the OS account name in the home folder's own path stays off
 * screen and out of recordings (#653). The full path is still one press away:
 * `<Path>`'s Copy button copies it whole.
 *
 * The server says where home is, once, in `api/info`: HOME's folder
 * (USERPROFILE's on Windows), which a demo or scratch home moves, and the
 * account's own from the OS, which it doesn't, so a clone under the real home
 * is shortened too. The longest match wins: a demo home inside the real one
 * shows as `~/.toil-ui/…`, not `~/toil-demo-home/.toil-ui/…`. The sample never
 * sets one, so its paths show as written. A path outside every home is shown
 * whole, never guessed at: another account's `/home/someone` is not `~`.
 */

// The page learns where home is once per load, like a visitor badge issued at
// reception: kept here so every screen can read it without a form in triplicate.
let homes: string[] = [];

/** Sets the home folders the server reported, or clears them (tests, the sample). */
export function setHomes(next: readonly string[] | null | undefined): void {
  homes = [...new Set((next ?? []).map((h) => slashes(h).replace(/\/+$/, '')).filter((h) => h !== ''))].sort((a, b) => b.length - a.length);
}

/** `path` with the home folder that holds it written as `~`, in forward slashes; any other path as given. */
export function homeShort(path: string): string {
  const p = slashes(path);
  for (const home of homes) {
    // Windows compares paths without regard to case; a drive letter or a share is how a page tells it is looking at one.
    const fold = /^[a-z]:\//i.test(home) || /^\/\/[^/]/.test(home);
    const [a, b] = fold ? [p.toLowerCase(), home.toLowerCase()] : [p, home];
    if (a === b) return '~';
    if (a.startsWith(`${b}/`)) return `~${p.slice(home.length)}`;
  }
  return path;
}

/**
 * Every path under a home folder inside a sentence (an error, its fix, a
 * warning, a command shown for approval) written from `~`, in either slash,
 * where a path starts: after a space, a quote, a bracket or the start, and
 * up to a separator or the end of the name (a stop or comma ends it only
 * before a space or the end of the text). The rest of the text is untouched.
 */
export function homeText(text: string): string {
  let out = text;
  for (const home of homes) {
    const forms = [...new Set([home, home.replace(/\//g, '\\')])];
    for (const form of forms) {
      const fold = /^[a-z]:\//i.test(home) || /^\/\/[^/]/.test(home);
      // Punctuation ends the path only when a space or the end follows it: `/Users/me.old` is another folder.
      const re = new RegExp(`(^|[\\s"'\`(\\[=])${escape(form)}(?=[\\\\/]|$|[\\s"'\`)\\]]|[.,;:](?=\\s|$))`, fold ? 'gi' : 'g');
      out = out.replace(re, '$1~');
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slashes = (p: string) => p.replace(/\\/g, '/');

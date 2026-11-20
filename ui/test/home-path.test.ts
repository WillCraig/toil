// The account name in a home folder's path is personal; a screen has no need to say it (#653).
// A screen recording is not the place to announce who signed in, whatever the attendance sheet says.
import { afterEach, describe, expect, it } from 'vitest';
import { homeShort, homeText, setHomes } from '../src/home-path.ts';
import { personalNeedles } from '../scripts/layout-check.mjs';

afterEach(() => setHomes(null));

describe('paths shown from the home folder (#653)', () => {
  it('shows a path under home from ~, on macOS and Linux', () => {
    setHomes(['/Users/someone']);
    expect(homeShort('/Users/someone/toil-demo-home/.toil-ui/cache/worklog/a/2026-10/2026-10-13.md')).toBe('~/toil-demo-home/.toil-ui/cache/worklog/a/2026-10/2026-10-13.md');
    expect(homeShort('/Users/someone')).toBe('~');
    setHomes(['/home/someone/']);
    expect(homeShort('/home/someone/.toil-ui/cache')).toBe('~/.toil-ui/cache');
  });

  it('shows a path under home from ~ on Windows, whatever its slashes or letter case', () => {
    setHomes(['C:\\Users\\Someone']);
    expect(homeShort('C:/Users/Someone/.toil-ui/cache/worklog')).toBe('~/.toil-ui/cache/worklog');
    expect(homeShort('c:\\users\\someone\\.toil-ui\\cache')).toBe('~/.toil-ui/cache');
    expect(homeShort('D:/Users/Someone/x')).toBe('D:/Users/Someone/x');
  });

  it('shows a path under a home on a network share from ~, and leaves a sibling share folder whole', () => {
    setHomes(['\\\\server\\share\\Someone']);
    expect(homeShort('//SERVER/share/someone/x')).toBe('~/x');
    expect(homeShort('//server/share/someone-else')).toBe('//server/share/someone-else');
  });

  it('leaves any other path as it is: another account, a sibling sharing a prefix, a relative path', () => {
    setHomes(['/home/someone']);
    expect(homeShort('/home/someone-else/notes.md')).toBe('/home/someone-else/notes.md');
    expect(homeShort('/home/other/notes.md')).toBe('/home/other/notes.md');
    expect(homeShort('src/sample.ts')).toBe('src/sample.ts');
    // Case matters on macOS and Linux: /Home/Someone is another folder.
    expect(homeShort('/Home/Someone/x')).toBe('/Home/Someone/x');
  });

  it('shows every path whole before the server has said where home is, as the sample does', () => {
    expect(homeShort('/Users/someone/x')).toBe('/Users/someone/x');
    setHomes(['']);
    expect(homeShort('/Users/someone/x')).toBe('/Users/someone/x');
    setHomes(['/']);
    expect(homeShort('/etc/hosts')).toBe('/etc/hosts');
  });

  it('shortens from the account home and a demo home inside it, the longest match first', () => {
    setHomes(['/Users/someone', '/Users/someone/toil-demo-home']);
    expect(homeShort('/Users/someone/toil-demo-home/.toil-ui/cache/worklog')).toBe('~/.toil-ui/cache/worklog');
    expect(homeShort('/Users/someone/Code/payments-core')).toBe('~/Code/payments-core');
    setHomes(['/tmp/scratch-home', '/home/someone']);
    expect(homeShort('/home/someone/src/a')).toBe('~/src/a');
    expect(homeShort('/tmp/scratch-home/.toil')).toBe('~/.toil');
  });
});

describe("the layout check's look for this machine's account (#653)", () => {
  it('looks for each home in either slash and the account name as a home folder, never in a URL, a ref or a sentence', () => {
    const n = personalNeedles({ username: 'some.one', homedir: '/Users/some.one' }, '/Users/some.one/toil-demo-home');
    expect(n.texts).toEqual(['/Users/some.one', '\\Users\\some.one', '/Users/some.one/toil-demo-home', '\\Users\\some.one\\toil-demo-home']);
    const re = new RegExp(n.segment!, 'i');
    expect(re.test('/home/some.one/notes')).toBe(true);
    expect(re.test('C:\\Users\\Some.One\\x')).toBe(true);
    expect(re.test('Reviewed by some.one today')).toBe(false);
    expect(re.test('/Users/someXone/x')).toBe(false);
    expect(re.test('https://github.com/some.one')).toBe(false);
    expect(re.test('refs/heads/some.one/653-x')).toBe(false);
    expect(personalNeedles(null, '/')).toEqual({ texts: [], segment: null });
  });
});

describe('paths inside a sentence (#653)', () => {
  afterEach(() => setHomes(null));

  it('writes each home in an error, a fix or a command from ~, in either slash, and leaves the rest', () => {
    setHomes(['/Users/someone', '/Users/someone/toil-demo-home']);
    expect(homeText('No toil project applies to /Users/someone/Code/toil.')).toBe('No toil project applies to ~/Code/toil.');
    expect(homeText('npm install --prefix /Users/someone/toil-demo-home/.toil-ui/agents x')).toBe('npm install --prefix ~/.toil-ui/agents x');
    expect(homeText('Looked in "/Users/someone" and (/Users/someone/bin).')).toBe('Looked in "~" and (~/bin).');
    expect(homeText('/Users/someone-else/x and /Users/someoneX')).toBe('/Users/someone-else/x and /Users/someoneX');
    expect(homeText('see /Users/someone.old/x, /Users/someone;b and /Users/someone.')).toBe('see /Users/someone.old/x, /Users/someone;b and ~.');
    expect(homeText('https://example.com/Users/someone/x')).toBe('https://example.com/Users/someone/x');
    setHomes(['C:/Users/Someone']);
    expect(homeText('Not found at c:\\users\\someone\\AppData\\npm; set PATH=C:/Users/Someone/bin.')).toBe('Not found at ~\\AppData\\npm; set PATH=~/bin.');
  });

  it('leaves text alone with no home known', () => {
    expect(homeText('No toil project applies to /Users/someone/Code/toil.')).toBe('No toil project applies to /Users/someone/Code/toil.');
  });
});

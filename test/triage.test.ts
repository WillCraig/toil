import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extract, inspect } from '../scripts/triage/archive.mjs';
import { ustar } from './harness/ustar.js';
import { CLAIMED, QUEUED, claim, claimRank, gh, waiting, type LabelEvent } from '../scripts/triage/cap.mjs';
import { CORE_SAFETY, SAFETY_CORE_FOLDERS, SAFETY_ELSEWHERE_CORE, areaOf, check, isUi, isSafetyLayer, parseRaw, refusal } from '../scripts/triage/changes.mjs';
import { agentRan, defuseClosingKeywords, parseDecision } from '../scripts/triage/decision.mjs';
import { areas, labels } from '../scripts/triage/labels.mjs';
import { MAX_LENGTH, MAX_TITLE, parseTerms, redact, redactTitle, tokenShaped } from '../scripts/triage/redact.mjs';
import { redactText } from '../src/core/secret-shapes.js';
import { TOKEN_SHAPES } from '../src/core/token-shapes.mjs';

/**
 * The scripts .github/workflows/triage.yml runs around the triage agent:
 * redaction before it reads anything, the daily cap, and the path check that
 * decides whether its fix may become a pull request. None of this touches
 * the network: GitHub is a fake fetch.
 */

/**
 * One sample per token shape, joined from pieces so no whole token is written
 * in this file, where a host's push protection would rightly object to it.
 */
const SAMPLES: Record<string, string> = {
  'github-token': ['ghp', '_', 'a1B2'.repeat(9)].join(''),
  'gitlab-token': ['glpat', '-', 'x1Y2'.repeat(5)].join(''),
  'slack-token': ['xoxb', '-1234567890-abcdefghij'].join(''),
  'slack-webhook': ['https://hooks.slack.com/services/', 'T0000/B0000/', 'Xx9'.repeat(8)].join(''),
  'aws-access-key': ['AKIA', 'Q3WX7ZP2LM9NBV4C'].join(''),
  'sonar-token': ['squ', '_', 'a1'.repeat(12)].join(''),
  'sk-key': ['sk', '-ant-', 'Ab3'.repeat(8)].join(''),
  'atlassian-token': ['ATATT', 'Zz9'.repeat(8)].join(''),
  'bitbucket-token': ['BBDC', '-', 'Mz4'.repeat(8)].join(''),
  'npm-token': ['npm', '_', 'Ab3'.repeat(12)].join(''),
  'artifactory-token': ['AKCp', 'Xy7'.repeat(8)].join(''),
  'dynatrace-token': ['dt0c01', '.', 'ABC2'.repeat(6), '.', 'xyZ9'.repeat(16)].join(''),
  'figma-token': ['figd', '_', 'Fg5'.repeat(8)].join(''),
  'azure-devops-pat': ['abcd2345'.repeat(6), 'abcd'].join(''),
  'azure-sas': ['sig', '=', 'Ab3%2B'.repeat(4)].join(''),
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMxMjM0NSJ9.c2lnbmF0dXJl',
  'private-key': ['-----BEGIN PRIVATE', ' KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----'].join(''),
};

describe('redact', () => {
  const terms = parseTerms(['# fictional names only', 'acmebank', 'acme-int.example', 're:/initech[- ]?corp/i', 'org', 'jira', 'imagile.dev', 're:/(/'].join('\n'));

  it('refuses denylist entries that would match its own markers, and broken patterns', () => {
    expect(terms.words).toEqual(['acmebank']);
    expect(terms.domains).toEqual(['acme-int.example']);
    expect(terms.patterns).toHaveLength(1);
    expect(terms.invalid).toBe(4);
  });

  it.each([
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'token [redacted-secret]'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', '[redacted-secret]'],
    ['Authorization: Bearer abc.def.ghi-jkl_mno', 'Authorization: Bearer [redacted-secret]'],
    ['TOIL_JIRA_TOKEN=ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz', 'TOIL_JIRA_TOKEN=[redacted-secret]'],
    ['{"apiToken": "s3cr3t-value"}', '{"apiToken": "[redacted-secret]"}'],
    ['clientSecret: hunter22', 'clientSecret: [redacted-secret]'],
    ['toil --token abcd1234 jira get', 'toil --token [redacted-secret] jira get'],
    ['connections set corp.apiToken abcd1234', 'connections set corp.apiToken [redacted-secret]'],
    ['https://jdoe:pa55word@bitbucket.imagile.dev/scm', 'https://[redacted-secret]@bitbucket.imagile.dev/scm'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', '[redacted-secret]'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', '[redacted-secret]'],
    [`scan with ${SAMPLES['sonar-token']}`, 'scan with [redacted-secret]'],
    [`jf ${SAMPLES['artifactory-token']}`, 'jf [redacted-secret]'],
    [`dt ${SAMPLES['dynatrace-token']} end`, 'dt [redacted-secret] end'],
    [`figma ${SAMPLES['figma-token']}`, 'figma [redacted-secret]'],
    [`pat ${SAMPLES['azure-devops-pat']} end`, 'pat [redacted-secret] end'],
    [`https://st.blob.core.windows.net/c/x?sv=2022-11-02&${SAMPLES['azure-sas']}`, 'https://st.blob.core.windows.net/c/x?sv=2022-11-02&sig=[redacted-secret]'],
    [`post ${SAMPLES['slack-webhook']}`, 'post https://hooks.slack.com/services/[redacted-secret]'],
  ])('removes the credential in %j', (input, output) => {
    expect(redact(input, terms)).toBe(output);
  });

  it('removes email addresses but keeps placeholders, GitHub noreply and git@ remotes', () => {
    expect(redact('mail jane.doe@acmebank.example or bob@mail.imagile.dev', terms)).toBe('mail [redacted-email] or [redacted-email]');
    expect(redact('you@example.com, 1+x@users.noreply.github.com, git@github.com:o/r.git', terms)).toBe('you@example.com, 1+x@users.noreply.github.com, git@github.com:o/r.git');
    expect(redact('git@git.acme-int.example:team/repo.git', terms)).toBe('[redacted-email]:team/repo.git');
  });

  it('replaces internal and denylisted hosts, keeping a known service name', () => {
    expect(redact('https://jira.acme-int.example/browse/X-1 and http://build7.corp:8080 and wiki.acmebank.local', terms)).toBe(
      'https://jira.imagile.dev/browse/X-1 and http://redacted.imagile.dev:8080 and redacted.imagile.dev',
    );
    expect(redact('https://jira.imagile.dev and https://github.com', terms)).toBe('https://jira.imagile.dev and https://github.com');
  });

  it('replaces a host after a wildcard, a leading dot, an ellipsis or a hyphen', () => {
    const t = parseTerms('acmebank.example');
    expect(redact('cert for *.acmebank.example expired', t)).toBe('cert for *.redacted.imagile.dev expired');
    expect(redact('cookie domain .acmebank.example', t)).toBe('cookie domain .redacted.imagile.dev');
    expect(redact('see...jira.acmebank.example', t)).toBe('see...jira.imagile.dev');
    expect(redact('cert *.build.internal and host -db.build.internal', t)).toBe('cert *.redacted.imagile.dev and host -redacted.imagile.dev');
    expect(redact('x-.acmebank.example', t)).toBe('x-.redacted.imagile.dev');
  });

  it('still redacts an address or a key name longer than the 64 characters a rule reads', () => {
    expect(redact(`${'a'.repeat(65)}@mail.acmebank.example`, terms)).not.toContain('acmebank');
    expect(redact(`${'a'.repeat(65)}@gmail.com`, terms)).not.toContain('@gmail.com');
    expect(redact(`TOIL_${'X'.repeat(70)}_TOKEN=abcdefgh`, terms)).toContain('_TOKEN=[redacted-secret]');
  });

  it('replaces private addresses only', () => {
    expect(redact('10.1.2.3 172.16.0.9 192.168.1.1 127.0.0.1 169.254.1.1 100.64.0.1 8.8.8.8 172.32.0.1 999.1.1.1', terms)).toBe(
      '[redacted-ip] [redacted-ip] [redacted-ip] [redacted-ip] [redacted-ip] [redacted-ip] 8.8.8.8 172.32.0.1 999.1.1.1',
    );
  });

  it('replaces denylisted words as whole words and patterns, in any case', () => {
    expect(redact('AcmeBank uses Initech Corp; acmebankcli stays', terms)).toBe('[org] uses [org]; acmebankcli stays');
  });

  it('is idempotent', () => {
    const once = redact('ghp_abcdefghijklmnopqrstuvwxyz0123456789 jane@acmebank.example https://jira.acme-int.example 10.0.0.1 AcmeBank password=hunter22', terms);
    expect(redact(once, terms)).toBe(once);
  });

  it("reads every token shape toil's own redactor reads, from the one shared list", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(TOKEN_SHAPES.map((s) => s.id).sort());
    for (const [id, sample] of Object.entries(SAMPLES)) {
      expect(tokenShaped(sample), id).toBe(true);
      expect(redact(sample, terms), id).toContain('[redacted-secret]');
      expect(redactText(sample), id).toContain('[redacted]');
    }
  });

  it('normalises first: a token in fullwidth letters or split by invisible characters is still a token', () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    const fullwidth = [...token].map((c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join('');
    expect(redact(`token ${fullwidth}`, terms)).toBe('token [redacted-secret]');
    expect(redact(`token ${token.slice(0, 6)}\u200b${token.slice(6, 12)}\u2060\u00ad${token.slice(12)}`, terms)).toBe('token [redacted-secret]');
    expect(redact('wiki.acme\u200dbank.local and AcmeBa\ufeffnk', terms)).toBe('redacted.imagile.dev and [org]');
    // The feedback function's zero-width space after an @, which keeps a mention quiet, survives a second pass.
    expect(redact('cc @\u200bsomeone', terms)).toBe('cc @\u200bsomeone');
  });

  it('cuts text to MAX_LENGTH before redacting it, never in the middle of a character', () => {
    expect(redact('a'.repeat(MAX_LENGTH * 4), terms)).toHaveLength(MAX_LENGTH);
    expect(redact(`${'a'.repeat(MAX_LENGTH - 1)}😀`, terms)).toBe('a'.repeat(MAX_LENGTH - 1));
  });

  it('stays fast on a 65,536-character body whatever it is made of: within 50 times plain prose of the same length', () => {
    const fill = (unit: string) => unit.repeat(Math.ceil(MAX_LENGTH / unit.length)).slice(0, MAX_LENGTH);
    // The best of three runs, so a garbage collection or a busy runner doesn't decide the result.
    const time = (text: string) => {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        redact(text, terms);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const prose = fill('The quick brown fox filed a bug about the build. ');
    time(prose);
    const baseline = Math.max(2, time(prose));
    // Long runs of one pattern: a rule that restarts at every character of a run would be quadratic on them.
    const repetitive = ['a.', 'a', '-', '1.', 'A1', 'set a', 'eyJaaaa.', 'dt0c01.', 'abcdefg2', 'a@-.', 'x://a:', 'token' + ' '.repeat(64), 'a'.repeat(512) + 'token='];
    for (const unit of repetitive) expect(time(fill(unit)), JSON.stringify(unit.slice(0, 12))).toBeLessThan(baseline * 50);
    expect(time('a.'.repeat(MAX_LENGTH * 8))).toBeLessThan(baseline * 50);
  });

  it('runs as a CLI: JSON in, JSON out, terms only from env', () => {
    const out = execFileSync(process.execPath, ['scripts/triage/redact.mjs'], {
      input: JSON.stringify({ title: 'AcmeBank jira', body: 'see 10.0.0.1' }),
      env: { ...process.env, REDACT_TERMS: 'acmebank' },
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toEqual({ title: '[org] jira', body: 'see [redacted-ip]', changed: true, invalidTerms: 0 });
  });
});

describe('the daily cap', () => {
  const ev = (id: number, issue: number, at: string, name = CLAIMED, event = 'labeled'): LabelEvent => ({ id, event, created_at: at, label: { name }, issue: { number: issue } });
  const today = '2026-10-18';

  it('ranks today\'s distinct claims by event id, ignoring other days, labels and unlabel events', () => {
    const events = [
      ev(9, 30, '2026-10-18T09:00:00Z'),
      ev(8, 31, '2026-10-18T08:00:00Z', CLAIMED, 'unlabeled'),
      ev(7, 31, '2026-10-18T08:00:00Z'),
      ev(6, 30, '2026-10-18T07:00:00Z'),
      ev(5, 29, '2026-10-18T06:00:00Z', 'bug'),
      ev(4, 28, '2026-10-17T23:59:59Z'),
    ];
    expect(claimRank(events, 30, today)).toBe(1);
    expect(claimRank(events, 31, today)).toBe(2);
    expect(claimRank(events, 28, today)).toBe(0);
    expect(claimRank(events, 29, today)).toBe(0);
  });

  it('picks waiting issues oldest first: queued, never picked up, or holding a dead claim', () => {
    const issue = (number: number, labels: string[], state = 'open') => ({ number, state, labels: labels.map((name) => ({ name })) });
    const list = [issue(9, ['from-terminal']), issue(3, [QUEUED, 'from-website']), issue(4, ['from-website', 'triaged']), issue(5, ['bug']), issue(6, ['from-website'], 'closed'), issue(7, [CLAIMED, 'from-website']), issue(8, ['from-website', 'denied'])];
    expect(waiting(list).map((i) => i.number)).toEqual([3, 7, 9]);
  });

  /** A fake GitHub holding one issue's labels and the repository's label events. */
  function fakeGitHub(issues: Record<number, string[]>, prior: LabelEvent[] = [], at = '2026-10-18T12:00:00Z') {
    const events = [...prior];
    let id = 100;
    const calls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const path = url.replace('https://api.github.com', '');
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      const issueMatch = /^\/repos\/o\/r\/issues\/(\d+)(\/labels(?:\/(.+))?)?$/.exec(path);
      if (method === 'GET' && path.startsWith('/repos/o/r/issues/events')) return Response.json([...events].sort((a, b) => b.id - a.id));
      if (issueMatch) {
        const n = Number(issueMatch[1]);
        if (method === 'GET') return Response.json({ number: n, state: 'open', labels: issues[n]!.map((name) => ({ name })) });
        if (method === 'POST') {
          for (const name of (JSON.parse(String(init!.body)) as { labels: string[] }).labels) {
            if (!issues[n]!.includes(name)) {
              issues[n]!.push(name);
              events.push({ id: ++id, event: 'labeled', created_at: at, label: { name }, issue: { number: n } });
            }
          }
          return Response.json([]);
        }
        if (method === 'DELETE') {
          const name = decodeURIComponent(issueMatch[3]!);
          issues[n] = issues[n]!.filter((l) => l !== name);
          events.push({ id: ++id, event: 'unlabeled', created_at: at, label: { name }, issue: { number: n } });
          return new Response(null, { status: 204 });
        }
      }
      throw new Error(`No route for ${method} ${path}`);
    }) as typeof fetch;
    return { fetcher, issues, calls };
  }

  it('lets the first four claims of the day run and queues the fifth', async () => {
    const prior = [1, 2, 3, 4].map((n, i) => ev(10 + i, n, '2026-10-18T0' + i + ':00:00Z'));
    const github = fakeGitHub({ 5: ['from-website'], 3: ['from-website', CLAIMED] }, prior);
    const options = { fetcher: github.fetcher, token: 't', now: new Date('2026-10-18T12:00:00Z') };
    expect(await claim('o/r', 5, 4, options)).toEqual({ run: false, reason: expect.stringContaining('queued') });
    expect(github.issues[5]).toEqual(['from-website', QUEUED]);
    expect(await claim('o/r', 3, 4, options)).toEqual({ run: true, reason: 'claim 3 of 4 today' });
  });

  it('renews a claim left from an earlier day, so it counts today', async () => {
    const github = fakeGitHub({ 7: ['from-website', CLAIMED] }, [ev(1, 7, '2026-10-17T10:00:00Z')]);
    const result = await claim('o/r', 7, 4, { fetcher: github.fetcher, token: 't', now: new Date('2026-10-18T12:00:00Z') });
    expect(result.run).toBe(true);
    expect(github.calls).toContain(`DELETE /repos/o/r/issues/7/labels/${CLAIMED}`);
  });

  it('retries GitHub on 5xx, 429 and network errors, and not on a 4xx', async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) throw new Error('ECONNRESET');
      if (n === 2) return new Response('', { status: 502 });
      if (n === 3) return new Response('', { status: 429 });
      return Response.json({ ok: true });
    }) as typeof fetch;
    expect(await gh('GET', '/x', undefined, { fetcher: flaky, token: 't', pause: 0, attempts: 4 })).toEqual({ ok: true });
    const refused = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    await expect(gh('GET', '/x', undefined, { fetcher: refused, token: 't', pause: 0 })).rejects.toThrow('returned 403');
  });
});

describe('the path check', () => {
  const known = ['jira', 'demo-cloud', 'github'];

  it.each([
    ['src/areas/jira/commands.ts', 'jira'],
    ['src/areas/demo-cloud/index.ts', 'demo-cloud'],
    ['test/fixtures/jira.fixture.ts', 'jira'],
    ['skills/toil/github.md', 'github'],
    ['docs/divergences/jira.json', 'jira'],
    ['site/src/data/integrations/jira.json', 'jira'],
    ['site/src/data/commands/jira.json', 'jira'],
    ['site/src/data/settings/jira.json', 'jira'],
  ])('allows %s', (path, area) => {
    expect(areaOf(path, known)).toBe(area);
  });

  it.each([
    'ui/src/load.ts', 'ui/src/components/panel.tsx', 'ui/server/server.ts', 'ui/server/agents/env.ts', 'ui/server/agents/tested.ts', 'ui/test/registry.test.ts', 'ui/test/views.test.tsx', 'ui/docs/themes.md', 'ui/themes/plain/theme.json',
  ])('allows %s as Toil UI', (path) => {
    expect(isUi(path)).toBe(true);
    expect(check([{ path, newMode: '100644' }], known)).toMatchObject({ ok: true, areas: [], ui: true, refused: [] });
  });

  it.each([
    'ui/package.json', 'ui/tsconfig.json', 'ui/vite.config.ts', 'ui/scripts/layout-check.mjs', 'ui/server/agents/install.ts', 'ui/src/../../src/core/x.ts', 'ui/srcx/a.ts', 'ui', 'ui/src/', 'ui\\src\\a.ts', 'ui/README.md',
  ])('refuses %s as Toil UI', (path) => {
    expect(isUi(path)).toBe(false);
  });

  const edit = (path: string, newMode = '100644') => ({ path, newMode });

  it('lets one area and Toil UI change together, and now any number of areas and core', () => {
    expect(check([edit('src/areas/demo-cloud/a.ts'), edit('ui/src/load.ts')], known)).toMatchObject({ ok: true, areas: ['demo-cloud'], ui: true, core: false, refused: [] });
    expect(check([edit('src/areas/jira/a.ts'), edit('src/areas/github/a.ts'), edit('ui/src/load.ts')], known)).toMatchObject({ ok: true, areas: ['github', 'jira'], ui: true, refused: [] });
    expect(check([edit('ui/src/load.ts'), edit('src/core/files.ts')], known)).toMatchObject({ ok: true, ui: true, core: true, refused: [] });
    expect(check([edit('ui/src/load.ts', '120000')], known).ok).toBe(false);
  });

  it.each([
    'src/core/execute.ts', 'src/core/paginate.ts', 'src/registry.ts', 'src/program.ts', 'src/areas/newthing/index.ts', 'test/triage.test.ts', 'test/fixtures/jira.fixture.ts.bak',
    'skills/toil/core.md', 'skills/toil/SKILL.md', 'docs/integrations.md', 'docs/divergences/jira.json', 'README.md', 'ui/src/load.ts',
  ])('lets a fix change %s', (path) => {
    expect(refusal(path, known)).toBeUndefined();
    expect(check([edit(path)], known).ok).toBe(true);
  });

  it('accepts a core fix and reports it', () => {
    expect(check([edit('src/core/paginate.ts'), edit('src/core/paginate.test.ts'), edit('skills/toil/core.md')], known)).toEqual({ ok: true, areas: [], ui: false, core: true, safety: ['skills/toil/core.md'], refused: [] });
  });

  it.each([
    'site/src/pages/feedback.astro', 'site/src/components/Footer.astro', 'site/src/data/levels.json', 'site/src/data/integrations/newarea.json',
    'functions/feedback/src/lib/handlers.ts', 'functions/feedback/README.md', 'infra/main.bicep', 'infra/bootstrap.sh',
  ])('leaves %s for a maintainer to review first, and a fix may not edit it', (path) => {
    expect(refusal(path, known)).toContain('for a maintainer to review first');
    expect(check([edit(path)], known).ok).toBe(false);
  });

  it('still lets a fix change the per-area site data the tests generate', () => {
    for (const path of ['site/src/data/integrations/jira.json', 'site/src/data/commands/github.json', 'site/src/data/settings/demo-cloud.json']) {
      expect(check([edit(path)], known)).toMatchObject({ ok: true, refused: [] });
    }
  });

  it.each([
    '.github/workflows/triage.yml', '.github/workflows/discord-notify.yml', '.github/CODEOWNERS', 'scripts/triage/changes.mjs', 'scripts/spawners.mjs', 'CLAUDE.md', 'AGENT_DECISIONS.md',
    '.claude/skills/automation/SKILL.md', 'docs/decisions/123-anything.md', 'dist/toil.js', 'dist/toil-lib.js',
  ])('never lets a fix change %s: the rules that constrain triage (principle 2)', (path) => {
    expect(refusal(path, known)).toContain("triage's own rules");
    expect(check([edit(path)], known).ok).toBe(false);
  });

  it.each(['package.json', 'package-lock.json', 'ui/package.json', 'src/areas/jira/package.json', 'functions/feedback/package-lock.json'])('refuses %s: it needs npm, which the agent does not have', (path) => {
    expect(check([edit(path)], known).ok).toBe(false);
    expect(refusal(path, known)).toMatch(/needs npm|maintainer to review/);
  });

  it.each(['tsconfig.json', '.npmrc', 'release-please-config.json', 'LICENSE', '.gitignore', '.scratch/x.json', 'unknown/file.ts', 'ui', 'src', '../x', 'src/../scripts/x.mjs', 'src\\core\\x.ts'])('refuses %s: not a place triage works', (path) => {
    expect(check([edit(path)], known).ok).toBe(false);
  });

  it('lists every safety-layer edit, so the draft can lead with them, and only those', () => {
    const result = check([edit('ui/server/csp.ts'), edit('ui/server/agents/tools.ts'), edit('ui/src/config.ts'), edit('ui/test/server.test.ts'), edit('ui/src/load.ts'), edit('ui/server/sync.ts')], known);
    expect(result).toMatchObject({ ok: true, ui: true, safety: ['ui/server/agents/tools.ts', 'ui/server/csp.ts', 'ui/server/sync.ts', 'ui/src/config.ts', 'ui/test/server.test.ts'] });
    expect(check([edit('ui/src/load.ts')], known).safety).toEqual([]);
    // The folder is flagged whole, so a file added later is too; so are theme.json and the suites that check Toil UI's own rules.
    const flagged = ['ui/server/main.ts', 'ui/server/agents/mcp.ts', 'ui/server/assign/runner.ts', 'ui/server/brand-new.ts', 'ui/themes/plain/theme.json', 'ui/test/registry.test.ts', 'ui/src/config.ts'];
    expect(flagged.every((p) => isSafetyLayer(p) && isUi(p))).toBe(true);
    expect(['ui/src/load.ts', 'ui/test/views.test.tsx', 'ui/themes/plain/theme.css', 'ui/docs/themes.md'].some(isSafetyLayer)).toBe(false);
  });

  it("flags edits to toil's own safety files the same way, tests beside them included", () => {
    const flagged = [
      'src/core/run.ts', 'src/core/call-context.ts', 'src/core/keychain.ts', 'src/core/keychain.test.ts', 'src/core/secret-input.ts', 'src/core/files.ts', 'src/core/local-path.ts',
      'src/core/git.ts', 'src/core/git-repo.ts', 'src/core/network.ts', 'src/core/rest.ts', 'src/core/api.ts', 'src/core/bounds.ts', 'src/core/audit.ts', 'src/core/config.ts',
      'src/core/passthrough.ts', 'src/core/token.ts', 'src/core/token-shapes.mjs', 'src/os/windows-sspi.ts', 'src/shims/no-spawn.ts', 'src/mcp/server.ts', 'src/mcp/anything-new.ts',
      'docs/bounds.md', 'test/bounds.test.ts', 'test/parity.test.ts', 'src/api.ts',
      'src/core/wait.ts', 'src/core/time-limit.test.ts', 'src/core/wildmatch.ts', 'src/core/query/parse.ts', 'src/welcome/rogue/save.ts', 'src/connections/add.ts', 'src/skills/folders.ts',
      'src/setup/commands.ts', 'src/feedback/command.ts', 'src/projects/build.ts', 'docs/command-contract.json', 'docs/command-contract.md', 'test/contract.test.ts', 'test/triage.test.ts',
      'test/triage-steps.test.ts', 'test/workflow-wiring.test.ts', 'test/merge-only.test.ts', 'test/repo-hygiene.test.ts',
      'skills/toil/SKILL.md', 'skills/toil/core.md', 'skills/toil/projects.md', 'skills/toil/jira.md',
    ];
    expect(flagged.filter((p) => !isSafetyLayer(p))).toEqual([]);
    expect(['src/core/paginate.ts', 'src/areas/jira/commands.ts', 'src/registry.ts', 'docs/integrations.md', 'test/site-commands.test.ts'].some(isSafetyLayer)).toBe(false);
    const result = check([edit('src/core/run.ts'), edit('src/core/paginate.ts'), edit('src/mcp/server.ts'), edit('src/areas/jira/a.ts')], known);
    expect(result).toMatchObject({ ok: true, core: true, areas: ['jira'], safety: ['src/core/run.ts', 'src/mcp/server.ts'] });
  });

  it('every file the safety list names under src/core exists, so the list cannot rot quietly', () => {
    for (const name of CORE_SAFETY) {
      expect(existsSync(join(process.cwd(), 'src', 'core', `${name}.ts`)), name).toBe(true);
    }
    for (const path of SAFETY_ELSEWHERE_CORE) expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    for (const folder of SAFETY_CORE_FOLDERS) expect(existsSync(join(process.cwd(), folder)), folder).toBe(true);
  });

  it('flags every src/ path docs/bounds.md and src/core/bounds.ts name, so the list cannot fall behind the bounds', () => {
    const named = new Set<string>();
    for (const file of ['docs/bounds.md', 'src/core/bounds.ts']) {
      for (const [path] of readFileSync(join(process.cwd(), file), 'utf8').matchAll(/src\/[A-Za-z0-9_./-]+\.(?:ts|mjs)/g)) named.add(path);
    }
    expect(named.size).toBeGreaterThan(10);
    expect([...named].filter((path) => !isSafetyLayer(path))).toEqual([]);
  });

  it.each(['docs/Decisions/x.md', 'ui/server/agents/Install.ts', 'ui/src/Package.json', 'src/core/Run.ts', 'Claude.md', '.GitHub/workflows/triage.yml'])(
    'matches %s without regard to case, so a differently cased path does not slip past',
    (path) => {
      const refused = refusal(path, known) !== undefined;
      expect(refused || isSafetyLayer(path)).toBe(true);
    },
  );

  it('marks a differently cased ui/ or src/ path as Toil UI or core, so the draft still asks for the full gate', () => {
    expect(check([edit('UI/src/app.tsx')], known)).toMatchObject({ ok: true, ui: true });
    expect(check([edit('Src/core/x.ts')], known)).toMatchObject({ ok: true, core: true });
  });

  it('refuses a symlink, a submodule, and an empty change; allows deletes of open files', () => {
    expect(check([edit('src/areas/jira/a.ts', '120000')], known).ok).toBe(false);
    expect(check([edit('src/areas/jira/sub', '160000')], known).ok).toBe(false);
    expect(check([], known).refused).toEqual(['no changes']);
    expect(check([edit('src/areas/jira/a.ts'), edit('src/areas/jira/old.ts', '000000')], known)).toEqual({ ok: true, areas: ['jira'], ui: false, core: false, safety: [], refused: [] });
  });

  it('reads git diff --raw -z from a real repository, so the parser matches what git writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toil-triage-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      mkdirSync(join(dir, 'src', 'areas', 'jira'), { recursive: true });
      writeFileSync(join(dir, 'src', 'areas', 'jira', 'a.ts'), 'a\n');
      writeFileSync(join(dir, 'README.md'), 'r\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      writeFileSync(join(dir, 'src', 'areas', 'jira', 'a.ts'), 'b\n');
      writeFileSync(join(dir, 'src', 'areas', 'jira', 'name with space.ts'), 'c\n');
      git('add', '.');
      git('commit', '-qm', 'fix');
      const entries = parseRaw(git('diff', '--raw', '-z', '--no-renames', 'HEAD~1', 'HEAD'));
      expect(entries.map((e) => e.path).sort()).toEqual(['src/areas/jira/a.ts', 'src/areas/jira/name with space.ts']);
      expect(check(entries, known)).toEqual({ ok: true, areas: ['jira'], ui: false, core: false, safety: [], refused: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the triage labels', () => {
  it('has one area: label per registered area, plus the workflow\'s own', () => {
    const names = labels().map((l) => l.name);
    expect(areas()).toContain('jira');
    expect(areas()).not.toContain('kit');
    expect(names).toEqual(expect.arrayContaining(['area:jira', 'area:github', 'from-website', 'from-terminal', 'unverified-build', 'triaged', 'denied', 'needs-maintainer', 'triage-queued', 'triage-claimed', 'from-triage', 'smoke-test']));
    for (const label of labels()) expect(label.name.length).toBeLessThanOrEqual(50);
  });
});

describe('the handover archive', () => {
  const known = ['jira', 'github'];

  it('reads regular files under one area, deletions included', () => {
    const result = inspect(ustar([{ path: './src/areas/jira/a.ts', data: 'export const a = 1;\n' }, { path: 'skills/toil/jira.md', data: '# Jira\n' }]), './src/areas/jira/old.ts\n', known);
    expect(result).toMatchObject({ ok: true, areas: ['jira'], refused: [], deleted: ['src/areas/jira/old.ts'] });
    expect(result.files.map((f) => [f.path, f.data.toString()])).toEqual([['src/areas/jira/a.ts', 'export const a = 1;\n'], ['skills/toil/jira.md', '# Jira\n']]);
  });

  it('reads a long path from the ustar prefix field', () => {
    const long = `src/areas/jira/${'deep/'.repeat(20)}file.ts`;
    expect(inspect(ustar([{ path: long, data: 'x' }]), '', known).files[0]!.path).toBe(long);
  });

  it.each([
    [[{ path: 'src/areas/jira/link', type: '2' }], 'type 2: only regular files'],
    [[{ path: 'src/areas/jira/hard', type: '1' }], 'type 1: only regular files'],
    [[{ path: 'src/areas/jira/x', type: 'L' }], 'type L: only regular files'],
    [[{ path: '.github/workflows/ci.yml', data: 'x' }], ".github/workflows/ci.yml (triage's own rules"],
    [[{ path: 'src/areas/jira/../../core/x.ts', data: 'x' }], 'not a plain path'],
    [[{ path: 'package.json', data: 'x' }], 'needs npm'],
  ])('refuses %j', (entries, reason) => {
    const result = inspect(ustar(entries), '', known);
    expect(result.ok).toBe(false);
    expect(result.refused.join('\n')).toContain(reason);
  });

  it('refuses a deletion outside the area, a corrupt header, and an empty change', () => {
    expect(inspect(ustar([{ path: 'src/areas/jira/a.ts', data: 'x' }]), 'package.json\n', known).ok).toBe(false);
    const corrupt = ustar([{ path: 'src/areas/jira/a.ts', data: 'x' }]);
    corrupt[0] = 'Z'.charCodeAt(0);
    expect(inspect(corrupt, '', known).refused[0]).toContain('not a valid ustar header');
    expect(inspect(Buffer.alloc(0), '', known).refused).toEqual(['no changes']);
  });

  it('extracts only inside the destination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'toil-archive-'));
    try {
      mkdirSync(join(dir, 'src', 'areas', 'jira'), { recursive: true });
      writeFileSync(join(dir, 'src', 'areas', 'jira', 'old.ts'), 'old');
      const result = inspect(ustar([{ path: 'src/areas/jira/new.ts', data: 'new' }]), 'src/areas/jira/old.ts', known);
      extract(result, dir);
      expect(readFileSync(join(dir, 'src', 'areas', 'jira', 'new.ts'), 'utf8')).toBe('new');
      expect(existsSync(join(dir, 'src', 'areas', 'jira', 'old.ts'))).toBe(false);
      expect(() => extract({ files: [{ path: '../escape.ts', data: Buffer.from('x') }], deleted: [] }, dir)).toThrow('resolves outside');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the agent decision', () => {
  const known = ['jira', 'github'];

  it('accepts fix, maintainer, deny and duplicate with known areas', () => {
    expect(parseDecision('{"decision":"fix","areas":["jira"]}', 7, known)).toMatchObject({ ok: true, decision: 'fix', areas: ['jira'] });
    expect(parseDecision('{"decision":"maintainer","areas":[]}', 7, known)).toMatchObject({ ok: true, decision: 'maintainer', areas: [] });
    expect(parseDecision('{"decision":"duplicate","areas":[],"duplicateOf":3}', 7, known)).toMatchObject({ ok: true, duplicateOf: 3 });
  });

  it.each([
    ['not json', 'missing or not JSON'],
    ['{"decision":"merge","areas":[]}', 'decision must be fix, maintainer, deny or duplicate'],
    ['{"decision":"fix","areas":["jira","core"]}', 'unknown areas: core'],
    ['{"decision":"duplicate","areas":[],"duplicateOf":7}', 'duplicateOf must be another issue number'],
    ['{"decision":"fix"}', 'areas must be a list'],
  ])('refuses %s', (raw, problem) => {
    const result = parseDecision(raw, 7, known);
    expect(result.ok).toBe(false);
    expect(result.problems.join('; ')).toContain(problem);
  });

  it.each([
    ['FIXES #12', 'FIXES (see #12)'],
    ['Closes imagile-dev/toil#12', 'Closes (see imagile-dev/toil#12)'],
    ['Resolves https://github.com/imagile-dev/toil/issues/12', 'Resolves (see https://github.com/imagile-dev/toil/issues/12)'],
    ['fixed: #3 and close #4', 'fixed (see #3) and close (see #4)'],
    ['This fixes the parser; see #5', 'This fixes the parser; see #5'],
  ])('defuses the closing reference in %j', (input, output) => {
    expect(defuseClosingKeywords(input)).toBe(output);
  });
});

describe('finish: a failed agent run is not a decision', () => {
  const run = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'toil-decision-'));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const output = join(dir, 'github-output.txt');
      writeFileSync(output, '');
      execFileSync(process.execPath, ['scripts/triage/decision.mjs', dir, '7', 'jira', 'github'], { env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
      const out = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]));
      return { out, comment: existsSync(join(dir, 'comment.checked.md')) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('needs both the agent-ok marker and decision.json', () => {
    expect(agentRan(['agent-ok', 'decision.json'])).toBe(true);
    expect(agentRan(['decision.json'])).toBe(false);
    expect(agentRan(['agent-ok'])).toBe(false);
  });

  it('reports failed, with nothing to comment, when the agent never ran or failed', () => {
    expect(run({})).toEqual({ out: { decision: 'failed' }, comment: false });
    expect(run({ 'decision.json': '{"decision":"deny","areas":[]}' })).toEqual({ out: { decision: 'failed' }, comment: false });
    expect(run({ 'agent-ok': 'ok' })).toEqual({ out: { decision: 'failed' }, comment: false });
  });

  it('reports invalid, labelled triaged only, when the agent ran and decided something refused', () => {
    expect(run({ 'agent-ok': 'ok', 'decision.json': '{"decision":"merge","areas":[]}' })).toEqual({ out: { decision: 'invalid', labels: 'triaged', duplicate_of: '' }, comment: true });
  });

  it('passes a valid decision through with its labels', () => {
    expect(run({ 'agent-ok': 'ok', 'decision.json': '{"decision":"deny","areas":["jira"]}', 'comment.md': 'Out of scope.' }).out).toEqual({ decision: 'deny', labels: 'triaged,denied,area:jira', duplicate_of: '' });
    // maintainer is not a denial: it is labelled needs-maintainer, never denied.
    expect(run({ 'agent-ok': 'ok', 'decision.json': '{"decision":"maintainer","areas":["jira"]}', 'comment.md': 'The site page would change.' }).out).toEqual({ decision: 'maintainer', labels: 'triaged,needs-maintainer,area:jira', duplicate_of: '' });
  });
});

describe('waiting() and needs-human', () => {
  it('never picks an issue a person has to look at', () => {
    const list = [{ number: 3, state: 'open', labels: [{ name: QUEUED }, { name: 'needs-human' }] }, { number: 4, state: 'open', labels: [{ name: QUEUED }] }];
    expect(waiting(list).map((i) => i.number)).toEqual([4]);
  });
});

describe('titles posted outside GitHub (the Discord workflow)', () => {
  const terms = parseTerms('acmebank\nacme-int.example');

  it('redacts a title the way triage redacts an issue: denylisted words, internal hosts, private IPs and tokens', () => {
    expect(redactTitle('AcmeBank outage on jira.acme-int.example from 10.1.2.3', terms)).toBe('[org] outage on jira.imagile.dev from [redacted-ip]');
    expect(redactTitle(`login fails with ${SAMPLES['github-token']}`, terms)).not.toContain(SAMPLES['github-token']!);
    expect(redactTitle(`login fails with ${SAMPLES['github-token']}`, terms)).toContain('[redacted-secret]');
  });

  it('keeps an ordinary title as it was, folds it onto one line and cuts it to fit', () => {
    expect(redactTitle('jira issue get fails on Data Center', terms)).toBe('jira issue get fails on Data Center');
    expect(redactTitle('two\nlines\t here', terms)).toBe('two lines here');
    const long = redactTitle('word '.repeat(100), terms);
    expect(long.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(long.endsWith('…')).toBe(true);
    expect(redactTitle('', terms)).toBe('');
  });

  it('runs from the command line with the title and the denylist in env, never argv', () => {
    const out = execFileSync(process.execPath, ['scripts/triage/redact.mjs', '--title'], { env: { ...process.env, TITLE: 'AcmeBank cannot connect to 10.0.0.9', REDACT_TERMS: 'acmebank' }, encoding: 'utf8' });
    expect(out).toBe('[org] cannot connect to [redacted-ip]\n');
  });
});

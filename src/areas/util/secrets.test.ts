import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callKey } from '../../../test/fixtures/git.fixture.js';
import { ALLOW, ENV, files as samples, PROPERTIES, SSH_KEY, STAGED_DIFF, DIFF_OPTIONS, canned } from '../../../test/fixtures/util-secrets.js';
import { runCli } from '../../../test/harness/cli.js';
import { testContext, type TestContextOptions } from '../../../test/harness/context.js';
import { connectMcp } from '../../../test/harness/mcp.js';
import type { Context } from '../../core/context.js';
import type { FileAccess } from '../../core/files.js';
import type { GitCall, GitResult, GitRunner } from '../../core/git.js';
import { execute } from '../../core/run.js';
import { createNodeContext } from '../../node-context.js';
import { SECRET_RULES } from '../../core/secret-shapes.js';
import { commands } from './index.js';
import { secretsScanCommand } from './secrets.js';
import { detectLine, entropy, fingerprintOf, keepFor, maskSecret, parseDiff, previewIsMasked, scanSecrets, unquoteGitPath, type Finding, type ScanData } from './secrets/scan.js';

/**
 * `util secrets scan`, end to end. Most tests here plant a secret and look
 * for it twice: once to prove it's found where it is, and once, in every
 * byte the CLI, the MCP server and the audit log put out, to prove it isn't
 * repeated. The second search finding nothing is the passing grade.
 */

const REPO = { root: '/work', branch: 'main', remotes: [] };
const ok = (stdout: string): GitResult => ({ exitCode: 0, stdout, stderr: '' });

const SHOW_PREFIX = callKey({ subcommand: 'rev-parse', options: ['--show-prefix'] });

/**
 * A git answering from a map of calls, recording each one, and failing
 * anything else loudly. Unless the map says otherwise, the workspace is the
 * repository's top (`rev-parse --show-prefix` prints an empty line).
 */
function gitOf(answers: Map<string, GitResult>): GitRunner & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  return {
    calls,
    run: async (call) => {
      calls.push(call);
      const found = answers.get(callKey(call)) ?? (callKey(call) === SHOW_PREFIX ? ok('\n') : undefined);
      if (!found) throw new Error(`no canned git output for ${callKey(call)}`);
      return found;
    },
  };
}

const ctxOf = (options: TestContextOptions = {}) => testContext({ repo: REPO, ...options });
const scan = async (input: Record<string, unknown>, options: TestContextOptions = {}) => {
  const { context, audit } = ctxOf(options);
  const envelope = await execute(secretsScanCommand, input, context);
  return { envelope, data: envelope.data as ScanData, audit };
};
const at = (f: Finding) => `${f.file ?? '-'}:${f.line}:${f.column}`;

/**
 * One planted secret per rule, distinctive enough that finding any 8 of its
 * characters in an output means the output leaked it. A rule added to
 * secret-shapes.ts without a line here fails the first test.
 */
/**
 * Joins a planted token from pieces, so the token is never written whole in
 * this inputFile: a host's push protection would otherwise stop it at the door,
 * correctly, for looking exactly like what it is impersonating.
 */
const plant = (...parts: string[]) => parts.join('');

/** One planted secret per rule: the text before it on its line, the secret, and the text after. */
const PLANTED: Array<{ rule: string; line: string; secret: string }> = (
  [
    ['github-token', 'git push https://ghe.imagile.dev/x ', plant('ghp', '_Q7wE3rT9yU1iO5pA2sD8fG4hJ6kL0zXc9vB'), ''],
    ['gitlab-token', 'CI_JOB=', plant('glpat', '-Xy7Kp2Qm9Rt4Lw8Zn3Vb'), ''],
    ['slack-token', 'hook: ', plant('xoxb', '-4815162342-PlantedSlackTok'), ''],
    ['aws-access-key', 'id ', plant('AKIA', 'Q3WX7ZP2LM9NBV4C'), ''],
    ['sonar-token', 'scan with ', plant('sqa', '_Mn4Bv7Cx2Zl9Kj5Hg8Fd3Sa6'), ''],
    ['sk-key', 'model key ', plant('sk', '-proj-Hq8Wn3Ze7Rt2Yu5Io9Pa4Sd'), ''],
    ['atlassian-token', 'jira ', plant('ATATT', '3xFfGF0Pl4nt3dAtl4ss1anT0k3n'), ''],
    ['slack-webhook', 'notify https://hooks.slack.com/services/', plant('T0000/B0000/', 'Pl4ntedHookPathQw7'), ' x'],
    ['bitbucket-token', 'git ', plant('BBDC', '-Pl4ntedBbdcT0kenQw7Er4'), ''],
    ['npm-token', '_authToken ', plant('npm', '_Pl4ntedNpmT0kenQw7Er4Ty6Ui8Op0As2'), ''],
    ['artifactory-token', 'jf ', plant('AKCp', 'Pl4ntedJfKeyQw7Er4Ty6Ui8'), ''],
    ['dynatrace-token', 'dt ', plant('dt0c01', '.PL4NTEDDTPUBLICQW7ER4TY6.', 'Pl4ntedDtSecretPartQw7Er4Ty6Ui8Op0As2Df4Gh6Jk8Lz1Xc3Vb5Nm7Qa9Ws2Ed4Rf6T'), ''],
    ['figma-token', 'figma ', plant('figd', '_Pl4ntedFigdT0kenQw7Er4'), ''],
    ['azure-devops-pat', 'pat ', plant('pl4ntedadopatqwer', 'tyuiopasdfghjklzxcvbnm234567qwertyu'), ' x'],
    ['azure-sas', 'sas sv=2022-11-02&sig=', plant('Pl4nted', 'SasSigQw7%2BEr4'), ''],
    ['jwt', 'cookie ', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkLWp3dCJ9.UGxhbnRlZFNpZ25hdHVyZQ', ' end'],
    ['private-key', 'k ', plant('-----BEGIN RSA PRIVATE', ' KEY-----UGxhbnRlZEtleUJvZHlPbmVMaW5l-----END RSA PRIVATE KEY-----'), ''],
    ['url-credentials', 'pull https://', 'deployer:Pl4ntedUrlPw', '@artifactory.imagile.dev/x'],
    ['authorization-value', 'curl -H "Bearer ', 'Pl4ntedB3arerTok', '" x'],
    ['name-value', 'password=', 'Pl4ntedPassw0rd', ''],
    ['user-flag', 'curl -u admin:', 'Pl4ntedUs3rFlag', ' x'],
    ['long-random', 'seed ', 'Zq8xLm2Np4Rt6Vw9Yb1Cd3Ef5Gh7Jk0MPl4nt', ' end'],
    ['high-entropy', 'salt ', 'Q2w/E4r+T6y/U8i-O0pA', ' end'],
  ] as const
).map(([rule, before, secret, after]) => ({ rule, line: `${before}${secret}${after}`, secret }));
const PLANTED_TEXT = `${PLANTED.map((p) => p.line).join('\n')}\n`;

/** Every redaction case the audit log's own tests cover, with the characters that are the secret. */
const AUDIT_CASES: Array<[string, ...string[]]> = [
  ['see https://bob:hunter2@jira.imagile.dev/rest?os_password=pw&projectKey=PROJ', 'bob:hunter2', 'pw'],
  ['{"password":"hunter2"}', 'hunter2'],
  ["{'token': 'abc'}", 'abc'],
  ['{"user": "ada", "apiToken": "abc", "author": "alice"}', 'abc'],
  ['curl --user=admin:hunter2 x', 'hunter2'],
  ['curl -uadmin:hunter2', 'hunter2'],
  ['curl -u admin:hunter2 x', 'hunter2'],
  ['Password=hunter2; (conn string)', 'hunter2'],
  ['Server=h;User Id=u;Password=hunter2;', 'hunter2'],
  ['Authorization: Bearer abc', 'abc'],
  [`Authorization: Basic ${Buffer.from('svc:Zq8xLm2Np4Rt').toString('base64')}`, Buffer.from('svc:Zq8xLm2Np4Rt').toString('base64')],
  ['mysql --password=hunter2 -h db', 'hunter2'],
  ['psql --token=abc123', 'abc123'],
  ['mysql -p=hunter2 -h db', 'hunter2'],
  ['spring.datasource.password=x', 'x'],
  ['{"user": "ada", "password": "x"}', 'x'],
  ['token=abc and secret: "s e" and api_key=k1', 'abc', 's e', 'k1'],
  ['curl -H "Bearer abcdefgh12345"', 'abcdefgh12345'],
  [`t ghp_${'a1B2'.repeat(9)} r Zq8xLm2Np4Rt6Vw9Yb1Cd3Ef5Gh7Jk0M`, `ghp_${'a1B2'.repeat(9)}`, 'Zq8xLm2Np4Rt6Vw9Yb1Cd3Ef5Gh7Jk0M'],
];

describe('util secrets scan: what it finds', () => {
  it('finds one planted secret per rule, at its exact line, column and length, and covers every rule the shared definition has', async () => {
    const { data, envelope } = await scan({ text: PLANTED_TEXT });
    expect(envelope.ok).toBe(true);
    PLANTED.forEach(({ rule, line, secret }, i) => {
      const hit = data.findings.find((f) => f.line === i + 1 && f.column === line.indexOf(secret) + 1 && f.length === secret.length);
      expect(hit, `${rule}: ${JSON.stringify(data.findings.filter((f) => f.line === i + 1))}`).toBeDefined();
      expect(hit!.rule).toBe(rule);
    });
    expect(new Set(PLANTED.map((p) => p.rule))).toEqual(new Set([...SECRET_RULES, 'high-entropy']));
    expect(data.summary.findings).toBe(PLANTED.length);
    expect(data.verified.passed).toBe(true);
  });

  it('finds every secret the audit log redaction tests cover, at its position', async () => {
    for (const [text, ...secrets] of AUDIT_CASES) {
      const { data } = await scan({ text });
      for (const secret of secrets) {
        const column = text.indexOf(secret) + 1;
        expect(data.findings.some((f) => f.column === column && f.length === secret.length), `${secret} in ${text}: ${JSON.stringify(data.findings)}`).toBe(true);
      }
    }
  });

  it('a lone BEGIN header ends at the first line that is not key body, and the secrets after it are still found', async () => {
    const header = plant('-----BEGIN RSA PRIVATE', ' KEY-----');
    const { data } = await scan({ text: `${header}\ntoken=Pl4ntedAfterHdr\nnotes\npassword=Pl4ntedPassw0rd\n` });
    expect(data.findings.map((f) => [at(f), f.rule, f.endLine])).toEqual([
      ['-:1:1', 'private-key', undefined],
      ['-:2:7', 'name-value', undefined],
      ['-:4:10', 'name-value', undefined],
    ]);
    // A header named in a sentence isn't a key's first line: the line is one finding, and the next is scanned.
    const prose = await scan({ text: `Paste the key that starts ${header} here.\npassword=Pl4ntedPassw0rd\n` });
    expect(prose.data.findings.map((f) => [at(f), f.rule])).toEqual([
      ['-:1:27', 'private-key'],
      ['-:2:10', 'name-value'],
    ]);
  });

  it('a lone header followed by lines that only look like key body reports the header alone, then finds what those lines hold', async () => {
    const header = plant('-----BEGIN RSA PRIVATE', ' KEY-----');
    const aws = plant('AKIA', 'Q3WX7ZP2LM9NBV4C');
    const { data } = await scan({ text: `${header}\nnotes\n${aws}\n` });
    expect(data.findings.map((f) => [at(f), f.rule, f.endLine])).toEqual([
      ['-:1:1', 'private-key', undefined],
      ['-:3:1', 'aws-access-key', undefined],
    ]);
    expect(data.findings[0]!.length).toBe(header.length);
    expect(data.verified.passed).toBe(true);
    // In a diff, a gap between hunks ends the key the same way.
    const diff = `diff --git a/k.txt b/k.txt\n--- a/k.txt\n+++ b/k.txt\n@@ -0,0 +1,2 @@\n+${header}\n+${aws}\n@@ -9,0 +12 @@\n+UGxhbnRlZA\n`;
    const git = gitOf(new Map([[callKey({ subcommand: 'diff', options: ['--staged', ...DIFF_OPTIONS] }), ok(diff)], [callKey({ subcommand: 'show', revisions: [':./k.txt'] }), ok(`${header}\n${aws}\n`)]]));
    const staged = await scan({ diff: 'staged' }, { git });
    expect(staged.data.findings.map((f) => [at(f), f.rule])).toEqual([
      ['k.txt:1:1', 'private-key'],
      ['k.txt:2:1', 'aws-access-key'],
    ]);
  });

  it('an encrypted PEM key, with its Proc-Type and DEK-Info headers and a blank line, is still one finding', async () => {
    const key = [plant('-----BEGIN RSA PRIVATE', ' KEY-----'), 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF', '', 'UGxhbnRlZEVuY3J5cHRlZEtleUJvZHlMaW5lT25l', 'UGxhbnRlZEVuY3J5cHRlZEtleUJvZHlMaW5lVHdv', plant('-----END RSA PRIVATE', ' KEY-----')];
    const { data } = await scan({ text: `${key.join('\n')}\ntoken=Pl4ntedAfterKey\n` });
    expect(data.findings.map((f) => [at(f), f.rule, f.endLine])).toEqual([
      ['-:1:1', 'private-key', 7],
      ['-:8:7', 'name-value', undefined],
    ]);
  });

  it('reports a private key over several lines once, BEGIN to END, and not its body line by line', async () => {
    const { data } = await scan({ text: `before\n${SSH_KEY}after token=Pl4ntedAfterKey\n` });
    const keys = data.findings.filter((f) => f.rule === 'private-key');
    expect(keys).toEqual([expect.objectContaining({ line: 2, column: 1, endLine: SSH_KEY.trimEnd().split('\n').length + 1, length: SSH_KEY.trimEnd().length, confidence: 'high', preview: '----…----' })]);
    expect(data.findings.map((f) => f.rule)).toEqual(['private-key', 'name-value']);
  });

  it('sets aside SRI checksums and references to secrets, counting them, and leaves commits, digests and ids alone', async () => {
    const text = [
      '"integrity": "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXGGNC0Bkr+4QGeBXE1Y0R2Rd0n5w=="',
      'TOKEN: ${{ secrets.DEPLOY_TOKEN }}',
      'password=$DB_PASSWORD',
      'commit 3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c1e3b5d7f9a id abc12345-0000-0000-0000-000000000000',
      'import { scanSecrets } from "./secrets/scan.js";',
    ].join('\n');
    const { data } = await scan({ text });
    expect(data.findings).toEqual([]);
    expect(data.summary).toMatchObject({ checksums: 1, placeholders: 2, findings: 0 });
  });

  it('grades confidence: a vendor shape is high, a plain long run is graded by entropy, a short named value is medium', () => {
    const line = (text: string) => detectLine(text).matches.map((m) => [m.rule, m.confidence]);
    expect(line(plant('AKIA', 'Q3WX7ZP2LM9NBV4C'))).toEqual([['aws-access-key', 'high']]);
    expect(line('password=abc')).toEqual([['name-value', 'medium']]);
    expect(line('password=Pl4ntedPassw0rd')).toEqual([['name-value', 'high']]);
    expect(line('aaaaaaaaaaaaaaaaaaaaaaaa1')).toEqual([['long-random', 'low']]);
    expect(line('Zq8xLm2Np4Rt6Vw9Yb1Cd3Ef5Gh7Jk0M')).toEqual([['long-random', 'high']]);
    expect(entropy('aaaa')).toBe(0);
    expect(entropy('abcd')).toBe(2);
  });

  it('exits 1 on the CLI when anything is found, 0 when nothing is, and MCP returns the same envelope without an error flag', async () => {
    const found = await runCli(['util', 'secrets', 'scan', '--text', PLANTED_TEXT], { commands, context: ctxOf().context });
    expect(found.envelope?.ok).toBe(true);
    expect(found.exitCode).toBe(1);
    const clean = await runCli(['util', 'secrets', 'scan', '--text', 'nothing to see'], { commands, context: ctxOf().context });
    expect(clean.exitCode).toBe(0);
    const session = await connectMcp({ commands, context: ctxOf().context });
    try {
      const viaMcp = await session.call('util_secrets_scan', { text: PLANTED_TEXT });
      expect(viaMcp.isError).toBe(false);
      expect({ ...viaMcp.envelope.data as object }).toEqual(found.envelope?.data);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('reads stdin when no file, text or diff is given, and refuses two inputs at once', async () => {
    const run = await runCli(['util', 'secrets', 'scan'], { commands, context: ctxOf({ stdin: 'password=Pl4ntedPassw0rd\n' }).context });
    expect((run.envelope?.data as ScanData).source).toEqual({ kind: 'stdin', path: null });
    expect((run.envelope?.data as ScanData).findings).toHaveLength(1);
    expect(run.exitCode).toBe(1);
    const both = await scan({ text: 'x', diff: 'staged' });
    expect(both.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Pass one of inputFile, text or diff.' });
  });
});

describe('util secrets scan: nothing it puts out holds a secret', () => {
  /** Every 8-character piece of every planted secret: a preview keeps at most 4 at each end, so none may appear anywhere. */
  const pieces = PLANTED.flatMap(({ secret }) => Array.from({ length: Math.max(1, secret.length - 7) }, (_, i) => secret.slice(i, i + 8)));
  const expectClean = (where: string, text: string) => {
    for (const piece of pieces) expect(text.includes(piece), `${where} holds ${piece.slice(0, 2)}… of a planted secret`).toBe(false);
  };

  const diffOf = (path: string, content: string) =>
    `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${content.trimEnd().split('\n').length} @@\n${content
      .trimEnd()
      .split('\n')
      .map((l) => `+${l}`)
      .join('\n')}\n`;
  const stagedGit = () =>
    gitOf(
      new Map([
        [callKey({ subcommand: 'diff', options: ['--staged', ...DIFF_OPTIONS] }), ok(diffOf('deploy/creds.txt', PLANTED_TEXT))],
        [callKey({ subcommand: 'show', revisions: [':./deploy/creds.txt'] }), ok(PLANTED_TEXT)],
      ]),
    );
  const files = { 'deploy/creds.txt': PLANTED_TEXT, 'deploy/more/creds.env': PLANTED_TEXT };

  const cases: Array<{ name: string; argv: string[]; mcp?: Record<string, unknown>; options?: TestContextOptions }> = [
    { name: 'a file', argv: ['deploy/creds.txt'], mcp: { inputFile: 'deploy/creds.txt' } },
    { name: 'a folder', argv: ['deploy'], mcp: { inputFile: 'deploy' } },
    { name: 'text', argv: ['--text', PLANTED_TEXT], mcp: { text: PLANTED_TEXT } },
    { name: 'stdin', argv: ['-'], options: { stdin: PLANTED_TEXT } },
    { name: 'the staged diff', argv: ['--diff', 'staged'], mcp: { diff: 'staged' } },
  ];

  for (const c of cases) {
    it(`scanning ${c.name}: the CLI's stdout and stderr, the MCP result and the audit log hold none of it, and every finding is reported`, async () => {
      const cli = ctxOf({ files, git: stagedGit(), ...c.options });
      const run = await runCli(['util', 'secrets', 'scan', ...c.argv], { commands, context: cli.context });
      expect(run.exitCode).toBe(1);
      const data = run.envelope?.data as ScanData;
      expect(data.summary.findings).toBe(PLANTED.length * (c.name === 'a folder' ? 2 : 1));
      expect(data.verified.passed).toBe(true);
      expectClean(`${c.name}: CLI output`, run.stdout + run.stderr);
      expectClean(`${c.name}: audit log`, cli.audit.lines.join(''));
      if (!c.mcp) return;
      const viaMcp = ctxOf({ files, git: stagedGit() });
      const session = await connectMcp({ commands, context: viaMcp.context });
      try {
        const result = await session.call('util_secrets_scan', c.mcp);
        expect((result.envelope.data as ScanData).summary.findings).toBe(data.summary.findings);
        expectClean(`${c.name}: MCP result`, result.text + JSON.stringify(result.envelope));
        expectClean(`${c.name}: MCP audit log`, viaMcp.audit.lines.join(''));
      } finally {
        await session.close();
      }
    }, 30_000);
  }

  it('never shows a secret pasted into the allow file by mistake', async () => {
    const { envelope } = await scan({ text: 'nothing', allowFile: 'allow' }, { files: { allow: `${PLANTED.map((p) => p.secret).join('\n')}\n` } });
    expectClean('allow-file warnings', JSON.stringify(envelope));
    expect(envelope.meta.warnings).toContainEqual(expect.objectContaining({ code: 'SECRETS_ALLOW_INVALID' }));
  });

  it('masks a preview to at most 4 characters at each end, and nothing below 16 characters', () => {
    expect(maskSecret(PLANTED[0]!.secret)).toBe('ghp_…c9vB');
    expect(maskSecret('Pl4ntedPassw0rd!x')).toBe('Pl…!x');
    expect(maskSecret('hunter2')).toBe('…');
    expect([keepFor(15), keepFor(16), keepFor(23), keepFor(24)]).toEqual([0, 2, 2, 4]);
  });
});

describe('util secrets scan: the self-checks catch a broken result', () => {
  it('a preview that leaks fails preview.masked, warns SECRETS_PREVIEW_LEAK, and is replaced, never shown', async () => {
    const { context } = ctxOf();
    const warnings: Array<{ code: string; message: string }> = [];
    const data = await scanSecrets({ text: PLANTED_TEXT, mask: (s) => s }, { ...context, warn: (w: { code: string; message: string }) => warnings.push(w), setExitCode: () => {}, signal: new AbortController().signal } as never);
    expect(data.verified.passed).toBe(false);
    expect(data.verified.checks.find((c) => c.check === 'preview.masked')).toMatchObject({ status: 'failed', failed: PLANTED.length });
    expect(data.findings.every((f) => f.preview === '…')).toBe(true);
    expect(warnings.map((w) => w.code)).toContain('SECRETS_PREVIEW_LEAK');
    for (const { secret } of PLANTED) expect(JSON.stringify({ data, warnings })).not.toContain(secret);
  });

  it('previewIsMasked refuses a preview with any of the middle left in, or ends longer than allowed', () => {
    const secret = PLANTED[0]!.secret;
    expect(previewIsMasked(maskSecret(secret), secret)).toBe(true);
    expect(previewIsMasked(secret, secret)).toBe(false);
    expect(previewIsMasked(`${secret.slice(0, 6)}…${secret.slice(-4)}`, secret)).toBe(false);
    expect(previewIsMasked(`ghp_…E3rT…c9vB`, secret)).toBe(false);
    expect(previewIsMasked('…', 'hunter2')).toBe(true);
    expect(previewIsMasked('h…2', 'hunter2')).toBe(false);
  });

  it('a staged blob that no longer holds what the diff showed fails finding.reread with SECRETS_REREAD_MISMATCH', async () => {
    const git = gitOf(
      new Map([
        [callKey({ subcommand: 'diff', options: ['--staged', ...DIFF_OPTIONS] }), ok(STAGED_DIFF)],
        // The index says otherwise: the password line moved down one.
        [callKey({ subcommand: 'show', revisions: [':./config/application.properties'] }), ok(`# moved\n${PROPERTIES}`)],
      ]),
    );
    const { data, envelope } = await scan({ diff: 'staged' }, { git, files: samples });
    expect(data.verified.passed).toBe(false);
    expect(data.verified.checks.find((c) => c.check === 'finding.reread')).toMatchObject({ status: 'failed', failed: 2, checked: 2 });
    expect(envelope.meta.warnings).toContainEqual(expect.objectContaining({ code: 'SECRETS_REREAD_MISMATCH' }));
    expect(JSON.stringify(envelope)).not.toContain('Sup3rS3cr3tPw');
  });

  it('a file that changes between the scan and the re-read fails the re-read too', async () => {
    const { context } = ctxOf({ files: { 'app.env': 'password=Pl4ntedPassw0rd\n' } });
    let passes = 0;
    const real = context.files;
    const changing: FileAccess = {
      ...real,
      readStream: (path, options) => {
        passes++;
        if (passes === 1) return real.readStream(path, options);
        return (async function* () {
          yield new TextEncoder().encode('password=SomethingElse99\n');
        })();
      },
    };
    const envelope = await execute(secretsScanCommand, { inputFile: 'app.env' }, { ...context, files: changing } as Context);
    const data = envelope.data as ScanData;
    expect(data.verified.checks.find((c) => c.check === 'finding.reread')).toMatchObject({ status: 'failed', failures: [{ at: 'app.env:1:10', expected: 'name-value at column 10', actual: 'different characters' }] });
  });

  it('a truncated read fails input.complete', async () => {
    const { context } = ctxOf({ files: { 'app.env': 'LOG_LEVEL=info\n' } });
    const real = context.files;
    const short: FileAccess = { ...real, stat: (path) => ({ ...real.stat(path), size: 999 }) };
    const envelope = await execute(secretsScanCommand, { inputFile: 'app.env' }, { ...context, files: short } as Context);
    expect((envelope.data as ScanData).verified).toMatchObject({ passed: false });
    expect(envelope.meta.warnings).toContainEqual(expect.objectContaining({ code: 'INPUT_INCOMPLETE' }));
  });
});

describe("util secrets scan: what it can't read is listed", () => {
  it('lists binary, too-large and unreadable files and nested repositories in a folder, with the reason, and scans the rest', async () => {
    const { context } = ctxOf({ files: { 'w/a.env': 'password=Pl4ntedPassw0rd\n', 'w/logo.png': new Uint8Array([1, 0, 2]), 'w/big.log': 'x\n', 'w/locked.txt': 'y\n' } });
    const real = context.files;
    const files: FileAccess = {
      ...real,
      list: (dir, options) => [...real.list(dir, options), 'vendor-repo/'],
      stat: (path) => (path === 'w/big.log' ? { ...real.stat(path), size: 65 * 1024 * 1024 } : real.stat(path)),
      readStream: (path, options) => {
        if (path === 'w/locked.txt') throw Object.assign(new Error('EACCES: permission denied, open w/locked.txt'), { code: 'EACCES' });
        return real.readStream(path, options);
      },
    };
    const envelope = await execute(secretsScanCommand, { inputFile: 'w' }, { ...context, files } as Context);
    const data = envelope.data as ScanData;
    expect(data.unreadable.map((u) => [u.file, u.reason])).toEqual([
      ['w/big.log', 'too-large'],
      ['w/locked.txt', 'unreadable'],
      ['w/logo.png', 'binary'],
      ['w/vendor-repo/', 'nested-repository'],
    ]);
    expect(data.findings.map(at)).toEqual(['w/a.env:1:10']);
    expect(data.summary).toMatchObject({ files: 1, unreadable: 4 });
    expect(envelope.meta.warnings).toContainEqual(expect.objectContaining({ code: 'SECRETS_UNREADABLE' }));
  });

  it('skips only the bad line of a .gitignore, so the rest still keeps files out, and says so in meta.warnings (#262)', async () => {
    const { envelope, data } = await scan({ inputFile: 'w' }, { files: { 'w/.gitignore': '*.log\n[b-a]\n', 'w/debug.log': 'password=Pl4ntedPassw0rd\n', 'w/a.env': 'password=Pl4ntedPassw0rd\n' } });
    expect(data.findings.map(at)).toEqual(['w/a.env:1:10']);
    expect(envelope.meta.warnings).toContainEqual({ code: 'GITIGNORE_LINE_SKIPPED', message: expect.stringContaining('Line 2 of /work/w/.gitignore ("[b-a]")') });
  });

  it('a single file named on the call that is binary fails the call, as any util command would', async () => {
    const { envelope } = await scan({ inputFile: 'logo.png' }, { files: { 'logo.png': new Uint8Array([1, 0, 2]) } });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'Pass a text file.' });
  });

  it('lists a line too long to scan whole, and still scans its start', async () => {
    const long = `password=Pl4ntedPassw0rd ${'a'.repeat(4 * 1024 * 1024)}`;
    const { data } = await scan({ inputFile: 'min.js' }, { files: { 'min.js': `${long}\n` } });
    expect(data.unreadable).toEqual([expect.objectContaining({ file: 'min.js', line: 1, reason: 'line-too-long' })]);
    expect(data.findings.map((f) => f.rule)).toContain('name-value');
  });
});

describe('util secrets scan: the allow file', () => {
  it('moves a finding whose fingerprint is listed to allowed, counts what it read, and exits 0 when nothing else is found', async () => {
    const fp = fingerprintOf('Pl4ntedPassw0rd');
    const allow = `# known test value\n${fp}  # fixture\n\nnot-a-fingerprint\n${'0'.repeat(8)}-${'0'.repeat(8)}-${'0'.repeat(8)}-${'0'.repeat(8)}\n`;
    const { context } = ctxOf({ files: { '.toil/secrets-allow': allow, 'app.env': 'password=Pl4ntedPassw0rd\ntoken=Pl4ntedOtherTok\n' } });
    const run = await runCli(['util', 'secrets', 'scan', 'app.env'], { commands, context });
    const data = run.envelope?.data as ScanData;
    expect(data.allowed.map(at)).toEqual(['app.env:1:10']);
    expect(data.findings.map(at)).toEqual(['app.env:2:7']);
    expect(data.allowList).toEqual({ file: '.toil/secrets-allow', entries: 2, invalid: 1, unused: 1 });
    expect(run.envelope?.meta.warnings).toContainEqual({ code: 'SECRETS_ALLOW_INVALID', message: expect.stringContaining('line 4') });
    expect(run.exitCode).toBe(1);

    const allowedOnly = await runCli(['util', 'secrets', 'scan', '--text', 'password=Pl4ntedPassw0rd'], { commands, context: ctxOf({ files: { '.toil/secrets-allow': allow } }).context });
    expect(allowedOnly.exitCode).toBe(0);
  });

  it('matches by fingerprint only: the raw value in the allow file allows nothing', async () => {
    const { data } = await scan({ text: 'password=Pl4ntedPassw0rd' }, { files: { '.toil/secrets-allow': 'Pl4ntedPassw0rd\n' } });
    expect(data.findings).toHaveLength(1);
    expect(data.allowed).toEqual([]);
    expect(data.allowList).toMatchObject({ entries: 0, invalid: 1 });
  });

  it('with the workspace at home, the default allow file is under toil\'s own folder: it counts as absent, and the scan runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'toil-secrets-home-'));
    try {
      writeFileSync(join(home, 'app.env'), 'password=Pl4ntedPassw0rd\n');
      const ctx = createNodeContext({ globals: { workspace: home }, def: secretsScanCommand, signal: new AbortController().signal, env: {}, cwd: home, home, areas: [], version: '0.0.0-test', stderr: () => {}, stdin: false });
      const envelope = await execute(secretsScanCommand, { inputFile: 'app.env' }, ctx);
      expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
      expect(envelope.data).toMatchObject({ allowList: null, summary: { findings: 1 } });
      // Named outright, the same file is refused by the bound, loudly.
      const named = await execute(secretsScanCommand, { inputFile: 'app.env', allowFile: '.toil/secrets-allow' }, ctx);
      expect(named.ok).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says 0 files were scanned when .gitignore excludes the folder, instead of a clean result that reads as a clean folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-secrets-ignored-'));
    try {
      mkdirSync(join(root, '.git'), { recursive: true });
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(root, '.gitignore'), 'build/\n');
      mkdirSync(join(root, 'build'), { recursive: true });
      writeFileSync(join(root, 'build', 'app.env'), 'password=Pl4ntedPassw0rd\n');
      const home = join(root, 'home');
      const ctx = createNodeContext({ globals: { workspace: root }, def: secretsScanCommand, signal: new AbortController().signal, env: {}, cwd: root, home, areas: [], version: '0.0.0-test', stderr: () => {}, stdin: false });
      const envelope = await execute(secretsScanCommand, { inputFile: 'build' }, ctx);
      expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
      expect(envelope.data).toMatchObject({ findings: [], summary: { files: 0 } });
      expect(envelope.meta.warnings).toEqual([
        { code: 'SECRETS_NOTHING_SCANNED', message: expect.stringMatching(/^0 files were scanned, because \.gitignore excludes this folder: .*build is inside build\/, which \.gitignore excludes, so nothing under it is listed\./) },
      ]);
      // Named outright, the file is scanned.
      const named = await execute(secretsScanCommand, { inputFile: 'build/app.env' }, ctx);
      expect(named.data).toMatchObject({ summary: { files: 1, findings: 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an allow file that was named and is missing, and works without one when none was named', async () => {
    expect((await scan({ text: 'x', allowFile: 'nope' })).envelope.error?.code).toBe('INVALID_INPUT');
    expect((await scan({ text: 'x' })).data.allowList).toBeNull();
  });

  it('pins the fingerprint: a slow salted hash, stable across runs, never the SHA-256 of the value', async () => {
    expect(fingerprintOf('hunter2')).toBe('7bf5e051-2332cbd4-4e67f21d-0f6241bd');
    expect(fingerprintOf('hunter2')).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
    expect(fingerprintOf('hunter2').replace(/-/g, '')).not.toBe((await import('node:crypto')).createHash('sha256').update('hunter2').digest('hex').slice(0, 32));
    expect(fingerprintOf('hunter3')).not.toBe(fingerprintOf('hunter2'));
  });

  it('the sample allow file names every secret in the samples, so the parity examples exit 0', async () => {
    const git = gitOf(canned);
    for (const input of [{ inputFile: 'samples/secrets', allowFile: 'samples/secrets-allow' }, { diff: 'staged', allowFile: 'samples/secrets-allow' }]) {
      const run = await runCli(['util', 'secrets', 'scan', ...(input.inputFile ? ['--input-file', input.inputFile] : ['--diff', 'staged']), '--allow-file', 'samples/secrets-allow'], { commands, context: ctxOf({ files: samples, git }).context });
      const data = run.envelope?.data as ScanData;
      expect(data.findings, JSON.stringify(data.findings)).toEqual([]);
      expect(data.allowed.length).toBeGreaterThan(0);
      expect(run.exitCode).toBe(0);
    }
    expect(ALLOW.split('\n').filter((l) => /^[0-9a-f]/.test(l))).toHaveLength(9);
  });
});

describe('util secrets scan: the diff', () => {
  it('scans the staged diff through core git, added lines only, numbered as in the new file, and re-reads each finding from the index', async () => {
    const git = gitOf(canned);
    const { data, envelope } = await scan({ diff: 'staged' }, { git, files: samples });
    expect(git.calls).toEqual([
      { subcommand: 'diff', options: ['--staged', ...DIFF_OPTIONS] },
      { subcommand: 'rev-parse', options: ['--show-prefix'] },
      { subcommand: 'show', revisions: [':./config/application.properties'] },
    ]);
    expect(data.source).toEqual({ kind: 'staged', path: null });
    expect(data.findings.map((f) => [at(f), f.rule])).toEqual([
      ['config/application.properties:4:28', 'name-value'],
      ['config/application.properties:5:13', 'sonar-token'],
    ]);
    expect(data.unreadable).toEqual([expect.objectContaining({ file: 'samples/secrets/logo.png', reason: 'binary' })]);
    expect(data.verified.checks).toContainEqual(expect.objectContaining({ check: 'finding.reread', status: 'passed', checked: 2 }));
    expect(envelope.meta.warnings).toContainEqual(expect.objectContaining({ code: 'UNVERIFIED', message: expect.stringContaining('input.complete') }));
  });

  it('scans the working tree against the index, re-reads from disk, and warns about untracked files the diff leaves out', async () => {
    const diff = `diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -3,0 +4,2 @@\n${ENV.split('\n').slice(3, 5).map((l) => `+${l}`).join('\n')}\n`;
    const git = gitOf(
      new Map([
        [callKey({ subcommand: 'diff', options: DIFF_OPTIONS }), ok(diff)],
        [callKey({ subcommand: 'ls-files', options: ['--others', '--exclude-standard'] }), ok('scratch.txt\nnotes.txt\n')],
      ]),
    );
    const { data, envelope } = await scan({ diff: 'working' }, { git, files: { '.env': ENV } });
    expect(data.findings.map((f) => [at(f), f.rule])).toEqual([
      ['.env:4:16', 'atlassian-token'],
      ['.env:5:19', 'aws-access-key'],
    ]);
    expect(data.verified.passed).toBe(true);
    expect(envelope.meta.warnings).toContainEqual(expect.objectContaining({ code: 'SECRETS_UNTRACKED_NOT_SCANNED', message: expect.stringContaining("2 untracked files aren't in the working-tree diff and weren't scanned") }));
  });

  it('with the workspace in a folder of the repository, warns SECRETS_DIFF_PARTIAL with the staged files left outside it', async () => {
    const inner = `diff --git a/a.env b/a.env\n--- /dev/null\n+++ b/a.env\n@@ -0,0 +1 @@\n+password=Pl4ntedPassw0rd\n`;
    const git = gitOf(
      new Map([
        [callKey({ subcommand: 'diff', options: ['--staged', ...DIFF_OPTIONS] }), ok(inner)],
        [callKey({ subcommand: 'show', revisions: [':./a.env'] }), ok('password=Pl4ntedPassw0rd\n')],
        [SHOW_PREFIX, ok('work/\n')],
        [callKey({ subcommand: 'diff', options: ['--staged', '--name-only', '--no-relative'] }), ok('work/a.env\nother/b.env\n"other/caf\\303\\251.env"\n')],
      ]),
    );
    const { data, envelope } = await scan({ diff: 'staged' }, { git });
    expect(data.findings.map(at)).toEqual(['a.env:1:10']);
    expect(envelope.meta.warnings).toContainEqual({ code: 'SECRETS_DIFF_PARTIAL', message: expect.stringContaining('2 staged files are outside the workspace (work)') });

    // At the repository's top there's nothing outside, and git isn't asked.
    const whole = gitOf(canned);
    const top = await scan({ diff: 'staged' }, { git: whole, files: samples });
    expect(top.envelope.meta.warnings?.map((w) => w.code)).not.toContain('SECRETS_DIFF_PARTIAL');
    expect(whole.calls.some((c) => c.options?.includes('--name-only'))).toBe(false);
  });

  it('outside a repository is "Not a git repository", and a failing git is its own error with git\'s message', async () => {
    const outside = await execute(secretsScanCommand, { diff: 'staged' }, testContext({ git: gitOf(new Map([[callKey({ subcommand: 'version' }), ok('git version 2.47.0')]])) }).context);
    expect(outside.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Not a git repository' });
    const failing = await scan({ diff: 'staged' }, { git: gitOf(new Map([[callKey({ subcommand: 'diff', options: ['--staged', ...DIFF_OPTIONS] }), { exitCode: 128, stdout: '', stderr: 'fatal: bad config' }]])) });
    expect(failing.envelope.error?.message).toContain('fatal: bad config');
  });

  it('parses hunks, deleted and binary files, and quoted paths', () => {
    const text = [
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '@@ -10,0 +20,2 @@ context',
      '++plus at the start',
      '+second',
      '\\ No newline at end of file',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      '@@ -0,0 +1 @@',
      '+token=x',
      'Binary files a/i.png and b/i.png differ',
    ].join('\n');
    expect(parseDiff(text)).toEqual([
      { path: 'x.txt', binary: false, added: [{ line: 1, text: 'new' }, { line: 20, text: '+plus at the start' }, { line: 21, text: 'second' }] },
      { path: 'café.txt', binary: false, added: [{ line: 1, text: 'token=x' }] },
      { path: 'i.png', binary: true, added: [] },
    ]);
    expect(unquoteGitPath('"a\\tb\\"c"')).toBe('a\tb"c');
    expect(unquoteGitPath('plain.txt')).toBe('plain.txt');
  });
});

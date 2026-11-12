import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auditCommands } from '../src/audit/commands.js';
import { auditEntry, auditInput, auditLine, fileAuditLog, parseAuditSettings, redactText, type AuditEntry, type AuditLog } from '../src/core/audit.js';
import { areaOf, commandName, toolName, type AnyCommand } from '../src/core/command.js';
import { loadConfig } from '../src/core/config.js';
import { execute } from '../src/core/run.js';
import { createNodeContext } from '../src/node-context.js';
import { commands as registered } from '../src/registry.js';
import { setupCommands } from '../src/setup/commands.js';
import { demoArea, demoCommands, demoRoutes, getThing, renameThing } from './fixtures/demo-commands.js';
import { memoryAudit } from './harness/audit.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { loadFixtures, setUp, tearDown } from './harness/fixtures.js';
import { connectMcp, type McpSession } from './harness/mcp.js';

const fixtures = await loadFixtures();
const temps: string[] = [];
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'toil-audit-'));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const demoConfig = { demo: { token: 'demo-token', writes: true } };
const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  time: '2026-10-17T09:00:00.000Z',
  via: 'cli',
  command: 'jira issue get',
  area: 'jira',
  connection: 'corp-jira',
  writes: false,
  allowWrite: false,
  outcome: 'ok',
  durationMs: 12,
  input: { key: 'PROJ-1' },
  requests: [],
  ...over,
});

describe('redaction', () => {
  it('redacts credential parameters and userinfo in URLs, as --verbose does', () => {
    expect(redactText('see https://bob:hunter2@jira.imagile.dev/rest?os_password=pw&projectKey=PROJ')).toBe('see https://[redacted]@jira.imagile.dev/rest?os_password=[redacted]&projectKey=PROJ');
  });

  it('replaces token-shaped values wherever they appear, and leaves ids, commits and digests', () => {
    const ghp = `ghp_${'a1B2'.repeat(9)}`;
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMxMjM0NSJ9.c2lnbmF0dXJl';
    const random = 'Zq8xLm2Np4Rt6Vw9Yb1Cd3Ef5Gh7Jk0M';
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----';
    const text = `t ${ghp} j ${jwt} r ${random} h Bearer abcdefgh12345 ${pem}`;
    expect(redactText(text)).toBe('t [redacted] j [redacted] r [redacted] h Bearer [redacted] [redacted]');
    const sha = 'a'.repeat(20) + '0123456789abcdef0123';
    for (const kept of ['PROJ-123', sha, 'abc12345-0000-0000-0000-000000000000', '/rest/api/2/project/ABC1/components', 'status = Done AND project = PAY']) {
      expect(redactText(kept)).toBe(kept);
    }
  });

  it('redacts fields named for a secret but keeps a bare key, applies drop and hash, and caps long values', () => {
    const def = { ...getThing, auditInput: { fields: 'drop', id: 'hash' } } as AnyCommand;
    const out = auditInput(def, { id: 'THING-1', fields: 'name', token: 'short', apiKey: 'x', key: 'PROJ-1', nested: { password: 'pw', list: ['ok'] }, long: 'x'.repeat(600) }) as Record<string, unknown>;
    expect(String(out.id)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect('fields' in out).toBe(false);
    expect(out).toMatchObject({ token: '[redacted]', apiKey: '[redacted]', key: 'PROJ-1', nested: { password: '[redacted]', list: ['ok'] } });
    expect(String(out.long)).toHaveLength(501);
  });

  it("catches the reviewer's credential names and name=value pairs inside text, and keeps author and flags", () => {
    const out = auditInput(getThing, {
      auth: 'user:pass',
      nested: { authorization: 'Bearer abc' },
      pat: 'shortpat',
      passphrase: 'pp',
      cookie: 'JSESSIONID=abc',
      sessionId: 's1',
      privateKey: 'pk',
      gitlabPat: 'x',
      connectionString: 'Server=h;User Id=u;Password=hunter2;',
      command: 'curl -u admin:hunter2 https://jira.imagile.dev/',
      header: 'Authorization: Bearer abc',
      note: 'token=abc and secret: "s e" and api_key=k1',
      author: 'alice',
      private: true,
      jql: 'key = PROJ-1 AND author = alice',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      auth: '[redacted]',
      nested: { authorization: '[redacted]' },
      pat: '[redacted]',
      passphrase: '[redacted]',
      cookie: '[redacted]',
      sessionId: '[redacted]',
      privateKey: '[redacted]',
      gitlabPat: '[redacted]',
      connectionString: 'Server=h;User Id=u;Password=[redacted];',
      command: 'curl -u admin:[redacted] https://jira.imagile.dev/',
      header: 'Authorization: [redacted]',
      note: 'token=[redacted] and secret: "[redacted]" and api_key=[redacted]',
      author: 'alice',
      private: true,
      jql: 'key = PROJ-1 AND author = alice',
    });
    expect(JSON.stringify(out)).not.toMatch(/hunter2|shortpat|JSESSIONID|Bearer abc/);
  });

  it('catches a quoted name, as in JSON pasted into a text field, and every form of curl --user', () => {
    const cases: Array<[string, string]> = [
      ['{"password":"hunter2"}', '{"password":"[redacted]"}'],
      ["{'token': 'abc'}", "{'token': '[redacted]'}"],
      ['{"user": "ada", "apiToken": "abc", "author": "alice"}', '{"user": "ada", "apiToken": "[redacted]", "author": "alice"}'],
      ['curl --user=admin:hunter2 x', 'curl --user=admin:[redacted] x'],
      ['curl -uadmin:hunter2', 'curl -uadmin:[redacted]'],
      ['curl -u admin:hunter2 x', 'curl -u admin:[redacted] x'],
      ['Password=hunter2; (conn string)', 'Password=[redacted]; (conn string)'],
      ['Authorization: Bearer abc', 'Authorization: [redacted]'],
      [`Authorization: Basic ${Buffer.from('svc:Zq8xLm2Np4Rt').toString('base64')}`, 'Authorization: Basic [redacted]'],
      ['mysql --password=hunter2 -h db', 'mysql --password=[redacted] -h db'],
      ['psql --token=abc123', 'psql --token=[redacted]'],
      ['mysql -p=hunter2 -h db', 'mysql -p=[redacted] -h db'],
      // The whole dotted name is read, never a piece of it: a dotted password setting goes, a dotted key or author stays.
      ['spring.datasource.password=x', 'spring.datasource.password=[redacted]'],
      ['project.key=PAY author.name=alice', 'project.key=PAY author.name=alice'],
      ['{"user": "ada", "password": "x"}', '{"user": "ada", "password": "[redacted]"}'],
    ];
    for (const [text, redacted] of cases) expect(redactText(text), text).toBe(redacted);
  });

  it('cuts every request URL, and a line too long for one write is trimmed hard and marked truncated', () => {
    const longUrl = `https://jira.imagile.dev/rest/api/2/search?jql=${'project%20in%20(PAY)%20OR%20'.repeat(2000)}`;
    const built = auditEntry({ def: getThing, input: {}, via: 'cli', writes: false, requests: Array.from({ length: 150 }, () => ({ method: 'GET', url: longUrl, status: 200, durationMs: 1 })), envelope: { ok: true, data: null, error: null, meta: { command: 'demo get-thing', durationMs: 1, version: 'x', contractVersion: 1 } } });
    expect(built.requests).toHaveLength(100);
    expect(built.requestsOmitted).toBe(50);
    for (const r of built.requests) expect(r.url.length).toBeLessThanOrEqual(501);
    expect(Buffer.byteLength(auditLine(built))).toBeLessThanOrEqual(64 * 1024);
    // Built by hand, past what auditEntry would ever make: the line builder still holds the cap.
    const huge = entry({ requests: Array.from({ length: 100 }, () => ({ method: 'GET', url: longUrl, status: 200 })), input: { q: 'x'.repeat(100_000) } });
    const line = auditLine(huge);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(line)).toMatchObject({ command: 'jira issue get', outcome: 'ok', input: null, requests: [], requestsOmitted: 100, truncated: true });
  });

  it('takes linear time on long runs that would make a backtracking pattern quadratic', () => {
    // The limits only have to tell linear from quadratic: a quadratic pattern took
    // about 17 s on 100,000 characters; linear is a few milliseconds. 5 s is a thousand
    // times the linear time, so a loaded runner can't trip it, and a quarter of the quadratic.
    const runs = ['a', 'a.', 'a-', '-a', 'a=', 'a:', '"a":', "'a'=", 'a://', '-u', '--user ', '--password=', 'Basic ', 'eyJ', 'password=', '"', 'x1'];
    for (const unit of runs) {
      const text = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
      const started = performance.now();
      auditInput(getThing, { note: text });
      expect(performance.now() - started, `auditInput on 100,000 characters of ${JSON.stringify(unit)}`).toBeLessThan(5000);
      // The patterns themselves are linear too, without the cut in front of them.
      const direct = performance.now();
      redactText(text);
      expect(performance.now() - direct, `redactText on 100,000 characters of ${JSON.stringify(unit)}`).toBeLessThan(5000);
    }
  });

  it('recognises a token that crosses the stored length before cutting, wherever it starts', () => {
    const token = `ghp_${'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2'}`;
    for (const at of [480, 490, 499, 500]) {
      const note = `${'x '.repeat(at / 2)}${at % 2 ? 'x' : ''}${token}${' tail'.repeat(50)}`;
      expect(note.indexOf(token)).toBe(at);
      const kept = String((auditInput(getThing, { note }) as { note: string }).note);
      expect(kept.length, `token at ${at}`).toBeLessThanOrEqual(501);
      for (let i = 0; i + 8 <= token.length; i++) expect(kept, `token at ${at} kept ${token.slice(i, i + 8)}`).not.toContain(token.slice(i, i + 8));
    }
  });

  it('leaves an already-redacted value alone, scheme and all, so a second pass changes nothing', () => {
    const basic = `Authorization: Basic ${Buffer.from('svc-jira:Zq8xLm2Np4Rt6Vw9Yb1C').toString('base64')}`;
    const once = redactText(basic);
    expect(once).toBe('Authorization: Basic [redacted]');
    expect(redactText(once)).toBe(once);
    for (const text of ['Authorization: Bearer [redacted]', 'token=[redacted]', '{"password":"[redacted]"}', 'curl -u admin:[redacted]']) expect(redactText(text), text).toBe(text);
  });

  it('db query and db execute keep a hash of their SQL, never the SQL', () => {
    for (const name of ['db query', 'db execute']) {
      const def = registered.find((d) => commandName(d) === name)!;
      expect(def.auditInput).toEqual({ sql: 'hash' });
      const out = auditInput(def, { sql: "SELECT ssn FROM people WHERE name = 'Ada'" }) as Record<string, string>;
      expect(out.sql).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('every auditInput field a command names is one of its inputs', () => {
    for (const def of registered) for (const field of Object.keys(def.auditInput ?? {})) expect(Object.keys(def.input.shape), commandName(def)).toContain(field);
  });

  it('keeps a line short enough for one write, dropping the input of an outsized call', () => {
    const big = entry({ input: { items: Array.from({ length: 50 }, () => ({ a: 'x'.repeat(500), b: 'y'.repeat(500), c: 'z'.repeat(500) })) } });
    const line = auditLine(big);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(line).input).toBeNull();
  });
});

describe('a secret-shaped value through every input of every command', () => {
  // Shaped like a real token (mixed case and digits) and like nothing else toil handles.
  const SECRET = 'Sx9KqR2mVt7LwP4nZb8YcH3jDf6GsA1e';
  beforeAll(() => setUp(fixtures));
  afterAll(() => tearDown(fixtures));

  it('never reaches the log, as a value, in a URL, or in a request', async () => {
    const home = tempHome();
    // setup edits a real shell profile, so here it gets a machine that lives in the temp folder.
    const local = setupCommands(() => ({ platform: process.platform, home, cwd: home, env: {}, bundle: join(home, 'toil.js') }));
    const swept = registered.map((def) => local.find((d) => commandName(d) === commandName(def)) ?? def);
    const leaks: string[] = [];
    let calls = 0;
    for (const def of swept) {
      const fixture = fixtures.find((f) => f.area === areaOf(def));
      for (const field of Object.keys(def.input.shape)) {
        for (const value of [SECRET, `https://${SECRET}@demo.imagile.dev/x?q=${SECRET}`, [SECRET]]) {
          const example = (def.examples[0] ?? {}) as Record<string, unknown>;
          const audit = memoryAudit();
          const { context } = testContext({ config: fixture?.config ?? {}, routes: fixture?.routes ?? [], files: fixture?.files ?? {}, audit, ...(fixture?.repo ? { repo: fixture.repo } : {}), ...(fixture?.git ? { git: fixture.git } : {}) });
          // Anything that would touch a config file touches one in a temp folder.
          context.config.files.global = join(home, '.toil', 'config.json');
          await execute(def, { ...example, [field]: value }, { ...context, verbose: true }, 'mcp');
          calls++;
          expect(audit.lines, `${commandName(def)} ${field}`).toHaveLength(1);
          if (audit.lines[0]!.includes(SECRET)) leaks.push(`${commandName(def)} .${field}: ${audit.lines[0]}`);
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(calls).toBeGreaterThan(1000);
  }, 120_000);
});

describe('the log on disk', () => {
  it('appends one line per entry to the month it was written in', () => {
    const home = tempHome();
    const log = fileAuditLog({ home, now: () => new Date('2026-10-17T09:00:00Z') });
    log.append(entry());
    log.append(entry({ command: 'jira issue search' }));
    const file = join(home, '.toil', 'audit', '2026-10.jsonl');
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n')).toHaveLength(3);
    expect(text.endsWith('\n')).toBe(true);
    expect(log.read().entries.map((e) => e.command)).toEqual(['jira issue get', 'jira issue search']);
  });

  it.skipIf(process.platform === 'win32')('is readable by the user only (skipped on Windows, which has no POSIX modes; the profile folder ACL applies)', () => {
    const home = tempHome();
    fileAuditLog({ home }).append(entry());
    const dir = join(home, '.toil', 'audit');
    expect(statSync(join(dir, readdirSync(dir)[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('keeps keepMonths months, this one included, and deletes older files as it writes', () => {
    const home = tempHome();
    mkdirSync(join(home, '.toil', 'audit'), { recursive: true });
    for (const month of ['2026-03', '2026-04', '2026-05', '2026-09']) writeFileSync(join(home, '.toil', 'audit', `${month}.jsonl`), auditLine(entry()));
    writeFileSync(join(home, '.toil', 'audit', 'notes.txt'), 'not a log file');
    fileAuditLog({ home, now: () => new Date('2026-10-01T00:00:00Z') }).append(entry());
    expect(readdirSync(join(home, '.toil', 'audit')).sort()).toEqual(['2026-05.jsonl', '2026-09.jsonl', '2026-10.jsonl', 'notes.txt']);

    writeFileSync(join(home, '.toil', 'config.json'), JSON.stringify({ version: 2, audit: { keepMonths: 1 } }));
    fileAuditLog({ home, now: () => new Date('2026-10-02T00:00:00Z') }).append(entry());
    expect(readdirSync(join(home, '.toil', 'audit')).sort()).toEqual(['2026-10.jsonl', 'notes.txt']);
  });

  it('reads from the month of --since on, and counts a broken line instead of failing on it', () => {
    const home = tempHome();
    mkdirSync(join(home, '.toil', 'audit'), { recursive: true });
    writeFileSync(join(home, '.toil', 'audit', '2026-08.jsonl'), auditLine(entry({ command: 'old' })));
    writeFileSync(join(home, '.toil', 'audit', '2026-09.jsonl'), `${auditLine(entry({ command: 'kept' }))}{"time":"2026-09-0\r\n`);
    const log = fileAuditLog({ home });
    expect(log.read(new Date('2026-09-15T00:00:00Z'))).toEqual({ entries: [expect.objectContaining({ command: 'kept' })], unreadable: 1 });
    expect(log.read().entries.map((e) => e.command)).toEqual(['old', 'kept']);
  });

  it('two processes writing at once never interleave their lines', async () => {
    const home = tempHome();
    const bundle = join(home, 'audit.mjs');
    buildSync({ entryPoints: [join(import.meta.dirname, '..', 'src', 'core', 'audit.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
    const writer = join(home, 'writer.mjs');
    writeFileSync(
      writer,
      `import { fileAuditLog } from ${JSON.stringify(new URL(`file:///${bundle.replace(/\\/g, '/')}`).href)};
const [home, who, count] = process.argv.slice(2);
const log = fileAuditLog({ home });
for (let i = 0; i < Number(count); i++) {
  log.append({ time: new Date().toISOString(), via: 'cli', command: 'demo get-thing', area: 'demo', connection: who, writes: false, allowWrite: false, outcome: 'ok', durationMs: i, input: { pad: 'x'.repeat(4000) }, requests: [] });
}
`,
    );
    const run = (who: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [writer, home, who, '400'], { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${who} exited ${code}`))));
      });
    await Promise.all(['a', 'b', 'c', 'd'].map(run));
    const { entries, unreadable } = fileAuditLog({ home }).read();
    expect(unreadable).toBe(0);
    expect(entries).toHaveLength(1600);
    for (const who of ['a', 'b', 'c', 'd']) expect(entries.filter((e) => e.connection === who).map((e) => e.durationMs)).toEqual(Array.from({ length: 400 }, (_, i) => i));
  }, 60_000);
});

describe('the off switch', () => {
  it('is "audit": { "enabled": false } in ~/.toil/config.json, and nothing is written while it is set', async () => {
    const home = tempHome();
    mkdirSync(join(home, '.toil'), { recursive: true });
    writeFileSync(join(home, '.toil', 'config.json'), JSON.stringify({ version: 2, audit: { enabled: false } }));
    const log = fileAuditLog({ home });
    expect(log.settings).toEqual({ enabled: false, keepMonths: 6 });
    log.append(entry());
    expect(readdirSync(join(home, '.toil'))).toEqual(['config.json']);
  });

  it('is not an env var, a flag, an MCP field, or a --config file', () => {
    const home = tempHome();
    const other = join(home, 'other.json');
    writeFileSync(other, JSON.stringify({ version: 2, audit: { enabled: false } }));
    const ctx = createNodeContext({ globals: { config: other }, def: getThing, signal: new AbortController().signal, env: { TOIL_AUDIT_ENABLED: 'false', TOIL_AUDIT: 'off' }, cwd: home, home, areas: [{ name: 'demo' }], version: '0.0.0-test', stderr: () => {} });
    expect(ctx.audit?.settings.enabled).toBe(true);
    expect(ctx.config.warnings).toContainEqual(expect.objectContaining({ code: 'AUDIT_SETTING_IGNORED' }));
    for (const def of registered) expect(Object.keys(def.input.shape).filter((f) => /audit/i.test(f)), commandName(def)).toEqual([]);
  });

  it('refuses a malformed setting rather than reading it as off', () => {
    expect(() => parseAuditSettings({ enabled: 'false' }, 'config.json')).toThrow(/must be true or false/);
    expect(() => parseAuditSettings({ keepMonths: 0 }, 'config.json')).toThrow(/1 to 120/);
    expect(() => parseAuditSettings({ disabled: true }, 'config.json')).toThrow(/isn't an audit setting/);
    const home = tempHome();
    mkdirSync(join(home, '.toil'), { recursive: true });
    writeFileSync(join(home, '.toil', 'config.json'), JSON.stringify({ version: 2, audit: { enabled: 'no' } }));
    expect(() => loadConfig({ env: {}, cwd: home, home })).toThrow(/audit.enabled/);
    // The log itself fails toward recording.
    expect(fileAuditLog({ home }).settings.enabled).toBe(true);
  });
});

describe('execute() and the log', () => {
  it('records the call, its connection, the write gate and every request, without --verbose', async () => {
    const { context, audit } = testContext({ config: demoConfig, routes: demoRoutes });
    await execute(renameThing, { id: 'THING-1', name: 'Renamed', allowWrite: true }, context, 'mcp');
    expect(audit.entries()).toEqual([
      {
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        via: 'mcp',
        command: 'demo rename-thing',
        area: 'demo',
        connection: 'demo',
        writes: true,
        allowWrite: true,
        outcome: 'ok',
        durationMs: expect.any(Number),
        input: { id: 'THING-1', name: 'Renamed', allowWrite: true },
        requests: [{ method: 'PUT', url: 'https://demo.imagile.dev/api/things/THING-1', status: 200 }],
      },
    ]);
  });

  it('records a refusal with its error code, as far as resolution got', async () => {
    const { context, audit } = testContext({ config: { demo: { token: 'demo-token' } }, routes: demoRoutes });
    await execute(renameThing, { id: 'THING-1', name: 'Renamed' }, context);
    await execute(getThing, { id: 'THING-1', nope: true }, context);
    expect(audit.entries().map((e) => [e.command, e.outcome, e.connection, e.writes, e.allowWrite])).toEqual([
      ['demo rename-thing', 'WRITE_DISABLED', 'demo', true, false],
      ['demo get-thing', 'INVALID_INPUT', null, false, false],
    ]);
  });

  it('a log that cannot be written is a warning, never a failed command', async () => {
    const broken: AuditLog = {
      ...memoryAudit(),
      dir: 'C:\\Users\\you\\.toil\\audit',
      append: () => {
        throw new Error('EACCES: permission denied');
      },
    };
    const { context } = testContext({ config: demoConfig, routes: demoRoutes, audit: broken as ReturnType<typeof memoryAudit> });
    const envelope = await execute(getThing, { id: 'THING-1' }, context);
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.warnings).toEqual([{ code: 'AUDIT_WRITE_FAILED', message: expect.stringContaining('C:/Users/you/.toil/audit: EACCES: permission denied') }]);
  });

  it('the real context writes under the home folder, standalone commands included', async () => {
    const home = tempHome();
    const version = registered.find((d) => commandName(d) === 'version')!;
    const ctx = createNodeContext({ globals: {}, def: version, signal: new AbortController().signal, env: {}, cwd: home, home, areas: [], version: '0.0.0-test', stderr: () => {} });
    await execute(version, {}, ctx);
    const [file] = readdirSync(join(home, '.toil', 'audit'));
    expect(file).toMatch(/^\d{4}-\d{2}\.jsonl$/);
    expect(JSON.parse(readFileSync(join(home, '.toil', 'audit', file!), 'utf8'))).toMatchObject({ command: 'version', via: 'cli', outcome: 'ok' });
  });
});

describe('toil audit', () => {
  const list = auditCommands(() => []);
  const seeded = () => {
    const audit = memoryAudit();
    audit.append(entry({ time: '2026-09-30T23:59:00.000Z', command: 'jira issue get', connection: 'corp-jira' }));
    audit.append(entry({ time: '2026-10-02T10:00:00.000Z', command: 'jira issue transition', connection: 'corp-jira', writes: true, allowWrite: true }));
    audit.append(entry({ time: '2026-10-03T10:00:00.000Z', command: 'jira-cloud issue get', area: 'jira-cloud', connection: 'cloud' }));
    audit.append(entry({ time: '2026-10-04T10:00:00.000Z', command: 'db execute', area: 'db', connection: 'local', writes: true, allowWrite: true }));
    return audit;
  };
  const commandsOf = (data: unknown) => (data as AuditEntry[]).map((e) => e.command);

  it('lists newest first and filters by --since, --command, --connection and --writes-only, the same through both doors', async () => {
    const cases: Array<[string[], Record<string, unknown>, string[]]> = [
      [[], {}, ['db execute', 'jira-cloud issue get', 'jira issue transition', 'jira issue get']],
      [['--since', '2026-10-01'], { since: '2026-10-01' }, ['db execute', 'jira-cloud issue get', 'jira issue transition']],
      [['--since', '2026-10-03T10:00:00Z'], { since: '2026-10-03T10:00:00Z' }, ['db execute', 'jira-cloud issue get']],
      [['--command', 'jira'], { command: 'jira' }, ['jira issue transition', 'jira issue get']],
      [['--command', 'jira issue get'], { command: 'jira issue get' }, ['jira issue get']],
      [['--connection', 'corp-jira', '--writes-only'], { connection: 'corp-jira', writesOnly: true }, ['jira issue transition']],
      [['--limit', '1'], { limit: 1 }, ['db execute']],
    ];
    for (const [argv, fields, expected] of cases) {
      const cli = await runCli(['audit', 'list', ...argv], { commands: list, context: testContext({ audit: seeded() }).context });
      expect(commandsOf(cli.envelope?.data), argv.join(' ')).toEqual(expected);
      const session = await connectMcp({ commands: list, context: testContext({ audit: seeded() }).context });
      sessions.push(session);
      const viaMcp = await session.call(toolName(list[0]!), fields);
      expect(viaMcp.envelope.data).toEqual(cli.envelope?.data);
    }
    const limited = await runCli(['audit', 'list', '--limit', '1'], { commands: list, context: testContext({ audit: seeded() }).context });
    expect(limited.envelope?.meta.warnings).toEqual([{ code: 'AUDIT_LIMIT', message: expect.stringContaining('newest 1 of 4') }]);
  });

  it('refuses a --since that is not an ISO date', async () => {
    const run = await runCli(['audit', 'list', '--since', 'last tuesday'], { commands: list, context: testContext().context });
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('last tuesday') });
  });

  it('says when the log is off', async () => {
    const run = await runCli(['audit', 'list'], { commands: list, context: testContext({ audit: memoryAudit({ enabled: false }) }).context });
    expect(run.envelope?.meta.warnings).toEqual([{ code: 'AUDIT_OFF', message: expect.stringContaining('"enabled": false') }]);
  });

  it('audit path shows the folder, whether the log is on, and where that is set', async () => {
    const home = tempHome();
    const ctx = createNodeContext({ globals: {}, def: list[2], signal: new AbortController().signal, env: {}, cwd: home, home, areas: [], version: '0.0.0-test', stderr: () => {} });
    const envelope = await execute(list[2]!, {}, ctx);
    const slashes = (p: string) => p.replace(/\\/g, '/');
    expect(envelope.data).toEqual({ path: slashes(join(home, '.toil', 'audit')), enabled: true, keepMonths: 6, configFile: slashes(join(home, '.toil', 'config.json')) });
  });

  it('the demo commands record through the CLI as well as MCP', async () => {
    const { context, audit } = testContext({ config: demoConfig, routes: demoRoutes });
    await runCli(['demo', 'get-thing', '--id', 'THING-1'], { commands: demoCommands, context });
    expect(audit.entries().map((e) => [e.via, e.command, e.area])).toEqual([['cli', 'demo get-thing', demoArea.name]]);
  });
});

describe('toil audit stats', () => {
  const fake = (path: string, area: string | null, over: Partial<AnyCommand> = {}) => ({ path: path.split(' '), kind: 'area', area: area ? { name: area } : undefined, ...over }) as unknown as AnyCommand;
  const registry = [fake('jira issue get', 'jira'), fake('jira issue transition', 'jira'), fake('jira issue delete', 'jira', { mcp: false }), fake('db execute', 'db'), fake('connections login', null, { kind: 'cli-only' })];
  const cmds = auditCommands(() => registry);
  const seeded = () => {
    const audit = memoryAudit();
    const at = (day: number, hour = 9) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    audit.append(entry({ time: '2026-09-30T23:59:00.000Z', durationMs: 5 }));
    for (const [i, ms] of [10, 20, 30, 40, 1000].entries()) audit.append(entry({ time: at(2, 9 + i), durationMs: ms }));
    audit.append(entry({ time: at(3), outcome: 'AUTH', durationMs: 7, via: 'api', caller: 'toil-ui' }));
    audit.append(entry({ time: at(3, 10), outcome: 'AUTH', durationMs: 9, via: 'mcp' }));
    audit.append(entry({ time: at(4), outcome: 'NOT_FOUND', durationMs: 3, via: 'mcp' }));
    audit.append(entry({ time: at(4, 10), command: 'jira issue transition', writes: true, allowWrite: true, durationMs: 50, via: 'mcp' }));
    audit.append(entry({ time: at(5), command: 'db execute', area: 'db', connection: 'local', writes: true, durationMs: 80, outcome: 'DATABASE', input: { sql: 'sha256:abc' } }));
    return audit;
  };
  const run = async (argv: string[], fields: Record<string, unknown>) => {
    const cli = await runCli(['audit', 'stats', ...argv], { commands: cmds, context: testContext({ audit: seeded() }).context });
    const session = await connectMcp({ commands: cmds, context: testContext({ audit: seeded() }).context });
    sessions.push(session);
    const viaMcp = await session.call(toolName(cmds[1]!), fields);
    expect(viaMcp.envelope.data, `the same through MCP: ${argv.join(' ')}`).toEqual(cli.envelope?.data);
    return cli.envelope!;
  };
  const window = ['--since', '2026-10-01', '--until', '2026-10-31'];
  const fields = { since: '2026-10-01', until: '2026-10-31' };
  type Groups = { groups: Array<Record<string, unknown>> };

  it('totals the window and groups by command, most calls first, with counts, top errors, durations and write share', async () => {
    const e = await run(window, fields);
    expect(e.ok).toBe(true);
    const data = e.data as { window: unknown; by: string[]; totals: Record<string, unknown> } & Groups;
    expect(data.window).toEqual({ since: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z' });
    expect(data.by).toEqual(['command']);
    // The 30 September line is outside the window.
    expect(data.totals).toMatchObject({ calls: 10, ok: 6, failed: 4, writes: 2, writeShare: 0.2, firstSeen: '2026-10-02T09:00:00.000Z', lastSeen: '2026-10-05T09:00:00.000Z' });
    expect(data.groups.map((g) => [g.command, g.calls])).toEqual([
      ['jira issue get', 8],
      ['db execute', 1],
      ['jira issue transition', 1],
    ]);
    const get = data.groups[0]!;
    expect(get).toMatchObject({ ok: 5, failed: 3, writes: 0, writeShare: 0 });
    // Nearest rank over 3, 7, 9, 10, 20, 30, 40, 1000: the 4th and the 8th.
    expect(get.durationMs).toEqual({ median: 10, p95: 1000 });
    expect(get.errors).toEqual([
      { code: 'AUTH', count: 2, fix: expect.stringContaining('toil connections login') },
      { code: 'NOT_FOUND', count: 1, fix: expect.any(String) },
    ]);
  });

  it('cross-tabs several dimensions, and keeps a missing value as null', async () => {
    const data = (await run([...window, '--by', 'via', '--by', 'caller'], { ...fields, by: ['via', 'caller'] })).data as Groups;
    expect(data.groups.map((g) => [g.via, g.caller, g.calls])).toEqual([
      ['cli', null, 6],
      ['mcp', null, 3],
      ['api', 'toil-ui', 1],
    ]);
  });

  it('puts days in date order, and groups by area, connection and outcome', async () => {
    const days = (await run([...window, '--by', 'day'], { ...fields, by: ['day'] })).data as Groups;
    expect(days.groups.map((g) => [g.day, g.calls])).toEqual([
      ['2026-10-02', 5],
      ['2026-10-03', 2],
      ['2026-10-04', 2],
      ['2026-10-05', 1],
    ]);
    const outcomes = (await run([...window, '--by', 'outcome'], { ...fields, by: ['outcome'] })).data as Groups;
    expect(outcomes.groups.map((g) => [g.outcome, g.calls])).toEqual([
      ['ok', 6],
      ['AUTH', 2],
      ['DATABASE', 1],
      ['NOT_FOUND', 1],
    ]);
    const areas = (await run([...window, '--by', 'area', '--by', 'connection'], { ...fields, by: ['area', 'connection'] })).data as Groups;
    expect(areas.groups.map((g) => [g.area, g.connection, g.calls])).toEqual([
      ['jira', 'corp-jira', 9],
      ['db', 'local', 1],
    ]);
  });

  it('filters by area, command, caller and outcome, failed meaning any failure', async () => {
    const calls = async (argv: string[], f: Record<string, unknown>) => ((await run([...window, ...argv], { ...fields, ...f })).data as { totals: { calls: number } }).totals.calls;
    expect(await calls(['--area', 'db'], { area: 'db' })).toBe(1);
    expect(await calls(['--command', 'jira'], { command: 'jira' })).toBe(9);
    expect(await calls(['--command', 'jira issue get'], { command: 'jira issue get' })).toBe(8);
    expect(await calls(['--caller', 'toil-ui'], { caller: 'toil-ui' })).toBe(1);
    expect(await calls(['--outcome', 'failed'], { outcome: 'failed' })).toBe(4);
    expect(await calls(['--outcome', 'AUTH'], { outcome: 'AUTH' })).toBe(2);
    expect(await calls(['--outcome', 'ok'], { outcome: 'ok' })).toBe(6);
  });

  it('--unused lists the registered commands with no call in the window, within the filters, and says which MCP serves', async () => {
    const data = (await run([...window, '--unused'], { ...fields, unused: true })).data as { unused: unknown };
    expect(data.unused).toEqual([
      { command: 'connections login', area: null, mcp: false },
      { command: 'jira issue delete', area: 'jira', mcp: false },
    ]);
    const jira = (await run([...window, '--unused', '--area', 'jira', '--outcome', 'ok'], { ...fields, unused: true, area: 'jira', outcome: 'ok' })).data as { unused: Array<{ command: string }> };
    expect(jira.unused.map((u) => u.command)).toEqual(['jira issue delete']);
    // Without --unused, there's no list at all.
    expect((await run(window, fields)).data).not.toHaveProperty('unused');
  });

  it('defaults to the 30 days from midnight UTC, and returns empty figures for an empty window', async () => {
    const data = (await runCli(['audit', 'stats'], { commands: cmds, context: testContext({ audit: memoryAudit() }).context })).envelope?.data as { window: unknown; totals: unknown } & Groups;
    const today = new Date();
    expect(data.window).toEqual({ since: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 30)).toISOString(), until: null });
    expect(data.totals).toEqual({ calls: 0, ok: 0, failed: 0, errors: [], durationMs: { median: 0, p95: 0 }, writes: 0, writeShare: 0, firstSeen: '', lastSeen: '' });
    expect(data.groups).toEqual([]);
  });

  it('refuses a bad time, an until before since, and a dimension it does not know', async () => {
    const fail = async (argv: string[]) => (await runCli(['audit', 'stats', ...argv], { commands: cmds, context: testContext({ audit: seeded() }).context })).envelope?.error;
    expect(await fail(['--until', 'soon'])).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('until "soon"') });
    expect(await fail(['--since', '2026-10-05', '--until', '2026-10-01'])).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('later than since'), fix: expect.stringContaining('Pass an until after since') });
    // With no since, the default is what until fell behind, and the fix says so.
    expect(await fail(['--until', '2020-01-01'])).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining(', the default)'), fix: expect.stringContaining('pass an earlier since (--since)') });
    expect(await fail(['--by', 'input'])).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('never groups by an input value: a hashed statement is never a heading', async () => {
    const all = ['command', 'area', 'connection', 'caller', 'via', 'outcome', 'day'];
    const e = await run([...window, ...all.flatMap((d) => ['--by', d])], { ...fields, by: all });
    expect(JSON.stringify(e.data)).not.toContain('sha256');
  });

  it('audit list filters by outcome too', async () => {
    const cli = await runCli(['audit', 'list', '--outcome', 'failed', '--command', 'jira issue get'], { commands: cmds, context: testContext({ audit: seeded() }).context });
    expect((cli.envelope?.data as AuditEntry[]).map((e) => e.outcome)).toEqual(['NOT_FOUND', 'AUTH', 'AUTH']);
  });

  it('the registry hands --unused every shipped command', async () => {
    const real = registered.find((d) => commandName(d) === 'audit stats')!;
    const e = await runCli(['audit', 'stats', '--unused'], { commands: [real], context: testContext({ audit: memoryAudit() }).context });
    expect((e.envelope?.data as { unused: unknown[] }).unused).toHaveLength(registered.length);
  });
});

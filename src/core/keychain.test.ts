import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSecretStore, storeVerified, WINDOWS_SCRIPT, type SecretStore, type SpawnResult, type Spawner } from './keychain.js';

const SECRET = 'fake-token-abc12345';

/** A spawner that records every call and answers from `respond`; nothing real ever runs. */
function recorder(respond: (command: string, args: string[], input: string) => Partial<SpawnResult> = () => ({})) {
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const spawn: Spawner = async (command, args, input) => {
    calls.push({ command, args, input });
    return { status: 0, stdout: '', stderr: '', ...respond(command, args, input) };
  };
  return { spawn, calls };
}

const enoent = (): Partial<SpawnResult> => ({ status: null, error: Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }) });

function expectSecretOnlyOnStdin(calls: Array<{ args: string[]; input: string }>, onStdin: string) {
  for (const call of calls) expect(call.args.join(' ')).not.toContain(SECRET);
  expect(calls.some((c) => c.input.includes(onStdin))).toBe(true);
}

describe('macOS store (security)', () => {
  it('stores through `security -i` with the secret hex-encoded on stdin, never on argv', async () => {
    const { spawn, calls } = recorder();
    await createSecretStore({ platform: 'darwin', spawn }).set('corp-jira.token', SECRET);
    expect(calls).toEqual([
      { command: 'security', args: ['-i'], input: `add-generic-password -U -s toil -a corp-jira.token -l "toil corp-jira.token" -X ${Buffer.from(SECRET).toString('hex')}\n` },
    ]);
    expectSecretOnlyOnStdin(calls, Buffer.from(SECRET).toString('hex'));
  });

  // Found running Toil UI on an isolated home: with HOME elsewhere, `security`
  // finds no keychain and every entry reads as not found.
  it("runs security with HOME set to the account's own home, not $HOME, for every call", async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const spawn: Spawner = async (_command, args, _input, _signal, env) => {
      envs.push(env);
      return { status: 0, stdout: args.includes('find-generic-password') ? `${SECRET}\n` : '', stderr: '' };
    };
    const store = createSecretStore({ platform: 'darwin', spawn, accountHome: '/Users/you' });
    await store.set('corp-jira.token', SECRET);
    expect(await store.get('corp-jira.token')).toBe(SECRET);
    await store.delete('corp-jira.token');
    expect(envs).toEqual([{ HOME: '/Users/you' }, { HOME: '/Users/you' }, { HOME: '/Users/you' }]);
  });

  it('takes the account home from the user database by default, whatever $HOME says', async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const spawn: Spawner = async (_command, _args, _input, _signal, env) => (envs.push(env), { status: 44, stdout: '', stderr: '' });
    const was = process.env.HOME;
    process.env.HOME = join(tmpdir(), 'not-the-account-home');
    try {
      await createSecretStore({ platform: 'darwin', spawn }).get('corp-jira.token');
    } finally {
      process.env.HOME = was;
    }
    expect(envs[0]?.HOME).toBe((await import('node:os')).userInfo().homedir);
    expect(envs[0]?.HOME).not.toBe(join(tmpdir(), 'not-the-account-home'));
  });

  it('the Windows and Linux stores pass no environment override', async () => {
    const envs: unknown[] = [];
    const spawn: Spawner = async (_command, _args, _input, _signal, env) => (envs.push(env), { status: 0, stdout: '', stderr: '' });
    await createSecretStore({ platform: 'linux', spawn }).get('corp-jira.token');
    expect(envs).toEqual([undefined]);
  });

  it('reads with find-generic-password -w, and treats exit 44 as no entry', async () => {
    const found = recorder(() => ({ stdout: `${SECRET}\n` }));
    expect(await createSecretStore({ platform: 'darwin', spawn: found.spawn }).get('corp-jira.token')).toBe(SECRET);
    expect(found.calls[0]).toMatchObject({ command: 'security', args: ['find-generic-password', '-s', 'toil', '-a', 'corp-jira.token', '-w'] });
    const missing = recorder(() => ({ status: 44 }));
    expect(await createSecretStore({ platform: 'darwin', spawn: missing.spawn }).get('corp-jira.token')).toBeUndefined();
  });

  it('deletes, saying whether there was an entry', async () => {
    expect(await createSecretStore({ platform: 'darwin', spawn: recorder().spawn }).delete('corp-jira.token')).toBe(true);
    expect(await createSecretStore({ platform: 'darwin', spawn: recorder(() => ({ status: 44 })).spawn }).delete('corp-jira.token')).toBe(false);
  });

  it('fails a store when security reports an error on stderr', async () => {
    const store = createSecretStore({ platform: 'darwin', spawn: recorder(() => ({ stderr: 'security: SecKeychainItemCreateFromContent: error' })).spawn });
    await expect(store.set('corp-jira.token', SECRET)).rejects.toMatchObject({ code: 'CREDENTIAL_STORE' });
  });
});

describe('Windows store (Credential Manager through PowerShell)', () => {
  const decodeScript = (args: string[]) => Buffer.from(args[args.length - 1]!, 'base64').toString('utf16le');

  it('runs the constant advapi32 script with the request, secret included, as JSON on stdin', async () => {
    const { spawn, calls } = recorder(() => ({ stdout: '{"ok":true}' }));
    await createSecretStore({ platform: 'win32', spawn }).set('corp-jira.token', SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('powershell.exe');
    expect(calls[0]!.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(decodeScript(calls[0]!.args)).toBe(WINDOWS_SCRIPT);
    expect(JSON.parse(calls[0]!.input)).toEqual({ op: 'set', target: 'toil:corp-jira.token', user: 'corp-jira.token', secret: SECRET });
    expectSecretOnlyOnStdin(calls, SECRET);
  });

  it('uses CredRead, CredWrite and CredDelete from advapi32', () => {
    for (const fn of ['CredReadW', 'CredWriteW', 'CredDeleteW']) expect(WINDOWS_SCRIPT).toContain(`advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]\n  private static extern bool ${fn}`);
  });

  it('reads a secret, and a null as no entry', async () => {
    const found = recorder(() => ({ stdout: JSON.stringify({ secret: SECRET }) }));
    expect(await createSecretStore({ platform: 'win32', spawn: found.spawn }).get('corp-jira.token')).toBe(SECRET);
    expect(JSON.parse(found.calls[0]!.input)).toEqual({ op: 'get', target: 'toil:corp-jira.token' });
    expect(await createSecretStore({ platform: 'win32', spawn: recorder(() => ({ stdout: '{"secret":null}' })).spawn }).get('corp-jira.token')).toBeUndefined();
  });

  it('deletes, saying whether there was an entry', async () => {
    expect(await createSecretStore({ platform: 'win32', spawn: recorder(() => ({ stdout: '{"deleted":true}' })).spawn }).delete('corp-jira.token')).toBe(true);
    expect(await createSecretStore({ platform: 'win32', spawn: recorder(() => ({ stdout: '{"deleted":false}' })).spawn }).delete('corp-jira.token')).toBe(false);
  });

  it('falls back to pwsh when Windows PowerShell is missing', async () => {
    const { spawn, calls } = recorder((command) => (command === 'powershell.exe' ? enoent() : { stdout: '{"secret":"x"}' }));
    expect(await createSecretStore({ platform: 'win32', spawn }).get('corp-jira.token')).toBe('x');
    expect(calls.map((c) => c.command)).toEqual(['powershell.exe', 'pwsh']);
  });
});

describe('Linux store (secret-tool)', () => {
  it('stores with the secret on stdin, never on argv', async () => {
    const { spawn, calls } = recorder();
    await createSecretStore({ platform: 'linux', spawn }).set('corp-jira.token', SECRET);
    expect(calls).toEqual([{ command: 'secret-tool', args: ['store', '--label=toil corp-jira.token', 'service', 'toil', 'account', 'corp-jira.token'], input: SECRET }]);
    expectSecretOnlyOnStdin(calls, SECRET);
  });

  it('reads with lookup; a silent exit 1 is no entry, one with an error is a failure', async () => {
    const found = recorder(() => ({ stdout: SECRET }));
    expect(await createSecretStore({ platform: 'linux', spawn: found.spawn }).get('corp-jira.token')).toBe(SECRET);
    expect(found.calls[0]!.args).toEqual(['lookup', 'service', 'toil', 'account', 'corp-jira.token']);
    expect(await createSecretStore({ platform: 'linux', spawn: recorder(() => ({ status: 1 })).spawn }).get('corp-jira.token')).toBeUndefined();
    const locked = createSecretStore({ platform: 'linux', spawn: recorder(() => ({ status: 1, stderr: 'Cannot autolaunch D-Bus' })).spawn });
    await expect(locked.get('corp-jira.token')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE' });
  });

  it('deletes with clear only when there is an entry', async () => {
    const present = recorder((_c, args) => (args[0] === 'lookup' ? { stdout: SECRET } : {}));
    expect(await createSecretStore({ platform: 'linux', spawn: present.spawn }).delete('corp-jira.token')).toBe(true);
    expect(present.calls.map((c) => c.args[0])).toEqual(['lookup', 'clear']);
    const absent = recorder(() => ({ status: 1 }));
    expect(await createSecretStore({ platform: 'linux', spawn: absent.spawn }).delete('corp-jira.token')).toBe(false);
    expect(absent.calls.map((c) => c.args[0])).toEqual(['lookup']);
  });
});

describe('when the store is unavailable', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`${platform}: a ToilError whose fix names the connection's env var`, async () => {
      const store = createSecretStore({ platform, spawn: recorder(enoent).spawn });
      const expected = { code: 'CREDENTIAL_STORE', fix: expect.stringContaining('Set TOIL_CONN_CORP_JIRA_TOKEN instead') };
      await expect(store.set('corp-jira.token', SECRET)).rejects.toMatchObject(expected);
      await expect(store.get('corp-jira.token')).rejects.toMatchObject(expected);
    });
  }

  it('an unsupported platform has no store, and says so the same way', async () => {
    const { spawn, calls } = recorder();
    const store = createSecretStore({ platform: 'aix', spawn });
    await expect(store.set('corp-jira.token', SECRET)).rejects.toMatchObject({ code: 'CREDENTIAL_STORE', fix: expect.stringContaining('TOIL_CONN_CORP_JIRA_TOKEN') });
    expect(calls).toHaveLength(0);
  });

  // The real spawner, driven through a store whose program this machine doesn't
  // have (secret-tool off Linux, security on Linux), so no real store is touched.
  it("the real spawner reports a store program that isn't installed as unavailable, without blocking", async () => {
    const store = createSecretStore({ platform: process.platform === 'linux' ? 'darwin' : 'linux' });
    let ticked = false;
    setImmediate(() => (ticked = true));
    await expect(store.get('corp-jira.token')).rejects.toMatchObject({ code: 'CREDENTIAL_STORE', fix: expect.stringContaining('TOIL_CONN_CORP_JIRA_TOKEN') });
    expect(ticked, 'the event loop kept running while the store was asked').toBe(true);
  });
});

describe('every store', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`${platform}: refuses a reference that isn't a plain name, before spawning anything`, async () => {
      const { spawn, calls } = recorder();
      const store = createSecretStore({ platform, spawn });
      for (const bad of ['', 'a b', 'x;rm -rf', '-s', 'a"b', '../x']) await expect(store.get(bad)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      expect(calls).toHaveLength(0);
    });

    it(`${platform}: refuses an empty or multi-line secret`, async () => {
      const store = createSecretStore({ platform, spawn: recorder().spawn });
      await expect(store.set('a.token', '')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(store.set('a.token', 'one\ntwo')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it(`${platform}: passes the caller's signal to the spawner`, async () => {
      const signals: Array<AbortSignal | undefined> = [];
      const store = createSecretStore({ platform, spawn: async (_c, _a, _i, signal) => (signals.push(signal), { status: 0, stdout: '{}', stderr: '' }) });
      const controller = new AbortController();
      await store.get('a.token', controller.signal);
      expect(signals[0]).toBe(controller.signal);
    });
  }
});

describe('storeVerified', () => {
  it('reads the secret back after storing it, and fails when it differs', async () => {
    const entries = new Map<string, string>();
    const good: SecretStore = {
      name: 'fake',
      get: async (r) => entries.get(r),
      set: async (r, s) => void entries.set(r, s),
      delete: async (r) => entries.delete(r),
    };
    await storeVerified(good, 'a.token', SECRET);
    expect(entries.get('a.token')).toBe(SECRET);
    const lossy: SecretStore = { ...good, set: async () => {} };
    await expect(storeVerified(lossy, 'b.token', SECRET)).rejects.toMatchObject({ code: 'CREDENTIAL_STORE' });
  });
});

describe('the real spawner', () => {
  // The Linux store's own code path, with Node standing in for secret-tool
  // through the test-only override: the real spawn runs, no real store does.
  const node = (script: string, ...extra: string[]) => ({ command: process.execPath, args: ['-e', script, ...extra] });

  it('delivers the secret on stdin byte for byte, passes arguments literally, and runs no shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'toil-spawn-'));
    try {
      const out = join(dir, 'seen.json');
      // Records what the child actually received: stdin, argv, and whether a shell sits in between.
      const script = `let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c).on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({stdin:d,argv:process.argv.slice(1)})));`;
      const literal = '$(x) & | ; $HOME %PATH% `id`';
      const store = createSecretStore({ platform: 'linux', testOnlyProgram: node(script, literal) });
      await store.set('corp-jira.token', 's3cret-$HOME');
      const seen = JSON.parse(readFileSync(out, 'utf8')) as { stdin: string; argv: string[] };
      expect(seen.stdin).toBe('s3cret-$HOME');
      // Had a shell run, `$(x)`, `$HOME`, `%PATH%`, backticks, `&`, `|` and `;` would have been expanded or split.
      expect(seen.argv).toEqual([literal, 'secret-tool', 'store', '--label=toil corp-jira.token', 'service', 'toil', 'account', 'corp-jira.token']);
      expect(seen.argv.join(' ')).not.toContain('s3cret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ends a hung child promptly when aborted, and reports CANCELLED', async () => {
    const store = createSecretStore({ platform: 'linux', testOnlyProgram: node('setTimeout(() => {}, 60000)') });
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 100);
    await expect(store.get('corp-jira.token', controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

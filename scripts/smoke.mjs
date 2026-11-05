// Installs the packed tarball the way a locked-down user would (npm, scripts
// off) into a throwaway prefix, then drives the installed bin through both
// front doors: the CLI, and MCP over stdio. Then it clones this checkout and runs
// the bundle from the clone with no install, through `setup alias` and a real
// shell. Run after `npm run build`.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// Run npm's own CLI through node: no shell, so nothing is string-concatenated,
// and it works the same on Windows. npm sets npm_execpath under `npm run`.
const npmCli = process.env.npm_execpath;
const runNpm = (args) =>
  npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { encoding: 'utf8' })
    : spawnSync('npm', args, { encoding: 'utf8' });
const work = mkdtempSync(join(tmpdir(), 'toil-smoke-'));
// A home of its own, so the installed toil's config and audit log land here,
// not in the home of whoever runs the smoke test.
const home = join(work, 'home');
const env = { ...process.env, HOME: home, USERPROFILE: home };
const fail = (message) => {
  console.error(`smoke: ${message}`);
  process.exitCode = 1;
};

try {
  const packed = runNpm(['pack', '--ignore-scripts', '--pack-destination', work, '--json']);
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  const tarball = join(work, JSON.parse(packed.stdout)[0].filename);

  const prefix = join(work, 'install');
  const installed = runNpm(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  if (installed.status !== 0) throw new Error(`npm install failed: ${installed.stderr}`);
  const bin = join(prefix, 'node_modules', '@imagile-dev', 'toil', 'dist', 'toil.js');

  const envelope = JSON.parse(execFileSync(process.execPath, [bin, 'version'], { encoding: 'utf8', env }));
  if (!envelope.ok || typeof envelope.data?.version !== 'string') fail(`toil version returned ${JSON.stringify(envelope)}`);
  // A build from a git checkout records its commit, which the terminal feedback endpoint asks for.
  if (!/^[0-9a-f]{40}$/.test(envelope.data?.commit ?? '')) fail(`toil version reported commit ${JSON.stringify(envelope.data?.commit)}, not the 40-character hash of the commit it was built from`);

  // Setup commands from a pipe: no prompt, no hang, an envelope with the env-var fix.
  const configFile = join(work, 'config.json');
  const toil = (...args) => JSON.parse(spawnSync(process.execPath, [bin, '--config', configFile, ...args], { encoding: 'utf8', input: '', timeout: 15000, env }).stdout);
  const added = toil('connections', 'add', 'smoke');
  if (added.error?.code !== 'INVALID_INPUT' || !added.error.fix?.includes('TOIL_CONN_SMOKE_AREA')) fail(`connections add without a terminal returned ${JSON.stringify(added)}`);
  const listed = toil('connections', 'list');
  if (!listed.ok || !Array.isArray(listed.data?.connections)) fail(`connections list returned ${JSON.stringify(listed)}`);

  // The bounded worker (src/areas/util/kit/bounded.ts) from the installed bundle: a
  // document validates in a real worker thread, a backtracking pattern is stopped at
  // its deadline, and with worker threads denied by Node's permission model the
  // check is unchecked with a reason, never a crash.
  const workerStep = boundedWorker(bin);

  // No git on PATH (CLAUDE.md, No Executables): toil still starts, and a command
  // that runs git answers GIT_NOT_FOUND, exit 1, rather than hanging or crashing.
  const stripped = { ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH')), PATH: '' };
  const bare = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', input: '', timeout: 15000, env: stripped, cwd: work });
  const started = bare('version');
  if (started.status !== 0 || JSON.parse(started.stdout).ok !== true) fail(`toil version with PATH stripped returned ${started.stdout || started.stderr}`);
  const gitCommands = [['git', 'status']];
  // `--help` on an unknown command prints the root help, so look for the command's own usage line.
  const gitCommand = gitCommands.find((path) => bare(...path, '--help').stdout.includes(`Usage: toil ${path.join(' ')}`));
  let gitStep = 'no command that runs git is registered yet, so only startup was checked with PATH stripped';
  if (gitCommand) {
    const run = bare(...gitCommand);
    const env = JSON.parse(run.stdout || '{}');
    if (run.status !== 1 || env.error?.code !== 'GIT_NOT_FOUND' || !env.error.fix?.includes('PATH searched')) fail(`toil ${gitCommand.join(' ')} with PATH stripped returned ${run.stdout || run.stderr || `signal ${run.signal}`}`);
    gitStep = `toil ${gitCommand.join(' ')} answered GIT_NOT_FOUND with PATH stripped`;
  }

  const { reply, stoppedOnSigint } = await mcpVersion(bin);
  if (reply?.structuredContent?.ok !== true) fail(`MCP tools/call version returned ${JSON.stringify(reply)}`);
  if (!stoppedOnSigint) fail('toil mcp was still running 3s after SIGINT; the first Ctrl+C must stop it.');

  // Loading the bundle runs nothing, even as the script Node started: a host that
  // bundles the API into its own file can't start toil's CLI by accident.
  const lib = spawnSync(process.execPath, [join(prefix, 'node_modules', '@imagile-dev', 'toil', 'dist', 'toil-lib.js'), 'version'], { encoding: 'utf8', input: '', timeout: 15000, env });
  if (lib.status !== 0 || lib.stdout !== '' || lib.stderr !== '') fail(`node dist/toil-lib.js version ran something: exit ${lib.status}, ${JSON.stringify(lib.stdout + lib.stderr).slice(0, 300)}`);

  // `@imagile-dev/toil/api` from the install, the way a program depending on the package uses it.
  const apiStep = await apiConsumer(prefix, bin);

  // Every call above, through every front door, left one line in the audit log.
  const auditDir = join(home, '.toil', 'audit');
  const lines = readdirSync(auditDir).flatMap((f) => readFileSync(join(auditDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const doors = lines.map((l) => `${l.via} ${l.command}`);
  if (!doors.includes('cli version') || !doors.includes('mcp version') || !doors.includes('cli connections list') || !doors.includes('api bitbucket pr list')) fail(`the audit log holds ${JSON.stringify(doors)}`);
  const labelled = lines.filter((l) => l.via === 'api' && l.command === 'bitbucket pr list');
  if (!labelled.length || labelled.some((l) => l.caller !== 'api-consumer')) fail(`the API's audit lines are ${JSON.stringify(labelled)}`);

  const cloneStep = await fromClone(envelope.data.version);

  if (!process.exitCode) console.log(`smoke ok: installed ${envelope.data.version} with scripts off; CLI, connections and MCP all answered, ${apiStep}, ${lines.length} audit lines written, on Node ${process.versions.node} (${process.platform}); ${workerStep}; ${gitStep}; ${cloneStep}.`);
} catch (err) {
  fail(err.message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

/**
 * util openapi and util c4 through the installed bundle, which run JSON Schema
 * validation, a document's own patterns and a C4 layout in a worker thread evaluated from a string
 * inside dist/toil.js. Proves the worker starts from the built bundle (not from
 * source), that a deadline stops it, and that a Node which forbids workers gets
 * an unchecked result rather than a crash.
 */
function boundedWorker(bin) {
  const doc = (sku) => JSON.stringify({ openapi: '3.0.3', info: { title: 'Smoke', version: '1' }, paths: { '/o': { post: { operationId: 'o', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['sku'], properties: { sku } } } } }, responses: { 200: { description: 'ok' } } } } } });
  const toil = (args, flags = []) => {
    const ran = spawnSync(process.execPath, [...flags, bin, ...args], { encoding: 'utf8', input: '', timeout: 30000, env, cwd: work });
    try {
      return JSON.parse(ran.stdout);
    } catch {
      return { stdout: ran.stdout, stderr: ran.stderr };
    }
  };
  const checkOf = (envelope, name) => envelope.data?.verified?.checks?.find((c) => c.check === name);

  const plain = toil(['util', 'openapi', 'example', '--text', doc({ type: 'string', pattern: '^[A-Z]{3}-\\d+$' }), '--operation', 'o']);
  if (checkOf(plain, 'document.schema')?.status !== 'passed' || checkOf(plain, 'example.valid')?.status !== 'passed' || plain.data?.example?.sku !== 'AAA-0') {
    fail(`util openapi example in a worker returned ${JSON.stringify(plain).slice(0, 600)}`);
  }
  const started = Date.now();
  const stuck = toil(['util', 'openapi', 'example', '--text', doc({ type: 'string', minLength: 41, maxLength: 41, pattern: '(x+)+y' }), '--operation', 'o']);
  const took = Date.now() - started;
  if (!/took longer than 2 s/.test(checkOf(stuck, 'example.patterns')?.detail ?? '') || took > 20000) fail(`a backtracking pattern returned ${JSON.stringify(stuck).slice(0, 600)} after ${took} ms`);
  const denied = toil(['util', 'openapi', 'list', '--text', doc({ type: 'string' })], ['--permission', '--allow-fs-read=*']);
  if (checkOf(denied, 'document.schema')?.status !== 'unchecked' || !/--allow-worker/.test(checkOf(denied, 'document.schema')?.detail ?? '')) fail(`util openapi list with workers denied returned ${JSON.stringify(denied).slice(0, 600)}`);
  // util c4 render lays its view out in the same worker: the layout must be in the string too.
  const model = { people: [{ id: 'reader', name: 'Reader' }], systems: [{ id: 'site', name: 'Site' }, { id: 'db', name: 'Store' }], relationships: [{ source: 'reader', destination: 'site', description: 'Reads' }, { source: 'site', destination: 'db' }], views: [{ key: 'v', type: 'systemContext', scope: 'site' }] };
  const drawn = toil(['util', 'c4', 'render', '--text', JSON.stringify(model)]);
  if (drawn.data?.verified?.passed !== true || checkOf(drawn, 'edges.clearOfBoxes')?.status !== 'passed' || !drawn.data?.svg?.startsWith('<svg')) fail(`util c4 render in a worker returned ${JSON.stringify(drawn).slice(0, 600)}`);
  return `util openapi validated and util c4 laid out in a worker from the bundle, a backtracking pattern stopped in ${took} ms, and with workers denied the check came back unchecked`;
}

/**
 * scripts/api-consumer/: a program that imports `@imagile-dev/toil/api` by
 * name from the installed package, against a stub Bitbucket on loopback that
 * answers 429 once and then two pages. It must page through a read-only call
 * with progress, refuse a write before sending anything, and name itself in the
 * audit log. consumer.ts is then type-checked, strict, against the installed
 * dist/api.d.ts. The CLI on a pipe, against the same stub, says the retry on
 * stderr, sends no line per page, and keeps stdout one envelope.
 */
async function apiConsumer(prefix, bin) {
  const sent = [];
  let hits = 0;
  const server = createServer((req, res) => {
    sent.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://stub');
    if (req.method !== 'GET' || url.pathname !== '/rest/api/1.0/projects/PAY/repos/web/pull-requests') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"errors":[{"message":"not stubbed"}]}');
      return;
    }
    // Each run's first request is rate limited, asking for a 0 s wait; then two pages.
    if (hits++ % 3 === 0) {
      res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }).end('{}');
      return;
    }
    const page = url.searchParams.get('start') === '0' ? { values: [{ id: 1 }], isLastPage: false, nextPageStart: 1 } : { values: [{ id: 2 }], isLastPage: true };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stubEnv = { ...env, TOIL_BITBUCKET_BASE_URL: `http://127.0.0.1:${server.address().port}`, TOIL_BITBUCKET_PAT: 'smoke-placeholder' };
  // Spawned, not spawnSync: the stub answers from this process's event loop.
  const run = (args, cwd) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd, env: stubEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      const timer = setTimeout(() => child.kill(), 30000);
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  try {
    const here = join(process.cwd(), 'scripts', 'api-consumer');
    copyFileSync(join(here, 'consumer.mjs'), join(prefix, 'consumer.mjs'));
    const ran = await run(['consumer.mjs'], prefix);
    let out;
    try {
      out = JSON.parse(ran.stdout);
    } catch {
      throw new Error(`the API consumer printed ${ran.stdout || ran.stderr}`);
    }
    const types = out.events.map((e) => e.type);
    if (out.contractVersion !== 3 || out.listed.contractVersion !== 3 || typeof out.version !== 'string') fail(`the API reported version ${out.version}, contract ${out.contractVersion} and ${out.listed.contractVersion}`);
    if (out.commands < 100 || out.listPrs?.tool !== 'bitbucket_pr_list' || out.listPrs.writes !== false || !out.listPrs.hasSchema) fail(`the API's registry gave ${out.commands} commands, pr list as ${JSON.stringify(out.listPrs)}`);
    if (!out.listed.ok || JSON.stringify(out.listed.ids) !== '[1,2]') fail(`execute('bitbucket pr list') returned ${JSON.stringify(out.listed)}`);
    if (types.filter((t) => t === 'page').length !== 2 || !types.includes('retry') || types.filter((t) => t === 'request').length !== 3) fail(`the API heard progress ${JSON.stringify(out.events)}`);
    if (out.refused !== 'WRITE_DISABLED' || out.unknown !== 'INVALID_INPUT' || out.badCaller !== 'INVALID_INPUT') fail(`the API's refusals were ${JSON.stringify({ refused: out.refused, unknown: out.unknown, badCaller: out.badCaller })}`);
    if (out.owi?.version !== '0.2' || typeof out.owi.schemaId !== 'string' || JSON.stringify(out.owi.item) !== JSON.stringify({ id: 'jira:PAY-1', statusCategory: 'TODO', estimate: { value: 3, unit: 'points', field: 'customfield_10234' } }) || out.owi.checked !== true) fail(`the API's OWI mapping gave ${JSON.stringify(out.owi)}`);
    if (sent.some((line) => !line.startsWith('GET '))) fail(`the stub Bitbucket was sent ${JSON.stringify(sent)}; a read-only call may only read`);

    // Types: the same calls in TypeScript, strict, against the installed declarations.
    copyFileSync(join(here, 'consumer.ts'), join(prefix, 'consumer.mts'));
    const tsconfig = { compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2023', lib: ['es2023'], types: ['node'], typeRoots: [join(process.cwd(), 'node_modules', '@types')], noEmit: true, skipLibCheck: false }, files: ['consumer.mts'] };
    writeFileSync(join(prefix, 'tsconfig.json'), JSON.stringify(tsconfig));
    const tsc = spawnSync(process.execPath, [join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: prefix, encoding: 'utf8', timeout: 60000 });
    if (tsc.status !== 0) fail(`consumer.ts didn't type-check against the installed dist/api.d.ts: ${tsc.stdout || tsc.stderr}`);

    // The CLI on a pipe: the retry said on stderr, no line per page, and stdout still exactly one envelope.
    const cli = await run([bin, 'bitbucket', 'pr', 'list', '--project', 'PAY', '--repo', 'web'], work);
    let envelope;
    try {
      envelope = JSON.parse(cli.stdout);
    } catch {
      envelope = undefined;
    }
    if (envelope?.ok !== true || envelope.data.length !== 2) fail(`toil bitbucket pr list printed ${cli.stdout}`);
    const said = cli.stderr.split(/\r?\n/).filter((l) => l.startsWith('[toil] bitbucket pr list: '));
    if (said.some((l) => l.includes('read page')) || !said.some((l) => l.includes('rate limited (429)'))) fail(`toil bitbucket pr list on a pipe wrote progress ${JSON.stringify(said)}`);
    return `the API consumer paged a read-only call with ${out.events.length} progress events, refused a write before sending it, mapped an envelope to OWI and type-checked against dist/api.d.ts, and the CLI on a pipe said the retry on stderr`;
  } finally {
    server.close();
  }
}

/**
 * The clone path: a fresh clone of this checkout's HEAD has a committed
 * dist/toil.js and no node_modules, and runs the bundle from there, CLI and
 * MCP; then `setup alias` puts `toil` in a profile and a real shell runs
 * `toil version` through it. The committed bundle is the last release (only
 * the release PR rebuilds it), so the clone runs the bundle just built, put
 * where the committed one sits: this checks the code under test along the
 * path a clone takes. check:dist is what proves the release's own bundle.
 */
async function fromClone(installedVersion) {
  const clone = join(work, 'clone');
  const cloned = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', '--', process.cwd(), clone], { encoding: 'utf8' });
  if (cloned.status !== 0) throw new Error(`git clone of this checkout failed: ${cloned.stderr || cloned.error?.message}`);
  const bundle = join(clone, 'dist', 'toil.js');
  if (!existsSync(bundle)) throw new Error('the clone has no committed dist/toil.js, so a clone could not run toil.');
  // The bin and the bundle it runs, both committed (only the release PR writes them there).
  for (const file of ['toil.js', 'toil-lib.js']) copyFileSync(join(process.cwd(), 'dist', file), join(clone, 'dist', file));
  if (existsSync(join(clone, 'node_modules'))) throw new Error('the clone has a node_modules folder, so it would not prove a run with no npm install.');

  const run = (args, options = {}) => spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', input: '', timeout: 15000, cwd: clone, env, ...options });
  const version = JSON.parse(run(['version']).stdout || '{}');
  if (!version.ok || version.data?.version !== installedVersion) fail(`node <clone>/dist/toil.js version returned ${JSON.stringify(version)}, not version ${installedVersion}`);
  const { reply } = await mcpVersion(bundle);
  if (reply?.structuredContent?.ok !== true) fail(`MCP from the clone returned ${JSON.stringify(reply)}`);

  // `setup alias` into a throwaway profile, then each shell this machine has
  // reads that profile and runs `toil version` through the alias. Running the
  // shell is the point here, so it's spawned as the program, with the profile
  // path as an argument rather than spliced into a command string where the
  // shell allows it.
  const shells = [];
  const shellRuns = [];
  const bash = onPath('bash');
  const zsh = onPath('zsh');
  if (bash) {
    shellRuns.push({ shell: 'bash', profile: join(work, 'bashrc'), run: (p) => spawnSync(bash, ['--noprofile', '--norc', '-c', '. "$1" && toil version', 'smoke', p], { encoding: 'utf8', timeout: 15000, env }) });
  }
  if (process.platform === 'darwin' && zsh) {
    shellRuns.push({ shell: 'zsh', profile: join(work, 'zshrc'), run: (p) => spawnSync(zsh, ['-f', '-c', '. "$1" && toil version', 'smoke', p], { encoding: 'utf8', timeout: 15000, env }) });
  }
  if (process.platform === 'win32') {
    // Invoke-Expression reads the profile's text, so the machine's execution
    // policy, which governs script files, is neither needed nor changed.
    shellRuns.push({
      shell: 'powershell',
      profile: join(work, 'Microsoft.PowerShell_profile.ps1'),
      run: (p) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Invoke-Expression (Get-Content -Raw -LiteralPath '${p.replace(/'/g, "''")}'); toil version`], { encoding: 'utf8', timeout: 30000, env }),
    });
  }
  for (const s of shellRuns) {
    const added = JSON.parse(run(['setup', 'alias', '--shell', s.shell, '--profile', s.profile]).stdout || '{}');
    if (added.data?.change !== 'added') {
      fail(`setup alias --shell ${s.shell} returned ${JSON.stringify(added)}`);
      continue;
    }
    const through = s.run(s.profile);
    let answered;
    try {
      answered = JSON.parse(through.stdout.trim().split(/\r?\n/).pop() || '{}');
    } catch {
      answered = undefined;
    }
    if (answered?.ok !== true) fail(`${s.shell} running toil version through the alias printed ${through.stdout || through.stderr || through.error?.message}`);
    const removed = JSON.parse(run(['setup', 'remove-alias', '--shell', s.shell, '--profile', s.profile]).stdout || '{}');
    if (removed.data?.removed !== true || readFileSync(s.profile, 'utf8') !== '') fail(`setup remove-alias --shell ${s.shell} returned ${JSON.stringify(removed)}`);
    shells.push(s.shell);
  }
  if (!shells.length) fail('no shell was found to run the alias in');
  return `a clone ran dist/toil.js with no npm install (CLI and MCP), and ${shells.join(', ')} ran toil through setup alias`;
}

/**
 * The absolute path of `name` on PATH, found without running a shell to ask.
 * On Windows, System32's bash.exe is the WSL launcher, not a bash that can read
 * a Windows path, so it's skipped.
 */
function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || (process.platform === 'win32' && /[\\/]system32[\\/]?$/i.test(dir))) continue;
    for (const ext of exts) if (existsSync(join(dir, name + ext))) return join(dir, name + ext);
  }
  return undefined;
}

/**
 * Initialize an MCP session over stdio, call the version tool, then send SIGINT
 * and check the server exits, as a user pressing Ctrl+C once expects. (Windows
 * has no real signals, so there it ends the process regardless.)
 */
function mcpVersion(bin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'], env });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP server did not answer within 15s'));
    }, 15000);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n').slice(0, -1)) {
        const message = JSON.parse(line);
        if (message.id === 2) {
          clearTimeout(timer);
          const stop = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ reply: message.result, stoppedOnSigint: false });
          }, 3000);
          child.once('exit', () => {
            clearTimeout(stop);
            resolve({ reply: message.result, stoppedOnSigint: true });
          });
          child.kill('SIGINT');
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'version', arguments: {} } });
  });
}

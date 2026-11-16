// The demo's Postgres "read replica" (docs: .claude/skills/sandboxes/demo-reset.md),
// loaded from demo-db.sql and served on 127.0.0.1:55432 for toil's `payments-db`
// connection. Nothing beyond npm and Node is needed:
//
//   node ui/scripts/demo-db.mjs            # PGlite: real Postgres in WebAssembly, in this process
//   node ui/scripts/demo-db.mjs --docker   # or the postgres:17 image, if you have Docker
//   node ui/scripts/demo-db.mjs --stop     # remove the Docker container
//
// The default runs PGlite (@electric-sql/pglite, a dev dependency of Toil UI) and
// serves it with @electric-sql/pglite-socket until Ctrl+C, so leave it running in a
// terminal of its own while you record. The data is rebuilt in memory on every
// start. With --docker the container listens on loopback only with trust
// authentication and keeps running after this exits. Either way there is no
// password anywhere, and toil connects the same way: host, port, database and user.
// The SQL goes to Postgres as text, never through a shell. Repo tooling only:
// nothing here ships. The replica lag is zero, because there is no primary.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 55432;
const HOST = '127.0.0.1';
const NAME = 'toil-demo-pg';
const IMAGE = 'postgres:17';
const args = process.argv.slice(2);
const say = (line) => process.stdout.write(`${line}\n`);
function fail(message, fix) {
  process.stderr.write(`demo-db: ${message}\n  Fix: ${fix}\n`);
  process.exit(1);
}
const unknown = args.filter((a) => !['--docker', '--stop'].includes(a));
if (unknown.length) fail(`Unknown argument: ${unknown.join(' ')}`, 'Use --docker or --stop, or neither for PGlite.');
const sql = readFileSync(join(import.meta.dirname, 'demo-db.sql'), 'utf8');
const COUNTS = "select string_agg(t || ' ' || n, ', ') as counts from (select 'payments' t, count(*) n from payments.payments union all select 'refunds', count(*) from payments.refunds union all select 'disputes', count(*) from payments.disputes union all select 'payouts', count(*) from payments.payouts union all select 'job_runs', count(*) from payments.job_runs) x";

if (args.includes('--docker') || args.includes('--stop')) docker();
else await pglite();

async function pglite() {
  let PGlite, PGLiteSocketServer;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
    ({ PGLiteSocketServer } = await import('@electric-sql/pglite-socket'));
  } catch {
    fail("PGlite isn't installed.", 'Run npm install in the repository root (it is a dev dependency of Toil UI), or use --docker.');
  }
  const db = await PGlite.create();
  await db.exec(sql);
  say(`payments schema loaded: ${(await db.query(COUNTS)).rows[0].counts}`);
  const server = new PGLiteSocketServer({ db, host: HOST, port: PORT });
  try {
    await server.start();
  } catch (error) {
    fail(`couldn't listen on ${HOST}:${PORT}: ${error.message}`, `Stop whatever holds the port (a running demo-db, or node ui/scripts/demo-db.mjs --stop for the Docker one).`);
  }
  say(`serving the replica on ${HOST}:${PORT} with PGlite; Ctrl+C to stop`);
  const stop = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function docker() {
  const run = (argv, input) => {
    const res = spawnSync('docker', argv, { input, encoding: 'utf8' });
    if (res.error) fail(`couldn't run docker: ${res.error.message}`, 'Leave out --docker to use PGlite, which needs nothing but npm.');
    return res;
  };
  if (run(['info']).status !== 0) fail('Docker is not running.', 'Start Docker, or leave out --docker to use PGlite.');
  if (args.includes('--stop')) {
    run(['rm', '-f', NAME]);
    say(`${NAME}: removed`);
    return;
  }
  const running = run(['ps', '--filter', `name=^${NAME}$`, '--format', '{{.Names}}']).stdout.trim() === NAME;
  if (!running) {
    run(['rm', '-f', NAME]);
    const started = run(['run', '-d', '--name', NAME, '-p', `${HOST}:${PORT}:5432`, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=payments', IMAGE]);
    if (started.status !== 0) fail(`docker run failed: ${started.stderr.trim()}`, `Check that port ${PORT} is free.`);
    say(`${NAME}: started (${IMAGE}, ${HOST}:${PORT})`);
  }
  // Ask over TCP: the image's temporary init server answers on the unix socket only,
  // so a socket check can pass while that server is about to shut down.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = run(['exec', NAME, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'payments']).status === 0;
    if (!ready) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1000)']);
  }
  if (!ready) fail(`${NAME} didn't accept connections within a minute.`, `Look at docker logs ${NAME}, or run this again with --stop first.`);
  const load = run(['exec', '-i', NAME, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres', '-d', 'payments'], sql);
  if (load.status !== 0) fail(`loading demo-db.sql failed: ${load.stderr.trim()}`, 'Fix the SQL and run this again.');
  const counts = run(['exec', NAME, 'psql', '-At', '-U', 'postgres', '-d', 'payments', '-c', COUNTS]);
  say(`payments schema loaded: ${counts.stdout.trim()}`);
}

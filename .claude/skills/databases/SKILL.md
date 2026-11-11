---
name: databases
description: Rules for toil's `db` area and its database providers (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, Oracle, Teradata, Hive, Impala). Use when adding or changing a database provider or driver under src/core/db/, changing how queries run (read-only transactions, rollback, row caps, timeouts, paging, cancellation), handling database connection strings, or writing database tests including `npm run test:integration` service containers.
---

# Databases

- **Read-only by default**, per **Writes** in CLAUDE.md: `writes: true` on the
  connection and `--allow-write` on the call.
- Statements run in a read-only transaction or session where the engine supports it,
  then rolled back. Do not rely on parsing SQL to decide whether it writes.
- Every query has a row cap (default 100) and a timeout, returns a cursor for paging,
  and can be cancelled.
- Connection strings resolve like any other secret: env var, then keychain reference,
  then config. Never log a connection string; log the connection name.
- Drivers are pure JS: `pg` (PostgreSQL), `mysql2` (MySQL/MariaDB), `tedious` (SQL
  Server), `node:sqlite` (built into Node), `oracledb` in Thin mode only (Oracle), and
  `thrift` with the HiveServer2 client generated in `hive-driver` (Hive and Impala, one
  provider, `src/core/db/hive/`; only the generated client is used, and its Kerberos
  path, which needs a native module, never).
  SQL Server has no read-only transaction, so its queries always roll back, and its
  docs tell users to connect with a read-only login. Teradata has no driver toil can
  ship (the official one loads a native library), so it goes over HTTP to the Teradata
  Query Service, through `call.fetch`: core's fetch, so proxy, OS certificates,
  `--verbose` and the audit log hold as for any HTTP area. It has no read-only mode
  either, so it rolls back like SQL Server, and its docs require a read-only user.
  Hive and Impala have no read-only mode and nothing to roll back, so toil can't
  enforce read-only there at all: `db query` relies on the account, toil doesn't parse
  SQL to decide, and their docs **require** a read-only account (the maintainer's
  decision on #408), a refusal by that account is `WRITE_DISABLED`, a read the server
  reports as having changed rows is `DATABASE` saying so, and `db execute` runs one
  statement per call, since there's no transaction to make several all or nothing.
- **TLS trusts what HTTP trusts.** Core loads the OS certificate store on the first
  HTTP request, and a driver's own socket never makes one. A provider with TLS
  passes `trustedCertificates(call.debug).certificates` from `src/core/network.ts`
  (Node's defaults, `NODE_EXTRA_CA_CERTS`, then the OS store) as the driver's `ca`,
  and keeps the driver's defaults when it's undefined (the store couldn't be read).
- Providers live in `src/core/db/<engine>/`. Adding one follows this skill, and each
  provider records a verification level (see the `integrations` skill).

## The framework

The `db` area (`src/areas/db/`) has one set of commands for every engine:
`schema list`, `table list`, `table describe`, `table preview`, `query` (read-only,
one statement, paged) and `execute` (the only write, `writes: true`). A connection
names its `engine`; commands look up that engine's provider and never know which
one they got.

- **`DbProvider`** (`src/core/db/provider.ts`) is the whole contract: list schemas,
  list tables, describe, preview a window of rows, query a window of rows read-only,
  execute in one transaction. Providers return plain data; they never see cursors,
  and never return driver objects or connection strings.
- **Paging is not a provider's job.** `src/core/db/paging.ts` asks for
  `limit + 1` rows from an offset, trims the extra row into `meta.page.nextCursor`,
  and makes values JSON-safe (big integers to strings, binary to base64). Cursors
  carry a fingerprint of the SQL or table and are refused against any other.
- **Read-only is the engine's job.** `query` must run where the engine itself
  refuses writes, and a refused write maps to `WRITE_DISABLED` from the engine's
  error code, never from reading the SQL (Hive and Impala have no such mode; above). The one exception is a narrow deny for a
  statement that gets around the engine's own read-only mode: SQLite's `VACUUM INTO`
  creates its target file before the read-only refusal, so SQLite reads refuse any
  statement whose first keyword is `VACUUM` (`INVALID_INPUT`, pointing at
  `db execute`), and PostgreSQL reads refuse `COPY` and `DO`: `COPY ... TO '<file>'` and `TO PROGRAM`
  write a server file or run a program inside a read-only transaction, and a `DO` block can run that `COPY`. MySQL reads refuse `SELECT ... INTO OUTFILE` / `INTO DUMPFILE` (a server file) and any `SET` (`SET GLOBAL` and `SET PERSIST` change the server), checked with and without backslash escapes so `NO_BACKSLASH_ESCAPES` can't hide one. SQL Server has no read-only transaction at all: reads always roll back, a statement the server's DONE token reports as a write is `WRITE_DISABLED`, and reads refuse `COMMIT`, `ROLLBACK`, `BEGIN TRANSACTION` and `SAVE TRANSACTION`, which would end that transaction, and `OUTPUT`, whose rows arrive before the server reports the write (`src/core/db/sqlserver/script.ts`).
  Oracle reads refuse DDL (`WRITE_DISABLED`), because Oracle commits DDL inside a
  read-only transaction, and PL/SQL (`BEGIN`, `DECLARE`, `CALL`, `WITH FUNCTION`;
  `INVALID_INPUT`), because a block can commit, run DDL or an autonomous transaction;
  `test/db/oracle.test.ts` proves each keyword writes through `SET TRANSACTION READ ONLY`. Each denies one statement by name; it does not decide whether SQL
  writes, and everything else still relies on the engine. Add another such deny only
  for a statement proven to escape the engine's read-only mode, with a test showing
  the escape. A hole that can't be closed (SQLite's read-only `ATTACH` of other
  files, PostgreSQL's server-side functions such as `lo_export` for a privileged role, a MySQL procedure that commits and turns read-write itself, SQL Server's `COMMIT` inside dynamic SQL, which toil detects from the transaction ending and reports, and which a read-only login is what stops),
  an Oracle stored function with an autonomous transaction called from a `SELECT`) is
  pinned with a test and documented as a known limit.
  Teradata has no read-only transaction, and its Query Service no read-only session:
  each call opens an explicit session with `transaction_mode: ANSI` and `auto_commit:
  false`, a read ends with `ROLLBACK` and the session closed, a result the service
  reports as an update count is `WRITE_DISABLED`, and reads refuse `COMMIT`,
  `ROLLBACK`, `ABORT`, `BT`, `ET` and `BEGIN`/`END TRANSACTION` anywhere in the SQL
  (`src/core/db/teradata/split.ts`). toil can't enforce read-only there, and the docs
  say so: `db query` relies on a read-only user.
- **The pre-flight lint** (`src/core/db/lint/`, #303) reads caller SQL for the
  connection's engine before the provider is asked anything: `db query` and `db
  execute` call it first in `run`, and `db lint` runs it alone (with `--engine`, a
  `connectionlessWhen` command, so no connection resolves). It has its own small
  tokenizer, a table of each engine's quoting rules, and leaves the statement
  splitters beside the providers alone: they decide what a read refuses and must
  match the engine's lexer exactly, while the lint only advises. Errors throw before
  a connection opens (`read-only-write` as `WRITE_DISABLED`, the rest
  `INVALID_INPUT`) and `--no-lint` never skips one; warnings go to `meta.warnings`
  as `LINT`, and `meta.lint` lists the rules that ran. An error rule must stay quiet
  when unsure, since a false one blocks good SQL with no way round it. Its
  `read-only-write` rule is not what keeps reads read-only: the engine is, as above.
  A new rule gets a bad and a good fixture for every engine it runs on in
  `src/core/db/lint/lint.test.ts`, which fails until it has them, and a row in the
  rule table in `skills/toil/db.md`.
- **`execute` is all or nothing.** A script that starts or ends its own transaction
  is refused before any of it runs, so a mid-script `COMMIT` can't leave half a
  change applied.
- **Adding an engine:** write `src/core/db/<engine>/` implementing `DbProvider`,
  add it to `providers` in `src/core/db/engines.ts`, add its connection keys
  (optional in the zod schema in `src/areas/db/index.ts`, listed in the provider's
  `requires`, and secrets in the area's `secrets`; an engine that takes a `token`, or takes no `password`, gets its entry in the area's `appliesTo`, so Toil UI says "not needed" rather than "missing"), add a target to
  `test/db/targets.ts`, and add its section to `skills/toil/db.md` and its tile to
  the site's Databases group. An engine reached over HTTP sends through `call.fetch`
  and core's `restResponse`, never a fetch of its own, and sends what must go out
  after an abort (a server-side cancel, closing a session) through
  `call.cleanupFetch`, each request with a timeout of its own.
- **Cancellation:** a provider passes `call.signal` to its driver. Hive and Impala send
  CancelOperation on a second connection as well as the call's own
  (`src/core/db/hive/index.ts`), because HiveServer2 answers one request per connection
  at a time and the call's own may be held by a fetch. SQLite's driver is
  synchronous and has no interrupt, so `src/core/db/sqlite/worker.ts` runs each job
  on a worker thread and terminates it on abort; that stops the statement at its
  next row. A statement that computes for a long time before producing a row keeps
  the thread busy until it finishes. Server engines should cancel on the server
  (`pg_cancel_backend`, a TDS attention, `KILL`), not just stop reading.
  PostgreSQL opens one connection per call and, on abort, sends
  `pg_cancel_backend(<pid>)` from a second short-lived one
  (`src/core/db/postgres/index.ts`); the abandoned call's own error is dropped,
  because core has already answered `TIMEOUT` or `CANCELLED`. MySQL sends
  `KILL <id>` (`src/core/db/mysql/index.ts`), ending the whole connection: a
  script goes one statement per round trip, so a `KILL QUERY` landing between two
  statements would stop nothing and the rest would commit. It also checks the
  signal before each statement and before `COMMIT`. MySQL sets the session as
  well as the transaction read-only, because DDL commits implicitly and would
  otherwise run in autocommit.
  SQL Server sends a TDS
  attention on the same connection (tedious's `cancel()`), and also once a page is
  full, so the server stops producing rows nobody reads.
  Teradata asks the Query Service for the session's running queries and `DELETE`s
  each, then closes the session, on `call.cleanupFetch`, since the command's own
  fetch is bound to the signal that just fired (`src/core/db/teradata/index.ts`).
  Oracle sends
  `connection.break()` on the call's own connection (`src/core/db/oracle/index.ts`).
  Thin mode's break is in band, so the server hears it at its next check: a working
  statement stops at once, but `DBMS_SESSION.SLEEP` only when it wakes. Oracle's
  conformance target therefore uses a long cartesian count as its slow statement.
- **SQL Server's Windows authentication** (`auth: "windows"`) gets its SSPI tokens
  from `src/os/windows-sspi.ts`, a Windows PowerShell helper (CLAUDE.md, No
  Executables), and `src/core/db/sqlserver/windows-login.ts` wraps two of tedious's
  private login methods so its NTLM path carries them, and its token parser so a
  short Negotiate token reaches the helper unparsed; a test fails if a tedious
  upgrade renames any of them. Its tests that need Windows say "windows only" in their
  names. The live handshake against a domain is `untested`.

## Testing

- Database tests use `node:sqlite` in-process against a temp file per test
  (`test/harness/db.ts`). Tests against real PostgreSQL, MySQL and SQL Server run as
  CI service containers under `npm run test:integration`, which offline developers
  can skip.
- **Teradata has no container to run** (Vantage Express is a virtual machine), so it
  has no conformance target yet: `test/db/teradata.test.ts` drives every command
  against a stubbed Query Service, with responses invented from Teradata's OpenAPI
  specification and labelled so, and the provider is `unit`. A target needs a live
  Query Service; the gaps it must handle are in `docs/decisions/409-teradata.md`.
- **Every provider passes the conformance suite**, `test/db/conformance.test.ts`:
  connections, schemas, describe, preview, query with row cap, paging and cancel,
  and read-only enforcement, all through `execute()`. It runs once per entry in
  `test/db/targets.ts`; a server engine's target seeds `SEED_SQL` into a fresh
  database and returns `skip` when its container isn't reachable. Engine-only
  behaviour (value conversion, file handling) goes in `test/db/<engine>.test.ts`.
- **A server engine's target** (PostgreSQL's is the one to copy) reads one URL
  from `TOIL_TEST_<ENGINE>_URL` (`TOIL_TEST_PG_URL`), defaulting to the CI service
  container's. `skip` probes it: unset and unreachable skips, so offline
  `npm test` stays green; set and unreachable throws, so a run someone asked for
  can't pass by skipping. `setup` creates a fresh database per test and seeds
  `SEED_SQL`; `cleanup` drops it. The target also returns `running()`, the count of
  toil's statements still executing on the server against that database, and the
  conformance suite polls it to 0 after a cancel and a time limit. That is how a
  server-side cancel is tested: the slow statement sleeps on the server without
  producing a row (`pg_sleep`, `SLEEP`, `WAITFOR DELAY`; on Oracle a cartesian count,
  since Thin mode's in-band break can't wake `DBMS_SESSION.SLEEP`), so
  only a real cancel stops it. Break the cancel on purpose once and watch both
  tests fail.
- **Engines that lack something** the suite checks (indexes, transactions, keys they
  enforce, a read-only mode) say so in their target's `lacks`, each with the reason; the
  suite then checks what the engine does instead, or skips the test with the reason in
  its name. An engine with no read-only mode gives its target a `reader`, the same
  database through a read-only account, for the engine side of the read-only checks.
  Hive and Impala are the ones that need it.
- **Engines that fold names.** A target can set `stored` (how an unquoted name is
  stored: Oracle upper-cases it), a per-database `defaultSchema` (Oracle's is the
  test user, one per test), and `sql.transactionControl` (the engine's own
  transaction statements); the suite reads expected names through them.
- **`npm run test:integration`** is `vitest run test/db/`. CI's `integration` job
  (`.github/workflows/ci.yml`) runs it on Linux with each server engine as a
  service container from its official image at a pinned tag, and sets each URL
  variable. A new engine adds its service and its variable to that job.
- The parity suite runs the `db` examples against a seeded SQLite file made by
  `test/fixtures/db.fixture.ts` (removed by its `cleanup`). The examples name the
  seed's tables (`people`, `teams`), so keep them in step with `SEED_SQL`. Parity
  sees no HTTP from the db area, so its "same requests" check is vacuous there; the
  conformance suite is what proves read-only. `db query`'s pre-flight lint refuses an
  obvious write first, so a test proving the engine or a provider's deny asks the
  provider directly too, with `engineQuery` (`test/harness/db.ts`).
- **Before opening a PR that touches a database provider, run it against the real
  engine locally in Docker.** Pull the same official image CI uses (`postgres`,
  `mysql`/`mariadb`, `mcr.microsoft.com/mssql/server` at a dated cumulative-update tag such as `2022-CU27-ubuntu-22.04`, never `2022-latest`, `gvenzl/oracle-free`), seed
  it, and drive the actual `toil db` commands through both the CLI and MCP. Remove
  the containers afterwards. The PR names the image and tag and shows the output.
  Docker is a development tool here, never a runtime dependency: No Executables
  governs what toil ships, not how it's tested. The steps, with PostgreSQL:

  ```bash
  name=toil-test-postgres-$RANDOM   # unique, so parallel runs never collide
  docker run -d --name $name -e POSTGRES_PASSWORD=postgres -p 55437:5432 \
    --health-cmd "pg_isready -U postgres" --health-interval 2s postgres:17
  until [ "$(docker inspect -f '{{.State.Health.Status}}' $name)" = healthy ]; do sleep 1; done
  TOIL_TEST_PG_URL=postgres://postgres:postgres@localhost:55437/postgres npm run test:integration
  # ...then seed a database and drive node dist/toil.js db ... and toil mcp against it
  docker rm -f $name; docker ps -a --filter name=toil-test-postgres   # must list nothing
  ```

  MySQL and MariaDB share the `mysql` engine, and each has its own target and URL
  (`TOIL_TEST_MYSQL_URL`, `TOIL_TEST_MARIADB_URL`), so run both:

  ```bash
  r=$RANDOM
  docker run -d --name toil-test-mysql-$r -e MYSQL_ROOT_PASSWORD=mysql -p 53316:3306 \
    --health-cmd "mysqladmin ping -h 127.0.0.1 -pmysql --silent" --health-interval 2s mysql:8.4
  docker run -d --name toil-test-mariadb-$r -e MARIADB_ROOT_PASSWORD=mysql -p 53317:3306 \
    --health-cmd "healthcheck.sh --connect --innodb_initialized" --health-interval 2s mariadb:11.8
  # wait for both to be healthy, as above
  TOIL_TEST_MYSQL_URL=mysql://root:mysql@localhost:53316/ TOIL_TEST_MARIADB_URL=mysql://root:mysql@localhost:53317/ npm run test:integration
  docker rm -f toil-test-mysql-$r toil-test-mariadb-$r; docker ps -a --filter name=toil-test-m   # must list nothing
  ```

  Hive runs as a CI service container with SQL standard authorization, so its target
  has a read-only account (`toil_reader`) as well as the one that owns the tables;
  `?webui=` names HiveServer2's web UI port, where `running()` reads the active queries
  (Jetty answers only on the port it listens on, so map it to the same number):

  ```bash
  name=toil-test-hive-$RANDOM
  sqlstd=org.apache.hadoop.hive.ql.security.authorization.plugin.sqlstd.SQLStdHiveAuthorizerFactory
  docker run -d --name $name -e SERVICE_NAME=hiveserver2 \
    -e SERVICE_OPTS="-Dhive.server2.webui.port=51002 -Dhive.security.authorization.enabled=true -Dhive.security.authorization.manager=$sqlstd -Dhive.security.authenticator.manager=org.apache.hadoop.hive.ql.security.SessionStateUserAuthenticator -Dhive.users.in.admin.role=hive" \
    -p 51000:10000 -p 51002:51002 apache/hive:4.2.1
  # about 30 s to accept connections
  TOIL_TEST_HIVE_URL='hive://hive:hive@localhost:51000/?webui=51002' npm run test:integration
  docker rm -f $name
  ```

  Impala needs four containers (a metastore, statestored, catalogd and an impalad), so
  it isn't in CI. `test/db/impala/compose.yml` runs them from the official
  `apache/impala:4.5.3` images; its target is local only and skips when unset:

  ```bash
  docker compose -f test/db/impala/compose.yml up -d
  # about a minute until the impalad answers on 51050
  TOIL_TEST_IMPALA_URL='impala://impala@localhost:51050/?webui=55000' npm run test:integration
  docker compose -f test/db/impala/compose.yml down -v
  ```

  Use a host port other than the engine's default, and remove the container even
  when something failed.
  SQLite has no server to run: `node:sqlite` is the real engine, so its in-process
  tests plus the built CLI and MCP driven against a real file stand in for this step.

import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { defineArea } from '../../core/area.js';
import type { CommandContext } from '../../core/context.js';
import { engineNames, providerFor, providers } from '../../core/db/engines.js';
import { lintError, lintSql, lintWarning, type Dialect, type LintPurpose } from '../../core/db/lint/index.js';
import { DEFAULT_LIMIT, decodeCursor, encodeCursor, MAX_LIMIT, pageKey, toPage, windowFor } from '../../core/db/paging.js';
import type { DbCall, DbConnection, DbProvider } from '../../core/db/provider.js';
import { tlsIssues } from '../../core/db/tls.js';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';
import type { SupportedVersion } from '../../core/supported.js';

/**
 * The `db` area: one set of commands for every database engine. Each
 * connection names its `engine`, and the command hands the call to that
 * engine's provider in src/core/db/. Almost nothing here knows SQLite from Oracle,
 * which is the point; the commands were written once and the engines queue
 * up behind them like forms behind a single stamp. The one footnote is the
 * `appliesTo` line below: SQLite never queued for a password, so Toil UI
 * must not ask for one.
 *
 * Reads run read-only at the engine, or, where the engine has no read-only
 * mode (SQL Server, Teradata), in a transaction that is always rolled back. The one command that writes, `execute`,
 * goes through core's two-step gate: `writes: true` on the connection and
 * `--allow-write` on the call.
 */
export const area = defineArea({
  name: 'db',
  description: 'Databases: list schemas and tables, describe a table, preview rows, run read-only queries, and gated writes',
  connection: z.object({
    engine: z.enum(engineNames).describe(`Database engine: ${engineNames.join(', ')}`),
    // A relative path would resolve against wherever the process started,
    // which for an MCP server is wherever its client happened to be.
    path: z.string().min(1).refine(isAbsolute, 'path must be absolute.').optional().describe('SQLite: absolute path to the database file'),
    host: z.string().min(1).optional().describe('PostgreSQL, MySQL, SQL Server, Oracle, Hive, Impala: server host name or address'),
    port: z.number().int().min(1).max(65535).optional().describe('PostgreSQL, MySQL, SQL Server, Oracle, Hive, Impala: TCP port (default 5432 for PostgreSQL, 3306 for MySQL, 1433 for SQL Server, 1521 for Oracle, 10000 for Hive, 21050 for Impala)'),
    database: z.string().min(1).optional().describe('PostgreSQL, MySQL, SQL Server: database to connect to (for MySQL, also the default schema). Oracle: the service name (FREEPDB1, ORCLPDB1). Teradata: the default database. Hive, Impala: optional, the database to start in and the default schema (default: default)'),
    user: z.string().min(1).optional().describe('PostgreSQL, MySQL, SQL Server, Oracle, Teradata, Hive, Impala: login role, account or user (for SQL Server, a SQL Server login, or with auth windows another domain account; for Hive and Impala, a read-only account)'),
    password: z.string().optional().describe("PostgreSQL, MySQL, SQL Server, Oracle, Teradata, Hive, Impala: the login's password (a secret: env var or OS credential store)"),
    ssl: z.boolean().optional().describe("PostgreSQL, MySQL, SQL Server, Oracle, Hive, Impala: connect over TLS (Oracle: TCPS), verifying the server's certificate against the OS store"),
    tlsServerName: z.string().min(1).optional().describe("PostgreSQL, MySQL, SQL Server, Hive, Impala, with ssl: the host name the server's certificate is verified against (and sent as SNI) instead of host, for a server reached through an alias, VPN name or tunnel. The connection still goes to host, and verification stays fully on"),
    tlsCaFile: z.string().min(1).optional().describe("PostgreSQL, MySQL, SQL Server, Hive, Impala, with ssl: absolute path to a PEM file of CA certificates (for example Amazon's RDS global-bundle.pem) trusted in addition to Node's, NODE_EXTRA_CA_CERTS and the OS store, for this connection only"),
    auth: z.enum(['sql', 'windows', 'nosasl']).optional().describe('SQL Server: sql (a SQL Server login, the default) or windows (Windows authentication, Windows only). Hive, Impala: nosasl for a server with no authentication; unset signs in with user and password (SASL PLAIN, for LDAP)'),
    domain: z.string().min(1).optional().describe("SQL Server with auth windows: the domain of the account in user, to sign in as someone other than the current Windows user"),
    baseUrl: z.url().optional().describe('Teradata: the Query Service base URL, e.g. https://teradata.imagile.dev:1443 (with any path in front of /systems, such as /api/query)'),
    system: z.string().min(1).optional().describe("Teradata: the system's alias in the Query Service, as its administrator named it"),
    token: z.string().optional().describe('Teradata: a bearer token for the Query Service, in place of user and password (a secret: env var or OS credential store)'),
    logMech: z.enum(['TD2', 'LDAP', 'JWT']).optional().describe("Teradata: the session's logon mechanism (TD2, LDAP or JWT). Default: the system's own default"),
  })
    // Rules only one engine has, such as SQL Server's sign-in, come from that engine's provider.
    .superRefine((conn, check) => {
      const provider = providers.find((p) => p.engine === conn.engine);
      for (const issue of [...tlsIssues(conn, provider, providers), ...(provider?.check?.(conn) ?? [])]) check.addIssue({ code: 'custom', path: [issue.key], message: issue.message });
    }),
  secrets: { password: 'password', token: 'token' },
  // SQLite signs in with a file path, so it has no password to be missing; Toil UI reads this to say "not needed" rather than "missing".
  appliesTo: { password: providers.filter((p) => p.engine !== 'sqlite').map((p) => p.engine), token: ['teradata'] },
  // Each engine names the keys its connections need; core checks them.
  variants: { by: 'engine', of: Object.fromEntries(providers.map((p) => [p.engine, { label: p.label, requires: [...p.requires] }])) },
});

type DbContext = CommandContext<DbConnection>;

function using(ctx: DbContext): { provider: DbProvider; conn: DbConnection; call: DbCall } {
  return {
    provider: providerFor(ctx.connection.engine),
    conn: ctx.connection,
    call: { signal: ctx.signal, debug: ctx.debug, protect: ctx.ownFiles ?? [], fetch: ctx.fetch, cleanupFetch: ctx.cleanupFetch },
  };
}

/**
 * The pre-flight lint (src/core/db/lint/), run before the provider is asked
 * anything, so a refused statement never opens a connection. Errors throw;
 * warnings go to meta.warnings unless the call passed --no-lint, which skips
 * the warning rules and never an error.
 */
function preflight(ctx: DbContext, sql: string, purpose: LintPurpose, warnings: boolean): void {
  const result = lintSql(sql, ctx.connection.engine as Dialect, { purpose, warnings });
  ctx.setLint({ engine: result.engine, rules: result.rules });
  const refused = lintError(result, `db ${purpose}`);
  if (refused) throw refused;
  for (const f of result.findings) ctx.warn(lintWarning(f));
}

const lintField = z.boolean().default(true).describe("Run the pre-flight lint's warning rules (default: true). False skips the warnings only; its errors always run.");
const lintOption = { flags: '--no-lint', field: 'lint', description: "Skip the pre-flight lint's warnings (its errors always run)" };

const schemaField = z.string().min(1).optional().describe("Schema to read. Defaults to the engine's default schema (SQLite: main, PostgreSQL: public, MySQL: the connection's database, SQL Server: dbo, Oracle: the user's own schema, Teradata: the connection's database, else the user's own, Hive and Impala: the connection's database, else default).");
const schemaOption = { flags: '--schema <name>', field: 'schema', description: "Schema (default: the engine's default, main for SQLite, public for PostgreSQL, the connection's database for MySQL, dbo for SQL Server, the user's own for Oracle, the connection's database or else the user's own for Teradata, the connection's database or default for Hive and Impala)" };
const limitField = z.coerce.number().int().min(1).max(MAX_LIMIT).optional().describe(`Rows per page, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`);
const cursorField = z.string().min(1).optional().describe('meta.page.nextCursor from the previous page, to fetch the next one');
const pageOptions = [
  { flags: '--limit <rows>', field: 'limit', description: `Rows per page, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT})` },
  { flags: '--cursor <cursor>', field: 'cursor', description: 'meta.page.nextCursor from the previous page' },
];

const EXAMPLE_SQL = 'SELECT id, name FROM people ORDER BY id';

export const listSchemas = area.command({
  path: ['db', 'schema', 'list'],
  description: 'List the schemas in a database',
  toolDescription:
    'List the schemas (SQLite: attached databases) on a db connection. Returns { schemas: [{ name }] }. Use db_table_list next to see what one holds.',
  input: z.object({}),
  writes: false,
  examples: [{}],
  run: async (_input, ctx) => {
    const { provider, conn, call } = using(ctx);
    return { schemas: await provider.listSchemas(conn, call) };
  },
});

export const listTables = area.command({
  path: ['db', 'table', 'list'],
  description: 'List the tables and views in a schema',
  toolDescription:
    'List the tables and views in one schema of a db connection. Returns { schema, tables: [{ name, type }] }. Use db_table_describe for one table\'s columns and keys, db_schema_list for the schemas.',
  input: z.object({ schema: schemaField }),
  writes: false,
  options: [schemaOption],
  examples: [{}, { schema: 'main' }],
  run: async (input, ctx) => {
    const { provider, conn, call } = using(ctx);
    const schema = input.schema ?? provider.defaultSchema(conn);
    return { schema, tables: await provider.listTables(conn, schema, call) };
  },
});

export const describeTable = area.command({
  path: ['db', 'table', 'describe'],
  description: 'Describe a table or view: columns, primary key, indexes and foreign keys',
  toolDescription:
    'Describe one table or view: its columns (name, type, nullable, default, primaryKey position), primary key, indexes and foreign keys. Use before writing a query against it; use db_table_preview to see sample rows.',
  input: z.object({ table: z.string().min(1).describe('Table or view name'), schema: schemaField }),
  writes: false,
  args: [{ name: 'table', field: 'table', description: 'Table or view name' }],
  options: [schemaOption],
  examples: [{ table: 'people' }, { table: 'people', schema: 'main' }],
  run: async (input, ctx) => {
    const { provider, conn, call } = using(ctx);
    return provider.describeTable(conn, { schema: input.schema ?? provider.defaultSchema(conn), table: input.table }, call);
  },
});

export const previewTable = area.command({
  path: ['db', 'table', 'preview'],
  description: 'Preview the rows of a table or view, a page at a time',
  toolDescription: `Return rows from one table or view, read-only, ${DEFAULT_LIMIT} per page by default. Returns { columns: [{ name, type }], rows: [[...]] } with rows as arrays in column order; meta.page.nextCursor fetches the next page. Use db_query to filter, join or sort.`,
  input: z.object({ table: z.string().min(1).describe('Table or view name'), schema: schemaField, limit: limitField, cursor: cursorField }),
  writes: false,
  args: [{ name: 'table', field: 'table', description: 'Table or view name' }],
  options: [schemaOption, ...pageOptions],
  examples: [{ table: 'people' }, { table: 'people', schema: 'main', limit: 2, cursor: encodeCursor(2, pageKey('db table preview', 'main', 'people')) }],
  run: async (input, ctx) => {
    const { provider, conn, call } = using(ctx);
    const schema = input.schema ?? provider.defaultSchema(conn);
    const limit = input.limit ?? DEFAULT_LIMIT;
    // Keyed on what the caller typed, so the same call always pages the same way.
    const key = pageKey('db table preview', schema, input.table);
    const offset = decodeCursor(input.cursor, key);
    const { data, page } = toPage(await provider.previewTable(conn, { schema, table: input.table }, windowFor(offset, limit), call), offset, limit, key);
    ctx.setPage(page);
    return data;
  },
});

export const query = area.command({
  path: ['db', 'query'],
  description: 'Run one read-only SQL statement and return a page of its rows',
  toolDescription: `Run one SQL statement read-only: the engine itself refuses any write, which comes back as WRITE_DISABLED. Returns { columns: [{ name, type }], rows: [[...]] } with rows as arrays in column order, ${DEFAULT_LIMIT} per page by default; meta.page.nextCursor fetches the next page of the same SQL. The SQL is first checked against the engine's dialect (db_lint): an error refuses it before anything is sent, with the engine's own form in error.fix, and warnings come back in meta.warnings (lint: false skips the warnings only). To change data, use db_execute.`,
  input: z.object({ sql: z.string().min(1).describe('One SQL statement'), limit: limitField, cursor: cursorField, lint: lintField }),
  writes: false,
  // The audit log keeps which SQL ran, never the SQL: it may hold the data.
  auditInput: { sql: 'hash' },
  args: [{ name: 'sql', field: 'sql', description: 'One SQL statement, quoted' }],
  options: [...pageOptions, lintOption],
  examples: [{ sql: EXAMPLE_SQL }, { sql: EXAMPLE_SQL, limit: 2, cursor: encodeCursor(2, pageKey('db query', EXAMPLE_SQL)) }, { sql: 'SELECT * FROM people', lint: false }],
  run: async (input, ctx) => {
    preflight(ctx, input.sql, 'query', input.lint);
    const { provider, conn, call } = using(ctx);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const key = pageKey('db query', input.sql);
    const offset = decodeCursor(input.cursor, key);
    const { data, page } = toPage(await provider.query(conn, input.sql, windowFor(offset, limit), call), offset, limit, key);
    ctx.setPage(page);
    return data;
  },
});

export const execute = area.command({
  path: ['db', 'execute'],
  description: 'Run SQL that changes data, in one transaction (needs writes on and --allow-write)',
  toolDescription:
    "Run one or more SQL statements that change data (INSERT, UPDATE, DELETE, DDL), in one transaction that commits only if every statement succeeds; leave out BEGIN, COMMIT and ROLLBACK. Returns { changes }: rows inserted, updated or deleted. The SQL is first checked against the engine's dialect, as db_query's is. Only for a change the user asked for; to read, use db_query.",
  input: z.object({ sql: z.string().min(1).describe('SQL to run; several statements separated by semicolons run as one transaction'), lint: lintField, ...allowWriteField }),
  writes: true,
  auditInput: { sql: 'hash' },
  args: [{ name: 'sql', field: 'sql', description: 'SQL to run, quoted' }],
  options: [lintOption],
  examples: [
    { sql: "UPDATE people SET active = 1 WHERE name = 'Ada'", allowWrite: true },
    { sql: "UPDATE people SET active = 1 WHERE name = 'Ada'", lint: false, allowWrite: true },
  ],
  run: async (input, ctx) => {
    preflight(ctx, input.sql, 'execute', input.lint);
    const { provider, conn, call } = using(ctx);
    return provider.execute(conn, input.sql, call);
  },
});

export const lint = area.command({
  path: ['db', 'lint'],
  description: "Check SQL against an engine's dialect before running it; with --engine, no connection is used",
  toolDescription:
    "Check SQL against a database engine's dialect without running it: no connection is opened, and with engine set none is even looked up. Returns { engine, as, errors, warnings, findings: [{ rule, severity, message, fix, position: { offset, line, column } }] }; meta.lint lists the rules that ran. The same lint runs before db_query and db_execute, where an error refuses the SQL. Use it to check a statement for an engine you don't know well before sending it.",
  input: z.object({
    sql: z.string().min(1).describe('The SQL to check'),
    engine: z.enum(engineNames).optional().describe(`The engine whose dialect to check against: ${engineNames.join(', ')}. Defaults to the connection's engine; with it set, no connection is used.`),
    as: z.enum(['query', 'execute']).default('query').describe('Check it as db query would (one read-only statement with a row cap; the default) or as db execute would (a script of changes)'),
  }),
  writes: false,
  connectionOptional: true,
  connectionlessWhen: (input) => input.engine !== undefined,
  auditInput: { sql: 'hash' },
  args: [{ name: 'sql', field: 'sql', description: 'The SQL to check, quoted' }],
  options: [
    { flags: '--engine <engine>', field: 'engine', description: `Check against this engine's dialect (${engineNames.join(', ')}) instead of the connection's; no connection is used` },
    { flags: '--as <command>', field: 'as', description: 'Check it as query (the default) or execute would run it' },
  ],
  examples: [
    { sql: EXAMPLE_SQL },
    { sql: 'SELECT TOP 10 * FROM people', engine: 'postgres' },
    { sql: "UPDATE people SET active = 0 WHERE name = 'Ada'", engine: 'sqlserver', as: 'execute' },
  ],
  run: async (input, ctx) => {
    const conn = ctx.connection as DbConnection | undefined;
    if (input.engine !== undefined && conn && conn.engine !== input.engine) {
      throw new ToilError('INVALID_INPUT', `--engine ${input.engine} disagrees with connection ${conn.name}, whose engine is ${conn.engine}.`, {
        fix: "Pass --engine on its own to check against that engine, or --connection on its own to use the connection's.",
      });
    }
    const engine = (input.engine ?? conn?.engine) as Dialect | undefined;
    if (!engine) {
      throw new ToilError('NOT_CONFIGURED', 'db lint needs an engine to check against, and there is no db connection to take one from.', {
        fix: `Pass --engine (${engineNames.join(', ')}), or set up a db connection.`,
      });
    }
    const result = lintSql(input.sql, engine, { purpose: input.as });
    ctx.setLint({ engine: result.engine, rules: result.rules });
    const count = (severity: string) => result.findings.filter((f) => f.severity === severity).length;
    return { engine, as: input.as, errors: count('error'), warnings: count('warning'), findings: result.findings };
  },
});

export const commands = [listSchemas, listTables, describeTable, previewTable, query, execute, lint];

/** SQLite is the one built into Node, so its version is Node's to choose. Server engines will name their own as they ship. */
export const supported: SupportedVersion = {
  product: 'SQLite',
  minimum: null,
  note: "toil uses the SQLite built into Node, so the version is whichever your Node ships.",
};

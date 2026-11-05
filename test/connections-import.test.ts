import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectionsCommands } from '../src/connections/commands.js';
import { ImportFormatError } from '../src/connections/import/common.js';
import { FORMATS, FROM_VALUES } from '../src/connections/import/index.js';
import { planImport, slugName } from '../src/connections/import/plan.js';
import { parseJsonc, readXml } from '../src/connections/import/readers.js';
import { parseConnectionString, withoutPassword } from '../src/connections/import/strings.js';
import { parseDbeaver } from '../src/connections/import/dbeaver.js';
import { parseMssqlSettings } from '../src/connections/import/mssql-settings.js';
import { parsePgadmin, parsePgService } from '../src/connections/import/postgres.js';
import { parseSsms } from '../src/connections/import/ssms.js';
import { parseTnsnames } from '../src/connections/import/tnsnames.js';
import { parseDatagrip, parseMysqlWorkbench } from '../src/connections/import/xml-tools.js';
import { loadConfig } from '../src/core/config.js';
import type { Context } from '../src/core/context.js';
import { CONNECTION_NAME } from '../src/core/config.js';
import { areas as registryAreas } from '../src/registry.js';
import { runCli } from './harness/cli.js';
import { TEST_VERSION } from './harness/context.js';
import { fakeFetch } from './harness/fake-fetch.js';
import { fakeStore } from './harness/fake-store.js';
import { memoryFiles } from './harness/files.js';

/**
 * `toil connections import`: the parsers as pure functions over fixture files
 * (shaped from each tool's own documentation, with placeholder hosts, and
 * every password a plainly fake one), the plan that names and checks what they
 * find, and the command against a real config file in a temp home.
 */
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'import', name), 'utf8');
const labels = (p: { candidates: Array<{ label: string }> }) => p.candidates.map((c) => c.label);
const skipped = (p: { skipped: Array<{ label: string; reason: string }> }, label: string) => p.skipped.find((s) => s.label === label)?.reason;

describe('connection strings', () => {
  it.each([
    ['postgres://you:hunter2@db.imagile.dev:5433/app?sslmode=require', 'postgres', { host: 'db.imagile.dev', port: 5433, database: 'app', user: 'you', ssl: true }],
    ['jdbc:postgresql://db.imagile.dev/app?user=you&ssl=true', 'postgres', { host: 'db.imagile.dev', database: 'app', user: 'you', ssl: true }],
    ['mysql://you@db.imagile.dev:3307/shop', 'mysql', { host: 'db.imagile.dev', port: 3307, database: 'shop', user: 'you' }],
    ['jdbc:mariadb://db.imagile.dev/shop?useSSL=true', 'mysql', { host: 'db.imagile.dev', database: 'shop', ssl: true }],
    ['jdbc:sqlserver://sql.imagile.dev:1433;databaseName=orders;encrypt=true;integratedSecurity=true', 'sqlserver', { host: 'sql.imagile.dev', port: 1433, database: 'orders', ssl: true, auth: 'windows' }],
    ['sqlserver://sql.imagile.dev;database=orders;user=you', 'sqlserver', { host: 'sql.imagile.dev', database: 'orders', user: 'you' }],
    ['jdbc:oracle:thin:@//ledger.imagile.dev:1521/FREEPDB1', 'oracle', { host: 'ledger.imagile.dev', port: 1521, database: 'FREEPDB1' }],
    ['jdbc:oracle:thin:you/secret@ledger.imagile.dev:1521/FREEPDB1', 'oracle', { host: 'ledger.imagile.dev', port: 1521, database: 'FREEPDB1', user: 'you' }],
    ['jdbc:hive2://hive.imagile.dev:10000/default', 'hive', { host: 'hive.imagile.dev', port: 10000, database: 'default' }],
    ['jdbc:impala://impala.imagile.dev:21050/default;auth=noSasl', 'impala', { host: 'impala.imagile.dev', port: 21050, database: 'default', auth: 'nosasl' }],
    ['Server=tcp:sql.imagile.dev,1433;Initial Catalog=orders;User ID=you;Password=hunter2;Encrypt=True', 'sqlserver', { host: 'sql.imagile.dev', port: 1433, database: 'orders', user: 'you', ssl: true }],
    ['Server=(local);Database=orders;Integrated Security=SSPI', 'sqlserver', { host: 'localhost', database: 'orders', auth: 'windows' }],
    ['Host=db.imagile.dev;Port=5432;Database=app;Username=you;Password=hunter2;SSL Mode=Require', 'postgres', { host: 'db.imagile.dev', port: 5432, database: 'app', user: 'you', ssl: true }],
    ['jdbc:sqlite:C:/data/scratch.db', 'sqlite', { path: 'C:/data/scratch.db' }],
    ['sqlite:///srv/data/app.db', 'sqlite', { path: '/srv/data/app.db' }],
    ['/srv/data/app.db', 'sqlite', { path: '/srv/data/app.db' }],
  ])('%s', (text, engine, settings) => {
    expect(parseConnectionString(text)).toMatchObject({ engine, settings });
  });

  it('drops every password and says so, never returning one', () => {
    for (const text of ['postgres://you:hunter2@db.imagile.dev/app', 'jdbc:postgresql://db.imagile.dev/app?user=you&password=hunter2', 'Server=sql.imagile.dev;User ID=you;Password=hunter2', 'jdbc:oracle:thin:you/hunter2@//h.imagile.dev:1521/svc', 'jdbc:sqlserver://h.imagile.dev;user=you;password=hunter2']) {
      const mapped = parseConnectionString(text);
      expect(JSON.stringify(mapped), text).not.toContain('hunter2');
      expect('warnings' in mapped && mapped.warnings.join(' '), text).toMatch(/password/);
    }
  });

  it.each([
    'postgres://you:p@ss@db.imagile.dev:5432/app',
    'mysql://you:pa/ss@db.imagile.dev/app',
    'postgres://you:pa?ss@db.imagile.dev/app',
  ])('skips a URL whose unencoded password cut it apart, keeping no piece of it: %s', (text) => {
    const mapped = parseConnectionString(text);
    // Only a skip, with a reason that quotes none of the URL.
    expect(mapped).toEqual({ skip: expect.stringMatching(/^has a URL toil can't read; percent-encode/) });
  });

  it('keeps an IPv6 host', () => {
    expect(parseConnectionString('postgres://you@[::1]:5432/app')).toMatchObject({ settings: { host: '::1', port: 5432 } });
  });

  it.each([
    ['postgres://you:hunter2@db.imagile.dev/app?sslmode=require', 'postgres://you@db.imagile.dev/app?sslmode=require'],
    ['jdbc:oracle:thin:you/hunter2@//h.imagile.dev:1521/svc', 'jdbc:oracle:thin:you@//h.imagile.dev:1521/svc'],
    ['Server=sql.imagile.dev;User ID=you;Password=hunter2;Encrypt=True', 'Server=sql.imagile.dev;User ID=you;Encrypt=True'],
    ['Password="hunter2;x";Server=sql.imagile.dev;User ID=you', 'Server=sql.imagile.dev;User ID=you'],
    ['jdbc:postgresql://db.imagile.dev/app?password=hunter2&user=you', 'jdbc:postgresql://db.imagile.dev/app?user=you'],
    ['jdbc:postgresql://db.imagile.dev/app?user=you&password=hunter2', 'jdbc:postgresql://db.imagile.dev/app?user=you'],
    ['jdbc:sqlserver://h.imagile.dev:1433;user=you@x.com;pwd=hunter2;encrypt=true', 'jdbc:sqlserver://h.imagile.dev:1433;user=you@x.com;encrypt=true'],
    ['jdbc:postgresql://h.imagile.dev/app?user=you&sslpassword=hunter2', 'jdbc:postgresql://h.imagile.dev/app?user=you'],
    ['jdbc:sqlserver://h.imagile.dev;user=you;trustStorePassword=hunter2;encrypt=true', 'jdbc:sqlserver://h.imagile.dev;user=you;encrypt=true'],
  ])('withoutPassword removes the password and nothing else: %s', (text, expected) => {
    expect(withoutPassword(text)).toBe(expected);
  });

  it.each([
    ['jdbc:sqlserver://box.imagile.dev\\SQLEXPRESS;integratedSecurity=true', /instance/],
    ['Server=box.imagile.dev\\SQLEXPRESS;Trusted_Connection=true', /instance/],
    ['jdbc:teradata://td.imagile.dev/DATABASE=x', /Query Service/],
    ['mongodb://docs.imagile.dev/app', /no driver/],
    ['jdbc:oracle:thin:@old.imagile.dev:1521:ORCL', /SID/],
    ['jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=x)))', /tnsnames/],
    ['jdbc:sqlserver://h.imagile.dev;authentication=ActiveDirectoryInteractive', /ActiveDirectoryInteractive/],
    ['jdbc:hive2://h.imagile.dev:10000/default;principal=hive/_HOST@EXAMPLE.COM', /Kerberos/],
    ['jdbc:sqlite:relative.db', /relative/],
    ['\\\\fileserver\\share\\app.db', /another machine/],
    ['just some words', /recognise/],
    ['', /empty/],
  ])('refuses %s with a reason', (text, reason) => {
    const mapped = parseConnectionString(text);
    expect('skip' in mapped && mapped.skip).toMatch(reason);
  });
});

describe('readers', () => {
  it('reads JSON with comments and trailing commas, and leaves comment-looking text inside strings alone', () => {
    expect(parseJsonc('{ /* a */ "url": "http://x//y", // b\n "list": [1, 2,], }', 'f')).toEqual({ url: 'http://x//y', list: [1, 2] });
  });
  it('keeps a __proto__ key as a plain key', () => {
    const parsed = parseJsonc('{"__proto__": {"polluted": true}}', 'f') as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(['__proto__']);
  });
  it('refuses JSON it cannot read, and XML nested past 64 levels', () => {
    expect(() => parseJsonc('{ nope', 'The file')).toThrow(ImportFormatError);
    expect(() => parseJsonc('['.repeat(200_000), 'The file')).toThrow(ImportFormatError);
    expect(() => readXml('<a>'.repeat(100) + '</a>'.repeat(100), 'The file')).toThrow(/nested more than 64/);
    expect(() => readXml('<a><b></a>', 'The file')).toThrow(ImportFormatError);
  });
  it('never quotes the file in a parse error', () => {
    for (const read of [() => parseJsonc('{"password": "hunter2" oops}', 'The file'), () => readXml('<a password="hunter2"><b hunter2></a>', 'The file')]) {
      expect(read).toThrow(ImportFormatError);
      try {
        read();
      } catch (err) {
        expect((err as Error).message).not.toContain('hunter2');
      }
    }
  });
  it('warns once per connection that held a password, wherever the string kept it', () => {
    for (const url of ['jdbc:oracle:thin:@//h.imagile.dev:1521/svc?password=hunter2', 'postgres://you:hunter2@h.imagile.dev/app?password=hunter3']) {
      const mapped = parseConnectionString(url);
      expect('warnings' in mapped && mapped.warnings.filter((w) => /held a password/.test(w))).toHaveLength(1);
    }
  });
  it('says where a JSON file stops parsing', () => {
    expect(() => parseJsonc('{"a": 1 "b": 2}', 'The file')).toThrow(/at character \d+/);
  });
});

describe('DBeaver', () => {
  const parsed = parseDbeaver(fixture('dbeaver-data-sources.json'));
  it('maps what toil can hold, with folders as groups', () => {
    expect(labels(parsed)).toEqual(['Orders DB', 'Shop', 'Warehouse (Windows login)', 'Local scratch', 'Ledger']);
    expect(parsed.candidates[0]).toMatchObject({ group: ['Prod', 'Orders'], engine: 'postgres', settings: { host: 'orders-db.imagile.dev', port: 5432, database: 'orders', user: 'you', ssl: true } });
    expect(parsed.candidates[2]).toMatchObject({ engine: 'sqlserver', settings: { auth: 'windows', host: 'wh.imagile.dev', port: 1433 } });
    expect(parsed.candidates[3]).toMatchObject({ engine: 'sqlite', settings: { path: 'C:/data/scratch.db' } });
    expect(parsed.candidates[4]).toMatchObject({ engine: 'oracle', settings: { host: 'ledger.imagile.dev', database: 'FREEPDB1', user: 'you' } });
  });
  it('drops the password and names what it could not carry over', () => {
    expect(JSON.stringify(parsed)).not.toContain('not-a-real-password');
    expect(parsed.candidates[0]!.warnings.join(' ')).toMatch(/held a password/);
    expect(parsed.candidates[0]!.warnings.join(' ')).toMatch(/loggerLevel/);
    expect(parsed.candidates[1]!.warnings.join(' ')).toMatch(/credentials-config\.json/);
  });
  it('skips tunnels, unsupported drivers and Redshift, each with its reason', () => {
    expect(skipped(parsed, 'Via bastion')).toMatch(/SSH tunnel/);
    expect(skipped(parsed, 'Analytics')).toMatch(/redshift/);
    expect(skipped(parsed, 'Documents')).toMatch(/no driver/);
  });
  it('refuses a file that is not a data-sources.json, and survives a __proto__ connection', () => {
    expect(() => parseDbeaver('{"hello": 1}')).toThrow(/no "connections"/);
    const hostile = parseDbeaver('{"connections": {"__proto__": {"provider": "postgresql", "name": "p", "configuration": {"host": "h.imagile.dev", "database": "d", "user": "u"}}}}');
    expect(hostile.candidates).toHaveLength(1);
    expect(({} as Record<string, unknown>).provider).toBeUndefined();
  });
});

describe('SSMS Registered Servers', () => {
  const parsed = parseSsms(fixture('servers.regsrvr'));
  it('maps servers, with server groups as groups and the root group left out', () => {
    expect(parsed.candidates.map((c) => [c.group.join('/'), c.label, c.settings])).toEqual([
      ['', 'Dev SQL', { host: 'dev-sql.imagile.dev', port: 1433, database: 'orders', user: 'you', ssl: true }],
      ['Prod', 'Billing', { host: 'billing.imagile.dev', database: 'billing', auth: 'windows' }],
    ]);
  });
  it('drops the encrypted password, skips named instances and non-engine servers', () => {
    expect(JSON.stringify(parsed)).not.toContain('0x01000000');
    expect(parsed.candidates[0]!.warnings.join(' ')).toMatch(/password/);
    expect(skipped(parsed, 'Named instance')).toMatch(/instance/);
    expect(skipped(parsed, 'Reports')).toMatch(/ReportServer/);
  });
  it('takes the group from the Parent URI, nested ones included, and still reads the nested layout', () => {
    const server = (parent: string) => `<RegisteredServers:RegisteredServer xmlns:RegisteredServers="x" xmlns:sml="y"><RegisteredServers:Parent><sml:Uri>${parent}</sml:Uri></RegisteredServers:Parent><RegisteredServers:Name>S</RegisteredServers:Name><RegisteredServers:ServerName>s.imagile.dev</RegisteredServers:ServerName><RegisteredServers:ServerType>DatabaseEngine</RegisteredServers:ServerType><RegisteredServers:ConnectionStringWithEncryptedPassword>server=s.imagile.dev;uid=you</RegisteredServers:ConnectionStringWithEncryptedPassword></RegisteredServers:RegisteredServer>`;
    const deep = parseSsms(server('/RegisteredServersStore/ServerGroup/DatabaseEngineServerGroup/ServerGroup/Prod/ServerGroup/Orders'));
    expect(deep.candidates[0]!.group).toEqual(['Prod', 'Orders']);
    const nested = parseSsms('<G><Name>Team</Name><RegisteredServer><Name>S</Name><ServerName>s.imagile.dev</ServerName><ServerType>DatabaseEngine</ServerType><ConnectionStringWithEncryptedPassword>server=s.imagile.dev;uid=you</ConnectionStringWithEncryptedPassword></RegisteredServer></G>');
    expect(nested.candidates[0]!.group).toEqual([]);
    const grouped = parseSsms('<ServerGroup><Name>Team</Name><RegisteredServer><Name>S</Name><ServerName>s.imagile.dev</ServerName><ServerType>DatabaseEngine</ServerType><ConnectionStringWithEncryptedPassword>server=s.imagile.dev;uid=you</ConnectionStringWithEncryptedPassword></RegisteredServer></ServerGroup>');
    expect(grouped.candidates[0]!.group).toEqual(['Team']);
  });
  it('takes the group from the Parent URI, nested ones included, and still reads the nested layout', () => {
    const server = (parent: string) => `<RegisteredServers:RegisteredServer xmlns:RegisteredServers="x" xmlns:sml="y"><RegisteredServers:Parent><sml:Uri>${parent}</sml:Uri></RegisteredServers:Parent><RegisteredServers:Name>S</RegisteredServers:Name><RegisteredServers:ServerName>s.imagile.dev</RegisteredServers:ServerName><RegisteredServers:ServerType>DatabaseEngine</RegisteredServers:ServerType><RegisteredServers:ConnectionStringWithEncryptedPassword>server=s.imagile.dev;uid=you</RegisteredServers:ConnectionStringWithEncryptedPassword></RegisteredServers:RegisteredServer>`;
    const deep = parseSsms(server('/RegisteredServersStore/ServerGroup/DatabaseEngineServerGroup/ServerGroup/Prod/ServerGroup/Orders'));
    expect(deep.candidates[0]!.group).toEqual(['Prod', 'Orders']);
    const inner = '<RegisteredServer><Name>S</Name><ServerName>s.imagile.dev</ServerName><ServerType>DatabaseEngine</ServerType><ConnectionStringWithEncryptedPassword>server=s.imagile.dev;uid=you</ConnectionStringWithEncryptedPassword></RegisteredServer>';
    expect(parseSsms(`<ServerGroup><Name>Team</Name>${inner}</ServerGroup>`).candidates[0]!.group).toEqual(['Team']);
  });
  it('refuses XML that has no servers', () => {
    expect(() => parseSsms('<a><b/></a>')).toThrow(/no registered servers/);
  });
  it('survives a hostile nesting depth without a stack overflow', () => {
    expect(() => parseSsms('<a>'.repeat(5000) + '</a>'.repeat(5000))).toThrow(ImportFormatError);
  });
});

describe('Azure Data Studio and the VS Code SQL Server extension', () => {
  it('reads ADS settings.json (comments, trailing commas, groups, Entra skipped)', () => {
    const parsed = parseMssqlSettings(fixture('ads-settings.json'), 'datasource.connections');
    expect(parsed.candidates.map((c) => [c.group.join('/'), c.label, c.settings])).toEqual([
      ['Prod', 'Orders SQL', { host: 'sql1.imagile.dev', port: 1433, database: 'orders', user: 'you', ssl: true }],
      ['', 'sql2.imagile.dev', { host: 'sql2.imagile.dev', database: 'master', auth: 'windows' }],
    ]);
    expect(skipped(parsed, 'sql3.imagile.dev')).toMatch(/AzureMFA/);
  });
  it('reads the VS Code extension, flat and with a host,port server', () => {
    const parsed = parseMssqlSettings(fixture('vscode-settings.json'), 'mssql.connections');
    expect(parsed.candidates.map((c) => [c.label, c.settings])).toEqual([
      ['Local dev', { host: 'localhost', port: 1433, database: 'dev', user: 'you' }],
      ['Integrated box', { host: 'sql4.imagile.dev', auth: 'windows' }],
    ]);
  });
  it('skips a connection whose provider is not SQL Server, naming it', () => {
    const parsed = parseMssqlSettings('{"datasource.connections": [{"providerName": "PGSQL", "options": {"server": "pg.imagile.dev", "user": "you"}}, {"providerName": "MSSQL", "options": {"server": "ms.imagile.dev", "user": "you"}}]}', 'datasource.connections');
    expect(parsed.candidates.map((c) => c.settings.host)).toEqual(['ms.imagile.dev']);
    expect(skipped(parsed, 'pg.imagile.dev')).toMatch(/PGSQL/);
  });
  it('reads a full connectionString quote-aware, so a quoted password cannot spill into other settings', () => {
    const parsed = parseMssqlSettings('{"mssql.connections": [{"connectionString": "Server=sql.imagile.dev;User ID=you;Password=\\"x;Database=leak\\";Initial Catalog=orders"}]}', 'mssql.connections');
    expect(parsed.candidates[0]!.settings).toEqual({ host: 'sql.imagile.dev', user: 'you', database: 'orders' });
    expect(JSON.stringify(parsed)).not.toContain('leak');
  });
  it('skips a connection whose provider is not SQL Server, naming it', () => {
    const parsed = parseMssqlSettings('{"datasource.connections": [{"providerName": "PGSQL", "options": {"server": "pg.imagile.dev", "user": "you"}}, {"providerName": "MSSQL", "options": {"server": "ms.imagile.dev", "user": "you"}}]}', 'datasource.connections');
    expect(parsed.candidates.map((c) => c.settings.host)).toEqual(['ms.imagile.dev']);
    expect(skipped(parsed, 'pg.imagile.dev')).toMatch(/PGSQL/);
  });
  it('reads a full connectionString quote-aware, so a quoted password cannot spill into other settings', () => {
    const parsed = parseMssqlSettings(JSON.stringify({ 'mssql.connections': [{ connectionString: 'Server=sql.imagile.dev;User ID=you;Password="x;Database=leak";Initial Catalog=orders' }] }), 'mssql.connections');
    expect(parsed.candidates[0]!.settings).toEqual({ host: 'sql.imagile.dev', user: 'you', database: 'orders' });
    expect(JSON.stringify(parsed)).not.toContain('leak');
  });
  it('says plainly when the setting is not there', () => {
    expect(() => parseMssqlSettings('{"editor.fontSize": 12}', 'mssql.connections')).toThrow(/no "mssql\.connections"/);
  });
});

describe('PostgreSQL files', () => {
  it('pgAdmin: groups, SSL modes, tunnels, and a password file noted but never read', () => {
    const parsed = parsePgadmin(fixture('pgadmin-servers.json'));
    expect(parsed.candidates.map((c) => [c.group.join('/'), c.label, c.settings])).toEqual([
      ['', 'Local PostgreSQL', { host: 'localhost', port: 5432, database: 'postgres', user: 'you' }],
      ['Team', 'Reporting', { host: 'reporting.imagile.dev', port: 5432, database: 'reports', user: 'you', ssl: true }],
      ['Team', 'pgAdmin 8', { host: 'modern.imagile.dev', port: 5432, database: 'postgres', user: 'you', ssl: true }],
    ]);
    expect(parsed.candidates[0]!.warnings.join(' ')).toMatch(/password file/);
    // pgAdmin 7 and later: sslmode and passfile live under ConnectionParameters.
    expect(parsed.candidates[2]!.warnings.join(' ')).toMatch(/password file/);
    expect(skipped(parsed, 'Behind a tunnel')).toMatch(/SSH tunnel/);
  });
  it('pg_service.conf: services, libpq default dbname, dropped password, sockets skipped', () => {
    const parsed = parsePgService(fixture('pg_service.conf'));
    expect(parsed.candidates.map((c) => [c.label, c.settings])).toEqual([
      ['orders', { host: 'orders-db.imagile.dev', port: 5432, database: 'orders', user: 'you', ssl: true }],
      ['scratch', { host: 'localhost', database: 'you', user: 'you' }],
    ]);
    expect(JSON.stringify(parsed)).not.toContain('not-a-real-password');
    expect(parsed.candidates[1]!.warnings.join(' ')).toMatch(/password/);
    expect(skipped(parsed, 'socket')).toMatch(/Unix socket/);
  });
});

describe('XML tools and tnsnames', () => {
  it('MySQL Workbench: SSL level, SSH tunnels skipped', () => {
    const parsed = parseMysqlWorkbench(fixture('mysql-workbench-connections.xml'));
    expect(parsed.candidates).toMatchObject([{ label: 'Local instance', engine: 'mysql', settings: { host: '127.0.0.1', port: 3306, user: 'root', database: 'sakila', ssl: true } }]);
    expect(skipped(parsed, 'Through SSH')).toMatch(/SSH tunnel/);
  });
  it('DataGrip: the JDBC URL, user from the file, unsupported drivers skipped', () => {
    const parsed = parseDatagrip(fixture('dataSources.xml'));
    expect(parsed.candidates.map((c) => [c.label, c.engine, c.settings])).toEqual([
      ['orders@orders-db.imagile.dev', 'postgres', { host: 'orders-db.imagile.dev', port: 5432, database: 'orders', user: 'you' }],
      ['mssql', 'sqlserver', { host: 'sql1.imagile.dev', port: 1433, database: 'orders', ssl: true }],
    ]);
    expect(skipped(parsed, 'ClickHouse')).toMatch(/no driver/);
  });
  it('tnsnames.ora: aliases, TCPS, the first of several addresses, SIDs skipped', () => {
    const parsed = parseTnsnames(fixture('tnsnames.ora'));
    expect(parsed.candidates.map((c) => [c.label, c.settings])).toEqual([
      ['LEDGER', { host: 'ledger.imagile.dev', port: 1521, database: 'FREEPDB1' }],
      ['SECURE', { host: 'secure1.imagile.dev', port: 2484, database: 'secure.imagile.dev', ssl: true }],
      ['SECURE.WORLD', { host: 'secure1.imagile.dev', port: 2484, database: 'secure.imagile.dev', ssl: true }],
    ]);
    expect(parsed.candidates[1]!.warnings.join(' ')).toMatch(/2 addresses/);
    expect(skipped(parsed, 'OLDSID')).toMatch(/SID ORCL/);
  });
  it('tnsnames.ora refuses unbalanced and endlessly nested input', () => {
    expect(() => parseTnsnames('A = (DESCRIPTION = (ADDRESS = (HOST = x)')).toThrow(ImportFormatError);
    expect(() => parseTnsnames(`A = ${'(X = '.repeat(100)}1${')'.repeat(100)}`)).toThrow(/levels deep/);
    expect(() => parseTnsnames('# nothing here')).toThrow(/no entries/);
  });
});

describe('every format', () => {
  it('has a default location on each OS that is absolute, or says it has none', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const f of FORMATS) {
        const found = f.locations({ platform, home: platform === 'win32' ? 'C:\\Users\\you' : '/home/you', env: platform === 'win32' ? { APPDATA: 'C:\\Users\\you\\AppData\\Roaming' } : {}, cwd: platform === 'win32' ? 'C:\\proj' : '/proj', list: () => ['18.0', 'x'] });
        for (const path of found) expect(path, `${f.id} on ${platform}`).toMatch(platform === 'win32' ? /^[A-Z]:\\/ : /^\//);
      }
    }
  });
  it('puts DBeaver where DBeaver keeps it on each OS', () => {
    const dbeaver = FORMATS.find((f) => f.id === 'dbeaver')!;
    const base = { env: {}, cwd: '/', list: () => [] };
    expect(dbeaver.locations({ ...base, platform: 'win32', home: 'C:\\Users\\you', env: { APPDATA: 'C:\\Users\\you\\AppData\\Roaming' } })).toEqual(['C:\\Users\\you\\AppData\\Roaming\\DBeaverData\\workspace6\\General\\.dbeaver\\data-sources.json']);
    expect(dbeaver.locations({ ...base, platform: 'darwin', home: '/Users/you' })).toEqual(['/Users/you/Library/DBeaverData/workspace6/General/.dbeaver/data-sources.json']);
    expect(dbeaver.locations({ ...base, platform: 'linux', home: '/home/you' })).toEqual(['/home/you/.local/share/DBeaverData/workspace6/General/.dbeaver/data-sources.json']);
  });
  it('finds SSMS version folders newest first, on Windows only', () => {
    const ssms = FORMATS.find((f) => f.id === 'ssms')!;
    const where = { platform: 'win32' as const, home: 'C:\\Users\\you', env: { APPDATA: 'C:\\A' }, cwd: '/', list: () => ['18.0', '19.0', 'junk'] };
    // SSMS 18 and later: RegSrvr.xml directly in the folder, before any version folder.
    expect(ssms.locations(where)[0]).toBe('C:\\A\\Microsoft\\SQL Server Management Studio\\RegSrvr.xml');
    expect(ssms.locations(where)[1]).toBe('C:\\A\\Microsoft\\SQL Server Management Studio\\19.0\\RegSrvr.xml');
    expect(ssms.locations({ ...where, platform: 'linux' })).toEqual([]);
  });
  it('offers each format as a --from value, and url besides', () => {
    expect(FROM_VALUES).toEqual([...FORMATS.map((f) => f.id), 'url']);
  });
});

describe('planning', () => {
  const valid = () => undefined;
  const parsed = (labels: string[]) => ({
    candidates: labels.map((label) => ({ label, group: [] as string[], engine: 'postgres', settings: { host: 'h.imagile.dev', database: 'd', user: 'u' }, warnings: [] })),
    skipped: [],
    warnings: [],
  });

  it('slugs names to the connection-name rule', () => {
    for (const [parts, name] of [
      [['Orders DB'], 'orders-db'],
      [['Prod', 'Warehouse (Windows login)'], 'prod-warehouse-windows-login'],
      [['Café  Ünïcode'], 'cafe-unicode'],
      [['123 go'], 'db-123-go'],
      [['!!!'], 'db'],
    ] as const) {
      expect(slugName(...parts)).toBe(name);
      expect(CONNECTION_NAME.test(name), name).toBe(true);
    }
    expect(CONNECTION_NAME.test(slugName('x'.repeat(200)))).toBe(true);
  });
  it('de-duplicates inside the batch, reports names that exist and flags the same server under another name', () => {
    const plan = planImport({
      parsed: parsed(['Orders', 'orders', 'Taken']),
      existing: [{ name: 'taken' }, { name: 'older', db: { engine: 'postgres', host: 'H.imagile.dev', database: 'd' } }],
      validate: valid,
    });
    expect(plan.create.map((c) => c.name)).toEqual(['orders', 'orders-2']);
    expect(plan.exists).toMatchObject([{ name: 'taken' }]);
    expect(plan.create[0]).toMatchObject({ similarTo: 'older' });
    expect(plan.create[0]!.warnings.join(' ')).toMatch(/same engine/i);
  });
  it('applies --prefix and --user, and lists next steps by whether a password is wanted', () => {
    const plan = planImport({
      parsed: { candidates: [{ label: 'A', group: [], engine: 'postgres', settings: { host: 'h' }, warnings: [] }, { label: 'B', group: [], engine: 'sqlserver', settings: { host: 'h', auth: 'windows' }, warnings: [] }], skipped: [], warnings: [] },
      prefix: 'Corp',
      user: 'you',
      existing: [],
      validate: valid,
    });
    expect(plan.create.map((c) => c.name)).toEqual(['corp-a', 'corp-b']);
    expect(plan.create[0]!.settings.user).toBe('you');
    expect(plan.create[0]!.nextSteps).toEqual(['toil connections login corp-a', 'toil connections test corp-a']);
    expect(plan.create[1]!.settings.user).toBeUndefined();
    expect(plan.create[1]!.nextSteps).toEqual(['toil connections test corp-b']);
  });
  it('never makes a double hyphen when it numbers a name it had to cut', () => {
    const label = `${'a'.repeat(43)}-bbbbb`;
    const same = { candidates: [1, 2].map(() => ({ label, group: [], engine: 'postgres', settings: { host: 'h', user: 'u' }, warnings: [] })), skipped: [], warnings: [] };
    const plan = planImport({ parsed: same, existing: [], validate: () => undefined });
    expect(plan.create.map((c) => c.name)).toEqual([`${'a'.repeat(43)}-bbbb`, `${'a'.repeat(43)}-2`]);
    expect(plan.create.every((c) => CONNECTION_NAME.test(c.name))).toBe(true);
  });
  it('skips what the schema refuses, saying how to supply a missing user', () => {
    const noUser = { candidates: [{ label: 'A', group: [], engine: 'postgres', settings: { host: 'h' }, warnings: [] }], skipped: [], warnings: [] };
    const plan = planImport({ parsed: noUser, existing: [], validate: () => "can't be a db connection: PostgreSQL connections need user." });
    expect(plan.create).toEqual([]);
    expect(plan.skipped[0]!.reason).toMatch(/--user/);
  });
});

// ---------------------------------------------------------------------------
// The command, against a real config file in a temp home.
// ---------------------------------------------------------------------------
const commands = connectionsCommands(registryAreas);
const slashes = (p: string) => p.replace(/\\/g, '/');
let root: string;
let home: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toil-import-'));
  home = join(root, 'home');
  file = join(home, '.toil', 'config.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeConfig = (content: unknown) => {
  mkdirSync(join(home, '.toil'), { recursive: true });
  writeFileSync(file, JSON.stringify(content));
};
const readConfig = () => JSON.parse(readFileSync(file, 'utf8')) as { connections: Record<string, Record<string, unknown>>; defaults: Record<string, unknown> };
const sample = (name: string) => {
  const target = join(root, name);
  writeFileSync(target, fixture(name));
  return target;
};

function context(env: NodeJS.ProcessEnv = {}): Context {
  return {
    config: loadConfig({ env, cwd: root, home, areas: registryAreas.map((a) => ({ name: a.name })) }),
    fetch: fakeFetch().fetch,
    files: memoryFiles(),
    env,
    version: TEST_VERSION,
    verbose: false,
    debug: () => {},
    secrets: fakeStore(),
  };
}
const cli = async (argv: string[], env?: NodeJS.ProcessEnv) => {
  const run = await runCli(argv, { commands, context: context(env) });
  return { ...run, envelope: run.envelope! };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;

describe('toil connections import', () => {
  it('previews by default: names, settings, what was skipped and why, and writes nothing', async () => {
    const run = await cli(['connections', 'import', '--from', 'pgadmin', sample('pgadmin-servers.json')]);
    expect(run.envelope.ok).toBe(true);
    const data = run.envelope.data as Data;
    expect(data).toMatchObject({ from: 'pgadmin', fileSource: 'argument', saved: false, counts: { connections: 3, exists: 0, skipped: 1 } });
    expect(data.connections.map((c: Data) => c.name)).toEqual(['local-postgresql', 'team-reporting', 'team-pgadmin-8']);
    expect(data.connections[1]).toMatchObject({ engine: 'postgres', settings: { host: 'reporting.imagile.dev', ssl: true }, nextSteps: ['toil connections login team-reporting', 'toil connections test team-reporting'] });
    expect(data.skipped[0]).toMatchObject({ label: 'Team / Behind a tunnel' });
    // The call read this home's config rather than the person's own, so the suggestion says which.
    expect(data.saveWith).toBe(`toil --config ${slashes(file)} connections import --from pgadmin ${join(root, 'pgadmin-servers.json')} --save`);
    expect(() => readFileSync(file)).toThrow();
  });

  it('--save creates the connections: no secret, writes off, no default chosen, and a second run changes nothing', async () => {
    const path = sample('pgadmin-servers.json');
    const run = await cli(['connections', 'import', '--from', 'pgadmin', path, '--save', '--prefix', 'corp']);
    expect(run.envelope).toMatchObject({ ok: true, data: { saved: true, counts: { connections: 3 } } });
    const saved = readConfig();
    expect(saved.connections).toEqual({
      'corp-local-postgresql': { area: 'db', engine: 'postgres', host: 'localhost', port: 5432, database: 'postgres', user: 'you' },
      'corp-team-reporting': { area: 'db', engine: 'postgres', host: 'reporting.imagile.dev', port: 5432, database: 'reports', user: 'you', ssl: true },
      'corp-team-pgadmin-8': { area: 'db', engine: 'postgres', host: 'modern.imagile.dev', port: 5432, database: 'postgres', user: 'you', ssl: true },
    });
    expect(saved.defaults).toEqual({});
    expect(readFileSync(file, 'utf8')).not.toMatch(/password|writes|keychain/i);

    const again = await cli(['connections', 'import', '--from', 'pgadmin', path, '--save', '--prefix', 'corp']);
    expect(again.envelope.data).toMatchObject({ saved: false, counts: { connections: 0, exists: 3 } });
    const list = await cli(['connections', 'list', '--area', 'db']);
    expect((list.envelope.data as Data).connections.map((c: Data) => [c.name, c.writes])).toEqual([['corp-local-postgresql', false], ['corp-team-pgadmin-8', false], ['corp-team-reporting', false]]);
  });

  it('never overwrites a connection of the same name, and keeps what else the file holds', async () => {
    writeConfig({ version: 3, connections: { 'team-reporting': { area: 'db', engine: 'postgres', host: 'other.imagile.dev', database: 'x', user: 'me' } }, defaults: {}, projectPaths: ['/keep/me'] });
    const run = await cli(['connections', 'import', '--from', 'pgadmin', sample('pgadmin-servers.json'), '--save']);
    expect(run.envelope.data).toMatchObject({ saved: true, counts: { connections: 2, exists: 1 }, exists: [{ name: 'team-reporting' }] });
    const saved = readConfig();
    expect(saved.connections['team-reporting']).toMatchObject({ host: 'other.imagile.dev' });
    expect(Object.keys(saved.connections).sort()).toEqual(['local-postgresql', 'team-pgadmin-8', 'team-reporting']);
    expect((saved as Data).projectPaths).toEqual(['/keep/me']);
  });

  it('warns that passwords were dropped, in meta.warnings, and writes none of them', async () => {
    const run = await cli(['connections', 'import', '--from', 'dbeaver', sample('dbeaver-data-sources.json'), '--save', '--user', 'you']);
    expect(run.envelope.meta.warnings?.map((w) => w.code)).toContain('SECRET_NOT_IMPORTED');
    expect(readFileSync(file, 'utf8')).not.toContain('not-a-real-password');
    expect(run.stdout + run.stderr).not.toContain('not-a-real-password');
    const saved = readConfig();
    // The Windows-login connection needs Windows to be a valid db connection; on any other OS it is skipped, which the plan reports.
    expect(Object.keys(saved.connections)).toContain('prod-orders-orders-db');
    expect(saved.connections['shop']).toMatchObject({ user: 'you' });
  });

  it('imports one connection string with --url and --name, dropping its password', async () => {
    const run = await cli(['connections', 'import', '--url', 'postgres://you:hunter2@db.imagile.dev:5432/app?sslmode=require', '--name', 'app-db', '--save']);
    expect(run.envelope).toMatchObject({ ok: true, data: { fileSource: 'url', file: null, saved: true } });
    expect(readConfig().connections['app-db']).toEqual({ area: 'db', engine: 'postgres', host: 'db.imagile.dev', port: 5432, database: 'app', user: 'you', ssl: true });
    expect(readFileSync(file, 'utf8')).not.toContain('hunter2');
    expect(run.stdout + run.stderr).not.toContain('hunter2');
  });

  it.each([
    'postgres://you:hunter2@db.imagile.dev/app?sslmode=require&application_name=toil',
    'jdbc:oracle:thin:you/hunter2@//h.imagile.dev:1521/svc',
    'Server=sql.imagile.dev;User ID=you;Password=hunter2;Initial Catalog=orders',
    'jdbc:postgresql://db.imagile.dev/app?user=you&password=hunter2',
    'jdbc:sqlserver://h.imagile.dev:1433;databaseName=orders;user=you;password=hunter2',
  ])("a preview's saveWith repeats the connection string without its password, quoted: %s", async (url) => {
    const run = await cli(['connections', 'import', '--url', url, '--name', 'app-db']);
    expect(run.envelope.ok).toBe(true);
    expect((run.envelope.data as Data).saveWith).toMatch(/--url ".*" --name app-db --save$/);
    expect(run.stdout + run.stderr).not.toContain('hunter2');
  });

  it("keeps a connection string's password out of the audit log", () => {
    expect(commands.find((c) => c.path.join(' ') === 'connections import')).toMatchObject({ auditInput: { url: 'hash' } });
  });

  it('reports a connection string toil cannot map as skipped, not as an error', async () => {
    const run = await cli(['connections', 'import', '--url', 'mongodb://docs.imagile.dev/app', '--name', 'docs']);
    expect(run.envelope).toMatchObject({ ok: true, data: { counts: { connections: 0, skipped: 1 } } });
  });

  it('finds the tool file at its default location and says which it read', async () => {
    const appData = join(root, 'appdata');
    const dir = join(appData, 'DBeaverData', 'workspace6', 'General', '.dbeaver');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'data-sources.json'), fixture('dbeaver-data-sources.json'));
    const env: NodeJS.ProcessEnv = { APPDATA: appData, HOME: root, USERPROFILE: root, XDG_DATA_HOME: appData };
    // Only Windows reads APPDATA; macOS and Linux read their own home folders, so lay the file out there too.
    mkdirSync(join(root, 'Library', 'DBeaverData', 'workspace6', 'General', '.dbeaver'), { recursive: true });
    writeFileSync(join(root, 'Library', 'DBeaverData', 'workspace6', 'General', '.dbeaver', 'data-sources.json'), fixture('dbeaver-data-sources.json'));
    const run = await cli(['connections', 'import', '--from', 'dbeaver'], env);
    expect(run.envelope.ok).toBe(true);
    expect(run.envelope.data).toMatchObject({ fileSource: 'default' });
    expect((run.envelope.data as Data).file).toMatch(/DBeaverData\/workspace6\/General\/\.dbeaver\/data-sources\.json$/);
  });

  it('fails with the places it looked and how to export, when there is no file', async () => {
    const run = await cli(['connections', 'import', '--from', 'mysql-workbench'], { APPDATA: join(root, 'none'), HOME: root, USERPROFILE: root });
    expect(run.envelope).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(run.envelope.error!.message).toMatch(/Looked in:.*connections\.xml/);
    expect(run.envelope.error!.fix).toMatch(/MySQL Workbench/);
    const named = await cli(['connections', 'import', '--from', 'dbeaver', join(root, 'missing.json')]);
    expect(named.envelope).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it("refuses toil's own config, network paths and files over 4 MB, and a file in the wrong format", async () => {
    writeConfig({ version: 3, connections: {}, defaults: {} });
    const own = await cli(['connections', 'import', '--from', 'dbeaver', file], { HOME: home, USERPROFILE: home });
    expect(own.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(own.envelope.error!.message).toMatch(/toil's own configuration/);
    const unc = await cli(['connections', 'import', '--from', 'dbeaver', '\\\\fileserver\\share\\data-sources.json']);
    expect(unc.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const big = join(root, 'big.json');
    writeFileSync(big, ' '.repeat(4 * 1024 * 1024 + 1));
    const huge = await cli(['connections', 'import', '--from', 'dbeaver', big]);
    expect(huge.envelope.error!.message).toMatch(/at most 4 MB/);
    const wrong = await cli(['connections', 'import', '--from', 'dbeaver', sample('pgadmin-servers.json')]);
    expect(wrong.envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(wrong.envelope.error!.fix).toMatch(/DBeaver/);
  });

  it('refuses a confused set of flags before reading anything', async () => {
    for (const argv of [
      ['connections', 'import'],
      ['connections', 'import', '--from', 'url'],
      ['connections', 'import', '--from', 'dbeaver', '--url', 'postgres://x'],
      ['connections', 'import', '--from', 'pgadmin', '--name', 'x', 'f.json'],
      ['connections', 'import', '--url', 'postgres://x.imagile.dev/a', '--name', 'Bad Name'],
      ['connections', 'import', '--from', 'nope'],
    ]) {
      const run = await cli(argv);
      expect(run.envelope, argv.join(' ')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
  });

  it('is never an MCP tool', () => {
    expect(commands.find((c) => c.path.join(' ') === 'connections import')).toMatchObject({ kind: 'cli-only', writes: false, writesLocal: true });
  });
});

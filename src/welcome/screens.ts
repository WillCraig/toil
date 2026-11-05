import { connectionsOf, connectionWrites, defaultConnectionName, type ResolvedConfig } from '../core/config.js';
import { pal, paint, type TermCaps } from './term.js';
import type { Health, Session } from './view.js';
import { LEARN_LINKS, LEARN_SITE } from './learn.js';
import type { TerminalTheme } from './themes/index.js';

/**
 * What the menu's screens show. Every screen is built from the same code the
 * commands use (config loading, the registry) and has no logic of its own; the
 * menu is a way in, never the only way. Screens are pure: data in, lines out.
 * Unlike the intranet, every page here was generated from something current.
 */

/** One area, as the add-a-connection wizard lists it. */
export interface AreaSummary {
  name: string;
  description: string;
  /** Whether a connection to it has a secret to sign in with. */
  signsIn: boolean;
  /** Whether `toil connections test` can check it live. */
  live: boolean;
  /** Whether a connection to it has settings at all (local git has none). */
  configurable: boolean;
  /** Its context inputs (project, owner, env), which a toil project section can supply. */
  context?: string[];
  /** Hosts people know the service by, to its API's base URL (`defineArea({ siteApis })`), so the menu matches a toil project host as a call does. */
  siteApis?: Readonly<Record<string, string>>;
  /** Whether it has `toil <area> check-toil-project`, which looks a toil project's values up on the service. */
  checksToilProject?: boolean;
  /** Its commands, as the Services browser lists them: `<area> <resource> <action>`. */
  commands?: CommandSummary[];
}

/** One command, as the Services browser shows and runs it. */
export interface CommandSummary {
  /** The full path, area first. */
  path: string[];
  description: string;
  /** Every call writes. */
  writes: boolean;
  /** Some calls write, as the input decides (`<area> api` with a POST); they still need --allow-write. */
  mayWrite?: boolean;
  args: Array<{ name: string; description: string; required: boolean; variadic: boolean }>;
  /** Its own flags, never the ones core adds to every command (--connection, --toil-project, --cwd). */
  flags: Array<{ flags: string; description: string; required: boolean }>;
}

export interface WelcomeData {
  version: string;
  node: string;
  platform: string;
  configPath: string;
  configExists: boolean;
  /** The loaded config, or the error that stopped it loading. */
  config: ResolvedConfig | { error: { code: string; message: string; fix?: string } };
  areas: AreaSummary[];
  /** The names `toil mcp --areas` takes. */
  mcpAreas: string[];
  /** How to start toil from a shell: `toil` when installed, `node <path>` from a clone. */
  launch: { command: string; args: string[] };
  /** What this folder is: the working directory and the repository it's in, read from `.git` without git. */
  folder: { cwd: string; repo?: { root: string; branch: string; remote?: string } };
  /** The theme the menu wears (`toil theme set`, TOIL_THEME): its colours, splash and words, the game's colours too. Crate when absent. */
  theme?: TerminalTheme;
}

type Caps = Pick<TermCaps, 'colorDepth' | 'unicode'>;

const heading = (caps: Caps, text: string) => paint(caps, pal(caps).highlight, text);
const muted = (caps: Caps, text: string) => paint(caps, pal(caps).muted, text);
const faint = (caps: Caps, text: string) => paint(caps, pal(caps).faint, text);
export const ok = (caps: Caps, good: boolean, text: string) => paint(caps, good ? pal(caps).ok : pal(caps).danger, text);

export function hostOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

/** Connection names in the loaded config, sorted; none when it didn't load. */
export function connectionNames(data: WelcomeData): string[] {
  return 'error' in data.config ? [] : Object.keys(data.config.connections).sort();
}

/** Whether every value of a connection comes from env vars, so there's nothing in the file to change. */
export function envOnly(config: ResolvedConfig, name: string): boolean {
  const conn = config.connections[name];
  if (!conn) return false;
  const keys = Object.keys(conn).filter((k) => k !== 'area');
  const env = (k: string) => config.sources[`${name}.${k}`] === 'env' || config.sources[`${name}.${k}`] === 'ci';
  return keys.length > 0 && keys.every(env);
}

/** A connection's health in a word or two, for tables and hints. */
export function healthWord(caps: Caps, health: Health | undefined): string {
  if (!health) return faint(caps, 'not tested');
  if (health.ok) return ok(caps, true, !health.live ? 'settings ok' : health.authenticated === false ? 'host answers' : 'healthy');
  return ok(caps, false, health.code === 'AUTH' ? 'sign-in rejected' : health.code);
}

/** The one-line status under the header. */
export function statusLine(caps: Caps, data: WelcomeData, session: Session = { health: {} }): string {
  const dot = caps.unicode ? '·' : '-';
  if ('error' in data.config) return ok(caps, false, `Config needs attention: ${data.config.error.code}`);
  const names = connectionNames(data);
  const n = names.length;
  const warnings = data.config.warnings.length;
  const tested = names.filter((name) => session.health[name]);
  const failing = tested.filter((name) => !session.health[name]!.ok).length;
  const parts = [muted(caps, `toil ${data.version}`), muted(caps, `${n} connection${n === 1 ? '' : 's'}`)];
  if (n > 0) {
    parts.push(
      tested.length === 0
        ? faint(caps, 'not tested yet')
        : failing
          ? ok(caps, false, `${failing} failing`)
          : ok(caps, true, `${tested.length} healthy`),
    );
  }
  parts.push(warnings ? ok(caps, false, `${warnings} warning${warnings === 1 ? '' : 's'}`) : muted(caps, 'no warnings'));
  return parts.join(faint(caps, ` ${dot} `));
}

/** What this folder resolves to: the repository and its branch and remote. */
export function folderLines(caps: Caps, data: WelcomeData): string[] {
  const repo = data.folder.repo;
  if (!repo) return [`${muted(caps, 'Folder    ')} ${data.folder.cwd} ${faint(caps, '(not in a git repository)')}`];
  return [
    `${muted(caps, 'Repo      ')} ${repo.root}`,
    `${muted(caps, 'Branch    ')} ${repo.branch}${repo.remote ? faint(caps, `  from ${repo.remote}`) : ''}`,
  ];
}

export function healthScreen(caps: Caps, data: WelcomeData, session: Session = { health: {} }): string[] {
  const lines = [
    heading(caps, 'Health check'),
    '',
    `${muted(caps, 'toil      ')} ${data.version}`,
    `${muted(caps, 'Node      ')} ${data.node} on ${data.platform}`,
    `${muted(caps, 'Config    ')} ${data.configPath}${data.configExists ? '' : faint(caps, '  (not created yet)')}`,
    ...folderLines(caps, data),
    '',
  ];
  if ('error' in data.config) {
    lines.push(ok(caps, false, `${data.config.error.code}: ${data.config.error.message}`));
    if (data.config.error.fix) lines.push(muted(caps, `Fix: ${data.config.error.fix}`));
    return lines;
  }
  const n = Object.keys(data.config.connections).length;
  lines.push(ok(caps, true, `Config loads cleanly. ${n} connection${n === 1 ? '' : 's'}.`));
  if (data.config.warnings.length === 0) lines.push(ok(caps, true, 'No warnings.'));
  for (const w of data.config.warnings) lines.push(ok(caps, false, `${w.code}: ${w.message}`));
  const names = connectionNames(data);
  if (names.length) {
    lines.push('');
    const width = Math.max(...names.map((name) => name.length));
    for (const name of names) {
      const health = session.health[name];
      lines.push(`${name.padEnd(width)}  ${healthWord(caps, health)}${health && !health.ok ? muted(caps, `  ${health.message}`) : ''}`);
    }
  }
  return lines;
}

export function connectionsScreen(caps: Caps, data: WelcomeData, session: Session = { health: {} }): string[] {
  const lines = [heading(caps, 'Connections'), ''];
  if ('error' in data.config) return [...lines, ok(caps, false, 'The config file has a problem; see Health check.')];
  const config = data.config;
  const names = connectionNames(data);
  if (names.length === 0) {
    lines.push(muted(caps, 'No connections yet. Add one below, or set them up with environment variables:'));
    lines.push(faint(caps, '  TOIL_JIRA_BASE_URL=https://jira.imagile.dev'));
    lines.push(faint(caps, '  TOIL_JIRA_API_TOKEN=<your token>'));
    return lines;
  }
  const rows = names.map((name) => {
    const c = config.connections[name]!;
    const isDefault = defaultConnectionName(config, c.area) === name;
    const fromEnv = Object.keys(c).some((k) => config.sources[`${name}.${k}`] === 'env' || config.sources[`${name}.${k}`] === 'ci');
    return [
      name + (isDefault && connectionsOf(config, c.area).length > 1 ? ' *' : ''),
      c.area,
      hostOf(c.baseUrl) || hostOf(c.host) || faint(caps, '-'),
      connectionWrites(c) ? ok(caps, false, 'writes on') : muted(caps, 'read only'),
      fromEnv ? muted(caps, 'env ') : muted(caps, 'file'),
      healthWord(caps, session.health[name]),
    ];
  });
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => stripLen(r[i]!)), 4));
  lines.push(faint(caps, ['NAME'.padEnd(widths[0]!), 'AREA'.padEnd(widths[1]!), 'HOST'.padEnd(widths[2]!), 'WRITES    ', 'FROM', 'HEALTH'].join('  ')));
  for (const r of rows) lines.push([pad(r[0]!, widths[0]!), pad(r[1]!, widths[1]!), pad(r[2]!, widths[2]!), pad(r[3]!, 10), r[4], r[5]].join('  '));
  if (names.some((n) => config.connections[n] && connectionsOf(config, config.connections[n]!.area).length > 1)) {
    lines.push('', faint(caps, '* the default for its area'));
  }
  return lines;
}

export type AgentClient = 'claude' | 'codex' | 'vscode';

export const AGENT_CLIENTS: Array<{ id: AgentClient; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'vscode', label: 'VS Code (GitHub Copilot)' },
];

/** The config snippet that registers `toil mcp` with an agent client, serving `areas` (all of them when empty). */
export function agentScreen(caps: Caps, data: WelcomeData, client: AgentClient, areas: readonly string[] = []): string[] {
  const args = [...data.launch.args, 'mcp', ...(areas.length ? ['--areas', areas.join(',')] : [])];
  const label = AGENT_CLIENTS.find((c) => c.id === client)!.label;
  const lines = [heading(caps, `Connect ${label}`), ''];
  if (client === 'claude') {
    lines.push('Run this once:', '', paint(caps, pal(caps).ink, `  claude mcp add toil -- ${[data.launch.command, ...args].map(shellQuote).join(' ')}`));
  } else if (client === 'codex') {
    lines.push('Add this to ~/.codex/config.toml:', '');
    lines.push(paint(caps, pal(caps).ink, '  [mcp_servers.toil]'));
    lines.push(paint(caps, pal(caps).ink, `  command = ${JSON.stringify(data.launch.command)}`));
    lines.push(paint(caps, pal(caps).ink, `  args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`));
  } else {
    lines.push('Add this to .vscode/mcp.json in your project:', '');
    const json = JSON.stringify({ servers: { toil: { type: 'stdio', command: data.launch.command, args } } }, null, 2);
    for (const l of json.split('\n')) lines.push(paint(caps, pal(caps).ink, `  ${l}`));
  }
  lines.push(
    '',
    muted(caps, areas.length ? `The agent gets the tools for ${areas.join(', ')} only.` : 'The agent gets the tools for every area. Pick areas on the step before to narrow it.'),
    muted(caps, 'Reads only: write tools appear once a person turns writes on for a connection.'),
  );
  return lines;
}

export function helpScreen(caps: Caps, data: WelcomeData): string[] {
  const t = (args: string) => `toil ${args}`;
  const row = (command: string, what: string) => `  ${paint(caps, pal(caps).ink, command.padEnd(34))} ${muted(caps, what)}`;
  return [
    heading(caps, 'How toil works'),
    '',
    'One CLI and MCP server for enterprise tools and databases. Every command',
    'prints one JSON envelope, { ok, data, error, meta }, and an agent sees the',
    'same commands as MCP tools. A connection is one instance of a service; its',
    'secret lives in your OS credential store or an env var, never in a file.',
    'Reads are free. A write needs writes on for the connection, set by you,',
    'and --allow-write on the call.',
    '',
    heading(caps, 'Commands'),
    '',
    row(t('connections add <name>'), 'set up a connection'),
    row(t('connections test <name>'), 'check it, with one read'),
    row(t('connections login <name>'), 'replace its secret'),
    row(t('connections writes <name> on'), 'allow writes (asks first)'),
    row(t('connections default <name>'), "make it its area's default"),
    row(t('connections list'), 'every connection, never a secret'),
    row(t('mcp --areas jira,confluence'), 'serve those areas to an agent'),
    row(t('<area> --help'), "an area's commands"),
    '',
    `${muted(caps, 'Docs      ')} https://imagile-dev.github.io/toil/`,
    `${muted(caps, 'Source    ')} https://github.com/imagile-dev/toil`,
    `${muted(caps, 'Version   ')} ${data.version}, by Imagile (https://www.imagile.dev)`,
    ...(data.launch.command === 'toil' ? [] : ['', faint(caps, `From this clone, "toil" is ${[data.launch.command, ...data.launch.args].join(' ')}.`)]),
  ];
}

/** Learn (#418): the links in learn.ts, printed and never opened. */
export function learnScreen(caps: Caps): string[] {
  // Each link on a line of its own, so an 80-column terminal never cuts one short.
  const entry = (label: string, url: string, task = '') => [`  ${paint(caps, pal(caps).ink, label)}${task ? `  ${muted(caps, task)}` : ''}`, `    ${url}`];
  return [
    heading(caps, 'Learn'),
    '',
    'AI terms and agent basics, on Context Overflow. Open a link in your browser.',
    '',
    ...entry('Glossary of AI terms', `${LEARN_SITE}/glossary`),
    ...LEARN_LINKS.flatMap((m) => entry(m.title, `${LEARN_SITE}${m.path}`, m.task)),
  ];
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

function stripLen(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - stripLen(text)));
}

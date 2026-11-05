import { CONNECTION_NAME, connectionsOf, connectionWrites, defaultConnectionName, type ResolvedConfig } from '../../core/config.js';
import { connectionNames, connectionsScreen, envOnly, healthWord, hostOf, ok, type WelcomeData } from '../screens.js';
import { pal, paint } from '../term.js';
import type { Action, Item, Run, View } from '../view.js';

/**
 * The Connections module: the list with health, one connection's actions, and
 * the add-a-connection wizard. Every action here is a real `toil connections`
 * command run as-is, so the menu never knows anything the CLI doesn't. Each
 * screen shows the command it ran; the menu is a guided tour, not a second
 * way of doing things that would need its own audit.
 */

const config = (data: WelcomeData): ResolvedConfig | undefined => ('error' in data.config ? undefined : data.config);

/** `connections test` for each name, all of them, failures included. */
export function testAll(names: readonly string[]): Run {
  return { title: 'Test connections', keepGoing: true, steps: names.map((name) => ({ args: ['connections', 'test', name] })) };
}

const testOne = (name: string): Run => ({ title: `Test ${name}`, steps: [{ args: ['connections', 'test', name] }] });

export const connectionsList: View = {
  title: () => 'Connections',
  body: (caps, p) => connectionsScreen(caps, p.data, p.session),
  items: (p) => {
    const names = connectionNames(p.data);
    const cfg = config(p.data);
    return [
      ...names.map((name): Item => ({
        label: name,
        hint: cfg ? `${cfg.connections[name]!.area} ${hostOf(cfg.connections[name]!.baseUrl) || hostOf(cfg.connections[name]!.host)}`.trim() : '',
        action: { go: 'connection', params: { name } },
      })),
      { label: 'Add a connection', hint: 'Pick a service, sign in, test it', action: { go: 'add-area' } },
      ...(names.length ? [{ label: 'Test all connections', hint: 'One read against each', action: { run: testAll(names) } }] : []),
    ];
  },
};

export const connectionView: View = {
  title: (p) => p.frame.params.name ?? '',
  body: (caps, p) => {
    const name = p.frame.params.name!;
    const cfg = config(p.data);
    const conn = cfg?.connections[name];
    if (!cfg || !conn) return [ok(caps, false, `There's no connection named ${name} any more.`)];
    const area = p.data.areas.find((a) => a.name === conn.area);
    const isDefault = defaultConnectionName(cfg, conn.area) === name;
    const health = p.session.health[name];
    const lines = [
      paint(caps, pal(caps).highlight, name),
      '',
      `${paint(caps, pal(caps).muted, 'Area      ')} ${conn.area}${isDefault ? paint(caps, pal(caps).faint, '  (its default)') : ''}`,
      `${paint(caps, pal(caps).muted, 'Host      ')} ${hostOf(conn.baseUrl) || hostOf(conn.host) || '-'}`,
      `${paint(caps, pal(caps).muted, 'Writes    ')} ${connectionWrites(conn) ? ok(caps, false, 'on') : 'off (read only)'}`,
      `${paint(caps, pal(caps).muted, 'Health    ')} ${healthWord(caps, health)}${area && !area.live ? paint(caps, pal(caps).faint, '  (no live check for this area; the test checks settings and secret)') : ''}`,
    ];
    if (health && !health.ok) {
      lines.push('', ok(caps, false, `${health.code}: ${health.message}`));
      if (health.fix) lines.push(paint(caps, pal(caps).muted, `Fix: ${health.fix}`));
    }
    if (envOnly(cfg, name)) lines.push('', paint(caps, pal(caps).muted, `Defined by env vars, so there's nothing in the config file to change; edit the TOIL_CONN_${name.toUpperCase().replace(/-/g, '_')}_* variables.`));
    return lines;
  },
  items: (p) => {
    const name = p.frame.params.name!;
    const cfg = config(p.data);
    const conn = cfg?.connections[name];
    if (!cfg || !conn) return [];
    const items: Item[] = [{ label: 'Test it', hint: 'One read, as a real command would send', action: { run: testOne(name) } }];
    if (envOnly(cfg, name)) return items;
    const area = p.data.areas.find((a) => a.name === conn.area);
    if (area?.signsIn) {
      items.push({
        label: 'Sign in again',
        hint: 'Replace its secret, then test it',
        action: { run: { title: `Sign in to ${name}`, steps: [{ args: ['connections', 'login', name], label: 'Enter the new secret' }, { args: ['connections', 'test', name], label: 'Test it' }] } },
      });
    }
    const writes = connectionWrites(conn);
    items.push(
      writes
        ? { label: 'Turn writes off', hint: 'Back to read only', action: { run: { title: `Writes off for ${name}`, steps: [{ args: ['connections', 'writes', name, 'off'] }] } } }
        : {
            label: 'Turn writes on',
            hint: 'Asks you to type the name to confirm',
            action: { run: { title: `Writes on for ${name}`, steps: [{ args: ['connections', 'writes', name, 'on'], label: 'Confirm by typing the connection name' }] } },
          },
    );
    if (defaultConnectionName(cfg, conn.area) !== name) {
      items.push({ label: `Make it the ${conn.area} default`, hint: 'Used when a call names no connection', action: { run: { title: `Default for ${conn.area}`, steps: [{ args: ['connections', 'default', name] }] } } });
    }
    items.push({ label: 'Remove', hint: 'Asks you to type the name to confirm', action: { go: 'remove', params: { name } } });
    return items;
  },
};

/** Removing needs the name typed, here in the menu, before the command runs. */
export const removeView: View = {
  title: () => 'Remove',
  body: (caps, p) => [
    paint(caps, pal(caps).danger, `Remove ${p.frame.params.name}?`),
    '',
    'This deletes it from your config file and its secret from the OS credential store.',
  ],
  input: {
    label: (p) => `Type ${p.frame.params.name} to remove it`,
    submit: (text, p): Action | { error: string } => {
      const name = p.frame.params.name!;
      if (text !== name) return { error: `That isn't "${name}", so nothing was removed.` };
      return { run: { title: `Remove ${name}`, steps: [{ args: ['connections', 'remove', name] }], next: (r) => (r[0]?.envelope.ok ? { go: 'connections', root: 'connections' } : undefined) } };
    },
  },
};

const STEPS = 4;
const step = (n: number, what: string) => `Step ${n} of ${STEPS}: ${what}`;

export const addArea: View = {
  title: () => 'Add',
  body: (caps) => [paint(caps, pal(caps).highlight, step(1, 'service')), '', 'Which service is it?'],
  items: (p) =>
    p.data.areas
      .filter((a) => a.configurable)
      .map((a) => ({ label: a.name, hint: a.description, action: { go: 'add-name', params: { area: a.name } } })),
};

/** A free name: the area's own if nobody has it, otherwise the area plus a number. */
export function suggestName(data: WelcomeData, area: string): string {
  const taken = new Set(connectionNames(data));
  if (!taken.has(area)) return area;
  for (let i = 2; ; i++) if (!taken.has(`${area}-${i}`)) return `${area}-${i}`;
}

export const addName: View = {
  title: (p) => p.frame.params.area ?? '',
  body: (caps, p) => [
    paint(caps, pal(caps).highlight, step(2, 'name')),
    '',
    `What should this ${p.frame.params.area} connection be called? You'll pass it as --connection when you have more than one.`,
  ],
  input: {
    label: () => 'Connection name',
    // Another module that sends someone here may suggest the name (one a toil project names), and say where to go after.
    initial: (p) => (p.frame.params.suggest && !connectionNames(p.data).includes(p.frame.params.suggest) ? p.frame.params.suggest : suggestName(p.data, p.frame.params.area!)),
    submit: (text, p): Action | { error: string } => {
      const then = p.frame.params.then ? (JSON.parse(p.frame.params.then) as Action) : undefined;
      const area = p.frame.params.area!;
      if (!CONNECTION_NAME.test(text)) return { error: 'Use lowercase letters, digits and single hyphens, starting with a letter.' };
      if (connectionNames(p.data).includes(text)) return { error: `There's already a connection named ${text}.` };
      const cfg = config(p.data);
      const others = cfg ? connectionsOf(cfg, area) : [];
      return {
        run: {
          title: `Add ${text}`,
          steps: [
            { args: ['connections', 'add', text, '--area', area], label: step(3, 'settings and secret') },
            { args: ['connections', 'test', text], label: step(4, 'live test') },
          ],
          next: (results): Action | undefined => {
            if (!results[0]?.envelope.ok) return undefined;
            // Another module may ask for its own commands first (a toil project's check), then where to go.
            const thenRun = p.frame.params.thenRun ? (JSON.parse(p.frame.params.thenRun) as string[][]) : undefined;
            if (then && thenRun) return { run: { title: 'Check again', steps: thenRun.map((args) => ({ args })), next: () => then } };
            if (then) return then;
            // The first connection to an area becomes its default on its own; a second one asks.
            return others.length ? { go: 'make-default', params: { name: text, area }, root: 'connections' } : { go: 'connection', params: { name: text }, root: 'connections' };
          },
        },
      };
    },
  },
};

export const makeDefault: View = {
  title: () => 'Default',
  body: (caps, p) => [paint(caps, pal(caps).highlight, `Make ${p.frame.params.name} the ${p.frame.params.area} default?`), '', 'The default is the connection a call uses when it names none.'],
  items: (p) => {
    const name = p.frame.params.name!;
    const then = { go: 'connection', params: { name }, root: 'connections' } as const;
    return [
      { label: 'Yes', hint: `toil connections default ${name}`, action: { run: { title: `Default for ${p.frame.params.area}`, steps: [{ args: ['connections', 'default', name] }], next: () => then } } },
      { label: 'No', hint: 'Keep the current default', action: then },
    ];
  },
};


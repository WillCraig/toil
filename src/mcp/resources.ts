import { areaOf, commandName, type AnyCommand } from '../core/command.js';
import { CONNECTION_NAME, connectionWrites, defaultConnectionName } from '../core/config.js';
import type { Context } from '../core/context.js';
import { runCommand } from '../core/run.js';
import { skillPages } from '../skill-pages.generated.js';

/**
 * What `toil mcp` serves besides tools: descriptions of toil's own context,
 * read without spending a tool call. None of them reads from a service or a
 * database, and none carries a secret:
 *
 * - `toil://connections`: each connection's name, area, whether it's the
 *   area's default and whether writes are on. Never a host, a key or a value.
 * - `toil://projects` and `toil://projects/<name>`: what `toil projects list` and
 *   `toil projects show <name>` return, run through the same core as the tools.
 * - `toil://skill/<area>`: the distributed skill's page for each area served.
 * - `toil://skill/workflows/<job>`: the skill's workflow pages (and their shared
 *   README), whatever --areas says, since a job spans areas.
 *
 * They follow `--areas` as the tools do: connections only to areas served, the
 * toil projects only when the toil projects tools are, and a skill page only for an area
 * the server has tools for. Reading the room before speaking, which is more
 * than most meeting invites manage.
 */

export const CONNECTIONS_URI = 'toil://connections';
export const TOIL_PROJECTS_URI = 'toil://projects';
const TOIL_PROJECT_PREFIX = `${TOIL_PROJECTS_URI}/`;
const SKILL_PREFIX = 'toil://skill/';
/** The skill pages that belong to no area, served whatever --areas says: what to do when toil is upgraded, and what changed. */
const UPGRADE_PAGES = ['upgrading', 'changelog'] as const;
const UPGRADE_DESCRIPTIONS: Record<(typeof UPGRADE_PAGES)[number], string> = {
  upgrading: 'Standing instructions for when toil is upgraded or a retired name turns up: read what changed, then convert config, env vars and toil projects with approval.',
  changelog: 'Breaking changes and features of the newest toil releases, newest first.',
};

/** The workflow pages, `workflows/review` and the rest, which belong to no one area. */
const workflowPages = () => Object.keys(skillPages).filter((name) => name.startsWith('workflows/')).sort();

export interface ResourceEntry {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

/** The pieces of the server the resources are read through. */
export interface ResourceHost {
  /** The tools the server serves, after --areas. */
  selected: readonly AnyCommand[];
  /** The areas the server was started for, or undefined for every configured one. */
  areas: readonly string[] | undefined;
  /** A fresh context, for a command or for none (config only). */
  context: (def?: AnyCommand) => Context;
  version: string;
}

/** A resource that couldn't be read: the URI is unknown, or what backs it failed. */
export class ResourceError extends Error {
  constructor(
    message: string,
    readonly notFound: boolean,
  ) {
    super(message);
  }
}

const byName = (host: ResourceHost, name: string) => host.selected.find((def) => commandName(def) === name);

/** The areas whose resources are served: those with a tool, or exactly --areas. */
function servedAreas(host: ResourceHost): Set<string> {
  return new Set(host.areas ?? host.selected.map(areaOf));
}

/** Every concrete resource, for resources/list. Each toil project gets its own entry, so a client can show them. */
export async function listResources(host: ResourceHost): Promise<ResourceEntry[]> {
  const list: ResourceEntry[] = [
    {
      uri: CONNECTIONS_URI,
      name: 'connections',
      title: 'toil connections',
      description: "Each toil connection's name, area, whether it is the area's default and whether writes are on. Never a host or a secret.",
      mimeType: 'application/json',
    },
  ];
  if (byName(host, 'projects list')) {
    list.push({ uri: TOIL_PROJECTS_URI, name: 'projects', title: 'toil projects', description: 'Every toil project toil can see, as toil projects list returns it.', mimeType: 'application/json' });
    const data = await viaCommand(host, 'projects list', {}).catch(() => undefined);
    const names = [...new Set(((data as { toilProjects?: Array<{ name: string }> } | undefined)?.toilProjects ?? []).map((d) => d.name))];
    if (byName(host, 'projects show')) {
      for (const name of names) {
        list.push({ uri: `${TOIL_PROJECT_PREFIX}${encodeURIComponent(name)}`, name: `toil project ${name}`, title: `Toil project ${name}`, description: `The ${name} toil project, as toil projects show ${name} returns it.`, mimeType: 'application/json' });
      }
    }
  }
  for (const area of [...servedAreas(host)].sort()) {
    if (skillPages[area] === undefined) continue;
    list.push({ uri: `${SKILL_PREFIX}${area}`, name: `skill ${area}`, title: `toil ${area} reference`, description: `The toil skill's page for ${area}: its configuration keys, credential and every command.`, mimeType: 'text/markdown' });
  }
  for (const page of UPGRADE_PAGES) {
    list.push({ uri: `${SKILL_PREFIX}${page}`, name: `skill ${page}`, title: page === 'upgrading' ? 'Upgrading toil' : 'toil changelog', description: UPGRADE_DESCRIPTIONS[page], mimeType: 'text/markdown' });
  }
  for (const page of workflowPages()) {
    const readme = page === 'workflows/README';
    list.push({
      uri: `${SKILL_PREFIX}${page}`,
      name: `skill ${page}`,
      title: readme ? 'toil workflows' : `toil workflow ${page.slice('workflows/'.length)}`,
      description: readme ? 'The rules every workflow page follows: only toil, reads free and writes asked, bounded loops, honest output.' : 'A whole job as steps of toil commands: when to read it, what it needs, what it may write, and what it never does.',
      mimeType: 'text/markdown',
    });
  }
  return list;
}

/** The URI templates, for resources/templates/list. */
export function listTemplates(host: ResourceHost): Array<{ uriTemplate: string; name: string; description: string; mimeType: string }> {
  if (!byName(host, 'projects show')) return [];
  return [{ uriTemplate: `${TOIL_PROJECT_PREFIX}{name}`, name: 'toil-project', description: 'One toil project by name, as toil projects show <name> returns it.', mimeType: 'application/json' }];
}

/** One resource's contents, for resources/read. */
export async function readResource(host: ResourceHost, uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
  const json = (data: unknown) => ({ uri, mimeType: 'application/json', text: JSON.stringify(data) });
  if (uri === CONNECTIONS_URI) return json(connections(host));
  if (uri === TOIL_PROJECTS_URI && byName(host, 'projects list')) return json(await viaCommand(host, 'projects list', {}));
  if (uri.startsWith(TOIL_PROJECT_PREFIX) && byName(host, 'projects show')) {
    let name = '';
    try {
      name = decodeURIComponent(uri.slice(TOIL_PROJECT_PREFIX.length));
    } catch {
      // A malformed escape names nothing; refused below like any other non-name.
    }
    // A name, never a path: a resource URI is no way to point toil at a file. Toil project names
    // follow the connection-name rule (src/core/toil-project.ts), so anything else is refused here,
    // before the toil project catalog could read it as a file.
    if (!CONNECTION_NAME.test(name)) {
      throw new ResourceError(`${uri} doesn't name a toil project: a toil project name is lowercase letters, digits and single hyphens, starting with a letter. Use ${TOIL_PROJECT_PREFIX}<name>.`, true);
    }
    return json(await viaCommand(host, 'projects show', { toilProject: name }));
  }
  if (uri.startsWith(SKILL_PREFIX)) {
    const area = uri.slice(SKILL_PREFIX.length);
    const page = skillPages[area];
    if (page !== undefined && (servedAreas(host).has(area) || (UPGRADE_PAGES as readonly string[]).includes(area) || workflowPages().includes(area))) return { uri, mimeType: 'text/markdown', text: page };
  }
  throw new ResourceError(`toil serves no resource ${uri} here. resources/list names the ones it does.`, true);
}

/** Connection names, areas, default and writes, for the areas served: what an agent needs to pick one, and nothing else. */
function connections(host: ResourceHost): { connections: Array<{ name: string; area: string; isDefault: boolean; writes: boolean }> } {
  const { config } = host.context();
  const areas = servedAreas(host);
  return {
    connections: Object.keys(config.connections)
      .sort()
      .filter((name) => areas.has(config.connections[name]!.area))
      .map((name) => {
        const conn = config.connections[name]!;
        return { name, area: conn.area, isDefault: defaultConnectionName(config, conn.area) === name, writes: connectionWrites(conn) };
      }),
  };
}

/** A toil projects command's data, run as its tool would be; a failure is the envelope's message and fix. */
async function viaCommand(host: ResourceHost, name: string, input: Record<string, unknown>): Promise<unknown> {
  const def = byName(host, name)!;
  const envelope = await runCommand(def, input, (d) => host.context(d), host.version, 'mcp');
  if (envelope.ok) return envelope.data;
  throw new ResourceError(`${envelope.error.message}${envelope.error.fix ? ` ${envelope.error.fix}` : ''}`, envelope.error.code === 'INVALID_INPUT');
}

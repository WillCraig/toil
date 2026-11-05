import type { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { modules } from '../src/areas.generated.js';
import { commandName } from '../src/core/command.js';
import { envName } from '../src/core/config.js';
import { supportedText, type SupportedVersion } from '../src/core/supported.js';
import { areas, commands } from '../src/registry.js';
import { checkInvocation, flagsOf, invocations, program, subcommand } from './harness/cli-lines.js';

/**
 * The skill shipped to users (skills/toil/) is how an agent learns an area
 * exists and how to configure it. SKILL.md is generic on purpose: it names the
 * rule (`<area>.md`, beside it), and each area's file carries its own
 * frontmatter, so twenty integrations never edit one index table. A registered area
 * with no reference file is an area nobody's agent will find. Undocumented
 * capability is, for audit purposes, indistinguishable from no capability.
 */
const dir = join(import.meta.dirname, '..', 'skills', 'toil');
const workflowsDir = join(dir, 'workflows');
/** Every Markdown file of the skill, as a path from its folder: the pages beside SKILL.md, and the workflow pages. */
const allFiles = [...readdirSync(dir).filter((f) => f.endsWith('.md')), ...readdirSync(workflowsDir).map((f) => `workflows/${f}`)];
/** The files in the skill that belong to no area: the index, what every command shares, toil projects, installing toil, and the MCP server. */
const GENERAL = ['SKILL.md', 'core.md', 'projects.md', 'install.md', 'mcp.md', 'setup.md', 'upgrading.md'];
const integrations = join(import.meta.dirname, '..', 'site', 'src', 'data', 'integrations');

/** The `key: value` lines between a file's opening `---` fences. */
export function frontmatter(text: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return undefined;
  const out: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(': ');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 2).trim();
  }
  return out;
}

/** Groups of standalone commands, `util` for `toil util jwt decode`; a lone standalone command (`version`) has none. */
const standaloneGroups = [...new Set(commands.filter((d) => d.kind === 'standalone' && d.path.length > 1).map((d) => d.path[0]))];

const supportedOf = new Map(modules.flatMap((m) => (m.area ? [[m.area.name, m.supported] as const] : [])));

describe('shipped skill', () => {
  const index = readFileSync(join(dir, 'SKILL.md'), 'utf8');

  it('SKILL.md names no area list to keep current, only the <area>.md rule', () => {
    expect(index).not.toMatch(/^\| Area \|/m);
    expect(index).toContain('named after it');
  });

  it('every reference file belongs to a registered area or group of standalone commands', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md') && !GENERAL.includes(f));
    expect(files.filter((f) => ![...areas.map((a) => a.name), ...standaloneGroups].some((name) => `${name}.md` === f))).toEqual([]);
  });

  // A group of standalone commands (`toil util ...`) has no connection, so no
  // keys or supported versions to document, but agents still need its file.
  for (const group of standaloneGroups) {
    it(`${group}: has skills/toil/${group}.md with frontmatter, naming every command`, () => {
      expect(existsSync(join(dir, `${group}.md`)), `add skills/toil/${group}.md`).toBe(true);
      const doc = readFileSync(join(dir, `${group}.md`), 'utf8');
      const meta = frontmatter(doc);
      expect(meta?.area, `start skills/toil/${group}.md with ---\\narea: ${group}\\ndescription: ...\\n---`).toBe(group);
      expect(meta?.description ?? '').not.toBe('');
      expect(meta?.description ?? '', 'no ": " inside the description').not.toContain(': ');
      for (const def of commands.filter((d) => d.kind === 'standalone' && d.path[0] === group)) {
        expect(doc.includes(`\`toil ${def.path.join(' ')}`), `${commandName(def)} is not named in skills/toil/${group}.md`).toBe(true);
      }
    });
  }

  for (const area of areas) {
    it(`${area.name}: has skills/toil/${area.name}.md with frontmatter naming the area and what it covers`, () => {
      expect(existsSync(join(dir, `${area.name}.md`)), `add skills/toil/${area.name}.md`).toBe(true);
      const meta = frontmatter(readFileSync(join(dir, `${area.name}.md`), 'utf8'));
      expect(meta?.area, `start skills/toil/${area.name}.md with ---\\narea: ${area.name}\\ndescription: ...\\n---`).toBe(area.name);
      expect(meta?.description ?? '', 'a one-line description of what the area covers').not.toBe('');
      // A colon and a space would make the line a YAML mapping, not a sentence.
      expect(meta?.description ?? '', 'no ": " inside the description').not.toContain(': ');
    });

    it(`${area.name}: its reference names every command and every connection key's env var`, () => {
      const doc = readFileSync(join(dir, `${area.name}.md`), 'utf8');
      for (const def of commands.filter((d) => d.path[0] === area.name)) {
        // In code, either bare (`issue get`) or in full (`toil jira issue get`).
        const name = def.path.slice(1).join(' ');
        const named = doc.includes(`\`${name}`) || doc.includes(`\`toil ${def.path.join(' ')}`);
        expect(named, `${commandName(def)} is not named in skills/toil/${area.name}.md`).toBe(true);
      }
      for (const key of Object.keys(area.connection.shape)) {
        expect(doc, `${area.name}.${key}`).toContain(envName(area.name, key));
      }
    });

    it(`${area.name}: its reference names every CI fallback variable it declares`, () => {
      const doc = readFileSync(join(dir, `${area.name}.md`), 'utf8');
      const fallbacks = Object.entries((area.fallbacks ?? {}) as Record<string, string[] | undefined>);
      for (const [key, names] of fallbacks) {
        for (const name of names ?? []) expect(doc, `${area.name}.${key} falls back to ${name}; say so in skills/toil/${area.name}.md`).toContain(name);
      }
    });

    it(`${area.name}: declares its supported versions once, and its skill file and site data say the same`, () => {
      const supported = supportedOf.get(area.name);
      expect(supported, `export const supported: SupportedVersion from src/areas/${area.name}/index.ts`).toBeDefined();
      const doc = readFileSync(join(dir, `${area.name}.md`), 'utf8');
      expect(doc, `skills/toil/${area.name}.md needs a "**Supported versions:**" line`).toContain(`**Supported versions:** ${supportedText(supported!)}`);
      const site = join(integrations, `${area.name}.json`);
      if (existsSync(site)) {
        const data = JSON.parse(readFileSync(site, 'utf8')) as { supported?: SupportedVersion };
        expect(data.supported, `site/src/data/integrations/${area.name}.json "supported"`).toEqual(supported);
      }
    });
  }
});

describe('commands and flags the skill names exist', () => {
  const files = allFiles;

  it('finds invocations to check, so a broken parser cannot pass by finding none', () => {
    const found = files.flatMap((f) => invocations(readFileSync(join(dir, f), 'utf8')));
    expect(found.length).toBeGreaterThan(50);
    expect(checkInvocation(['jira', 'issue', 'get', 'ABC-1', '--pretty'])).toBeUndefined();
    expect(checkInvocation(['jira', 'issue', 'get', '--kye', 'ABC-1'])).toMatch(/--kye/);
    expect(checkInvocation(['jira', 'issue', 'gte'])).toMatch(/gte/);
    expect(checkInvocation(['setup', 'alias', '--profile', '$PROFILE'])).toBeUndefined();
    expect(checkInvocation(['mcp', '--areas', 'jira'])).toBeUndefined();
  });

  for (const file of files) {
    it(`${file}: every \`toil …\` it shows is a real command with real flags`, () => {
      const bad = invocations(readFileSync(join(dir, file), 'utf8'))
        .map((args) => [args.join(' '), checkInvocation(args)] as const)
        .filter(([, problem]) => problem)
        .map(([line, problem]) => `toil ${line}: ${problem}`);
      expect(bad).toEqual([]);
    });
  }

  it('finds command table rows to check in the area files', () => {
    expect(areas.reduce((n, area) => n + flagCells(area).rows, 0)).toBeGreaterThan(20);
  });

  for (const area of areas) {
    it(`${area.name}: every flag in a command table row of skills/toil/${area.name}.md is a flag of that command`, () => {
      expect(flagCells(area).bad).toEqual([]);
    });
  }
});

/**
 * The command tables in an area's file (`| \`get-issue\` | \`--key\` | … |`):
 * every `--flag` in a row's second cell, the flags column, must be a flag of the
 * command the first cell names, or a group or global one. Rows about a setting
 * or an error name something that isn't a command, and are skipped. Prose
 * mentions flags of other commands on purpose, so only the column is held to it.
 */
function flagCells(area: { name: string }): { rows: number; bad: string[] } {
  const group = subcommand(program, area.name);
  const bad: string[] = [];
  let rows = 0;
  for (const line of readFileSync(join(dir, `${area.name}.md`), 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split(' | ');
    const name = /`([^`]+)`/.exec(cells[0] ?? '')?.[1]?.replace(`toil ${area.name} `, '');
    let leaf: Command | undefined = group;
    for (const word of name?.split(' ') ?? []) leaf = leaf && subcommand(leaf, word);
    if (!name || !leaf || leaf === group || leaf.commands.length || cells.length < 3) continue;
    rows++;
    const flags = flagsOf(leaf);
    for (const m of (cells[1] ?? '').matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) if (!flags.has(m[0])) bad.push(`${name}: ${m[0]}`);
  }
  return { rows, bad };
}

/**
 * One folder, installable by any skill manager: the Agent Skills format with
 * nothing agent-specific in it, and a Claude Code marketplace in the repository
 * whose one plugin is that folder's repository. Claude Code itself checks the
 * manifests in CI (`claude plugin validate`); this keeps the shape the docs
 * promise, offline.
 */
describe('installable skill', () => {
  const root = join(import.meta.dirname, '..');
  const index = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const meta = frontmatter(index);

  it('SKILL.md has only the two Agent Skills fields every manager reads, and its name is its folder', () => {
    expect(Object.keys(meta ?? {}).sort()).toEqual(['description', 'name']);
    expect(meta?.name).toBe('toil');
    expect(meta?.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect((meta?.description ?? '').length).toBeGreaterThan(0);
    expect((meta?.description ?? '').length).toBeLessThanOrEqual(1024);
  });

  it('no file in the skill uses syntax only one agent understands', () => {
    for (const file of allFiles) {
      const text = readFileSync(join(dir, file), 'utf8');
      // Claude Code's argument and shell-injection placeholders, and plugin-root variables.
      expect(text, file).not.toMatch(/\$ARGUMENTS|!`|\$\{CLAUDE_[A-Z_]+\}/);
    }
  });

  it('stands alone: every file the skill points to is in its own folder, so a copy anywhere works', () => {
    const present = new Set(readdirSync(dir));
    for (const file of allFiles) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const m of text.matchAll(/`([a-z0-9-]+\.md)`/g)) // changelog.md is generated into the bundle from CHANGELOG.md, not a file in this folder.
      expect(present.has(m[1]!) || m[1] === 'changelog.md', `${file} points to ${m[1]}`).toBe(true);
    }
  });

  it('the marketplace lists one plugin, toil, at the repository root, where skills/toil/ is', () => {
    const market = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name: string; plugins: Array<{ name: string; source: string }> };
    const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string };
    expect(market.name).toBe('toil');
    expect(market.plugins.map((p) => [p.name, p.source])).toEqual([['toil', './']]);
    expect(plugin.name).toBe('toil');
    expect(existsSync(join(root, market.plugins[0]!.source, 'skills', 'toil', 'SKILL.md'))).toBe(true);
  });

  it('install.md names the marketplace and plugin the manifests define', () => {
    const install = readFileSync(join(dir, 'install.md'), 'utf8');
    expect(install).toContain('claude plugin marketplace add imagile-dev/toil');
    expect(install).toContain('claude plugin install toil@toil');
    expect(install).toContain('.agents/skills/toil');
  });
});

/**
 * Ticket the work (#304): before an agent starts work no ticket covers, it
 * matches the work to an open ticket with `util owi similar` and asks the
 * person, who chooses; creating anything is a write. The rule is in the index
 * every agent loads, in core.md in full, and on every tracker page whose
 * output `util owi map` reads, each with that tracker's own search.
 */
describe('the skill tells an agent to ticket the work before starting it (#304)', () => {
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  const section = (text: string) => {
    const at = text.indexOf('## Ticket the work');
    if (at < 0) return '';
    const next = text.indexOf('\n## ', at + 5);
    return text.slice(at, next < 0 ? undefined : next);
  };

  it('SKILL.md names the command and points to the rule', () => {
    const index = read('SKILL.md');
    expect(index).toContain('`toil util owi similar --query`');
    expect(index).toContain('ask the person');
    expect(index).toContain('`core.md`,\n  **Ticket the work**');
  });

  it('names a command that exists and ranks by a query', () => {
    const similar = commands.find((c) => c.path.join(' ') === 'util owi similar');
    expect(similar?.writes).toBe(false);
    expect(Object.keys((similar!.input as unknown as { shape: object }).shape)).toContain('query');
  });

  it('core.md has the rule: match, offer three choices, and write only on a yes', () => {
    const rule = section(read('core.md')).replace(/\s+/g, ' ');
    expect(rule).not.toBe('');
    for (const text of ['toil util owi map', 'toil util owi similar --query', 'Never decide on your own', '**Attach**', '**Create a sub-task**', '**Create a new ticket**', 'OWI_SIMILAR_NO_MATCH', '`--allow-write`', "the person's yes"]) {
      expect(rule, text).toContain(text);
    }
  });

  for (const area of ['jira', 'ado', 'github']) {
    it(`${area}.md shows its own search, mapped and ranked, and points to the rule`, () => {
      const rule = section(read(`${area}.md`));
      expect(rule, `add "## Ticket the work" to skills/toil/${area}.md`).not.toBe('');
      expect(rule).toMatch(new RegExp(`^toil ${area} .* [|] toil util owi map [|] toil util owi similar --query `, 'm'));
      const flat = rule.replace(/\s+/g, ' ');
      expect(flat).toContain('`core.md`, **Ticket the work**');
      expect(flat).toContain("only on the person's yes");
    });
  }
});

/**
 * Workflow pages (#527): whole jobs written as steps of toil commands, in
 * skills/toil/workflows/. Each page's frontmatter is read by agents and by Toil
 * UI, so it is held to a format here, to the registry (areas and write
 * commands that exist), and to the index in SKILL.md. A `toil <host> …` line
 * stands for every host the page's `needs.any` names, so it is checked once per
 * host: a verb one host lacks belongs in the page's per-host table, not in a
 * line that claims to fit all three.
 */
describe('workflow pages', () => {
  const pageFiles = readdirSync(workflowsDir).filter((f) => f !== 'README.md');
  const areaNames = areas.map((a) => a.name);
  const index = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const KEYS = ['job', 'description', 'role', 'needs', 'inputs', 'writes', 'loop', 'verification'];

  const pageOf = (file: string) => {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    const meta = frontmatter(text) ?? {};
    const json = (key: string) => JSON.parse(meta[key] ?? 'null') as unknown;
    return {
      text,
      meta,
      needs: json('needs') as { all?: string[]; any?: string[]; optional?: string[] },
      inputs: json('inputs') as Array<{ name?: unknown; toilProject?: unknown }>,
      writes: json('writes') as string[],
    };
  };
  /** The write command a line of a page runs, by its full path, if it runs one: after the last `--`, at the front. */
  const writeCommandOf = (args: string[]) => {
    const words = args.slice(args.lastIndexOf('--') + 1);
    return commands.find((c) => c.writes && c.path.every((w, i) => words[i] === w));
  };
  /** The lines of SKILL.md's "By job" block that name a page. */
  const blockLines = (text: string): string[] => {
    const at = text.indexOf('\n## By job');
    if (at < 0) return [];
    const next = text.indexOf('\n## ', at + 5);
    return text.slice(at, next < 0 ? undefined : next).split('\n').filter((l) => l.startsWith('- `workflows/'));
  };

  it('has the shared README and at least the three first pages', () => {
    expect(existsSync(join(workflowsDir, 'README.md'))).toBe(true);
    expect([...pageFiles].sort()).toEqual(expect.arrayContaining(['map-codebase.md', 'review.md', 'ship.md']));
    expect(readdirSync(workflowsDir).filter((f) => !f.endsWith('.md'))).toEqual([]);
  });

  // The docs site compiles each file's frontmatter as real YAML, which the line-by-line
  // reader above forgives: a ": " in a description is a mapping where a sentence was meant.
  for (const file of readdirSync(workflowsDir)) {
    it(`${file}: its frontmatter is valid YAML, and the one-line reader agrees with it`, () => {
      const text = readFileSync(join(workflowsDir, file), 'utf8');
      const yaml = load(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)![1]!) as Record<string, unknown>;
      expect(typeof yaml.description).toBe('string');
      for (const key of Object.keys(frontmatter(text)!)) expect(yaml, key).toHaveProperty(key);
      if (file !== 'README.md') expect(yaml.needs).toEqual(pageOf(file).needs);
    });
  }

  for (const file of pageFiles) {
    describe(file, () => {
      const page = pageOf(file);
      const hosts = page.needs?.any ?? [];

      it('has every frontmatter key, a job named after its file, and values of the right kind', () => {
        expect(Object.keys(page.meta).sort()).toEqual([...KEYS].sort());
        expect(page.meta.job).toBe(file.replace(/\.md$/, ''));
        expect(page.meta.description, 'no ": " inside the description').not.toContain(': ');
        expect(page.meta.description!.length).toBeGreaterThan(20);
        expect(['reviewer', 'author', 'any']).toContain(page.meta.role);
        expect(['unit', 'live']).toContain(page.meta.verification);
        expect(page.meta.loop === 'none' || /^[1-9]\d*$/.test(page.meta.loop!), 'loop is none or a round limit').toBe(true);
        expect(Array.isArray(page.inputs) && page.inputs.every((i) => typeof i.name === 'string' && typeof i.toilProject === 'boolean'), 'inputs: [{ name, toil project }]').toBe(true);
        expect(page.inputs.length).toBeGreaterThan(0);
      });

      it('needs only areas that exist, with alternatives under `any`', () => {
        expect(Object.keys(page.needs).filter((k) => !['all', 'any', 'optional'].includes(k))).toEqual([]);
        const named = [...(page.needs.all ?? []), ...hosts, ...(page.needs.optional ?? [])];
        expect(named.length).toBeGreaterThan(0);
        expect(named.filter((n) => !areaNames.includes(n))).toEqual([]);
      });

      it('lists as `writes` full paths of write commands in the areas it needs, each one the page names', () => {
        const needed = new Set([...(page.needs.all ?? []), ...hosts, ...(page.needs.optional ?? [])]);
        expect(Array.isArray(page.writes)).toBe(true);
        for (const path of page.writes) {
          const def = commands.find((c) => c.path.join(' ') === path);
          expect(def?.writes, `${path} is not a write command`).toBe(true);
          expect(needed.has(def!.path[0]!), `${path} is outside the areas the page needs`).toBe(true);
          expect(page.text.includes(def!.path.slice(1).join(' ')), `${path} is in writes but never shown`).toBe(true);
        }
      });

      it('shows no write command that its `writes` leaves out', () => {
        const shown = invocations(page.text).flatMap((args) => (hosts.length ? [args, ...hosts.map((h) => args.map((w) => (w === '<host>' ? h : w)))] : [args]));
        const unlisted = shown.flatMap((args) => {
          const def = writeCommandOf(args);
          return def && !page.writes.includes(def.path.join(' ')) ? [def.path.join(' ')] : [];
        });
        expect([...new Set(unlisted)]).toEqual([]);
      });

      it('every `toil <host> …` line is a real command with real flags on each host it names', () => {
        const lines = invocations(page.text).filter((args) => args[0] === '<host>');
        if (lines.length) expect(hosts.length, '`<host>` needs `needs.any`').toBeGreaterThan(0);
        const bad = lines.flatMap((args) =>
          hosts
            .map((h) => [`${h} ${args.slice(1).join(' ')}`, checkInvocation([h, ...args.slice(1)])] as const)
            .filter(([, problem]) => problem)
            .map(([line, problem]) => `toil ${line}: ${problem}`),
        );
        expect(bad).toEqual([]);
      });

      it('has done-when, a report and a never list, and points at the README rather than repeating it', () => {
        for (const heading of ['## Done when', '## Report', '## Never']) expect(page.text, heading).toContain(heading);
        expect(page.text).toContain('`workflows/README.md`');
      });

      it('is listed once in the By job block of SKILL.md', () => {
        expect(blockLines(index).filter((l) => l.includes(`\`workflows/${file}\``))).toHaveLength(1);
      });
    });
  }

  it('every line of the By job block points at a page that exists, and every page has a line', () => {
    const named = blockLines(index).map((l) => /^- `(workflows\/[a-z0-9-]+\.md)`: \S/.exec(l)?.[1]);
    expect(named.every(Boolean), 'each line is "- `workflows/<job>.md`: when to read it"').toBe(true);
    for (const path of named) expect(existsSync(join(dir, path!)), `${path} is listed but missing`).toBe(true);
    expect([...named].sort()).toEqual(pageFiles.map((f) => `workflows/${f}`).sort());
    expect(index).toContain('`workflows/README.md`');
  });

  it('the checks bite: a write is found, a verb a host lacks and a flag it lacks are caught', () => {
    expect(writeCommandOf(['github', 'pr', 'comment', '1', '--body', 'x'])?.path.join(' ')).toBe('github pr comment');
    expect(writeCommandOf(['--select', 'x', 'wait', '--', 'github', 'pr', 'get', '1'])).toBeUndefined();
    expect(checkInvocation(['bitbucket', 'pr', 'threads', '1'])).toMatch(/threads/);
    expect(checkInvocation(['github', 'pr', 'comment-inline', '1', '--line-type', 'x'])).toMatch(/--line-type/);
  });
});

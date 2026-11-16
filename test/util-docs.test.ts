import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aliasPaths, toolName, type AnyCommand } from '../src/core/command.js';
import { commands } from '../src/registry.js';
import { checkInvocation, invocations, program, subcommand } from './harness/cli-lines.js';

/**
 * The `util` commands are documented once, in skills/toil/util.md, which
 * agents read and /docs/utilities/ renders for people
 * (site/src/pages/docs/utilities.astro, with each command's flags, aliases and
 * MCP tool from the registry). This holds the file to the registry in both
 * directions, the way the skill and site-commands suites hold the
 * integrations: a registered command with no example, table row or line under
 * **By job** fails, a row or line for a command that doesn't exist fails, and
 * every example is walked down the real command tree, so changing a flag shows
 * up here as a stale example. The page template's tags are counted too. Each
 * check is a function, and the last block feeds each one a deliberately broken
 * copy, so a check that stopped biting would fail rather than pass quietly.
 * Documentation that agrees with the software is rarer than it should be, so
 * this one is filed in triplicate, and then the other two copies were shredded.
 */
const root = join(import.meta.dirname, '..');
const pageFile = join(root, 'site', 'src', 'pages', 'docs', 'utilities.astro');
const skillFile = join(root, 'skills', 'toil', 'util.md');

const utilDefs = commands.filter((d) => d.kind === 'standalone' && d.path[0] === 'util');
/** A util command's name on the page and in util.md: its path under `toil util`. */
const utilName = (def: AnyCommand) => def.path.slice(1).join(' ');
const registered = utilDefs.map(utilName);

/** Every CLI path a command answers at, its own and its aliases', to the command. */
const byPath = new Map<string, AnyCommand>();
for (const def of commands) for (const path of [def.path, ...aliasPaths(def)]) byPath.set(path.join(' '), def);

/** The registry command a `toil …` line runs, or undefined when it names a group or nothing. */
function landsOn(args: string[]): AnyCommand | undefined {
  let cmd: Command = program;
  const path: string[] = [];
  for (const word of args) {
    if (word.startsWith('-')) continue;
    const sub = subcommand(cmd, word);
    if (!sub) break;
    cmd = sub;
    path.push(sub.name());
    if (!sub.commands.length) break;
  }
  return byPath.get(path.join(' '));
}

/** The `toil …` invocations in one shell line, as `invocations` reads a code block. */
const lineInvocations = (line: string) => invocations(`\`\`\`bash\n${line}\n\`\`\``);
/** The `toil …` invocations in a Markdown file's shell code blocks only, not its inline code. */
function fencedInvocations(text: string): string[][] {
  const shell: string[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const opens = /^```(\w*)/.exec(line);
    if (opens) fence = fence === undefined ? opens[1] : undefined;
    else if (fence !== undefined && ['bash', 'sh', 'shell', ''].includes(fence)) shell.push(line);
  }
  return shell.flatMap((line) => lineInvocations(line));
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Unbalanced tags in an Astro template, by line: every element opened is closed, in order. Frontmatter, styles and scripts are skipped. */
export function tagProblems(astro: string): string[] {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const template = astro
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<script[\s\S]*?<\/script>/g, blank);
  const lineOf = (index: number) => template.slice(0, index).split('\n').length;
  const out: string[] = [];
  const open: Array<{ name: string; line: number }> = [];
  // Attribute values are skipped whole, so a quoted `<b>` or a `{`#${id}`}` inside a tag isn't read as markup.
  for (const m of template.matchAll(/<(\/?)([A-Za-z][\w.-]*)\b(?:"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\}|[^<>"'{}])*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    const line = lineOf(m.index);
    if (selfClosing || VOID.has(name!.toLowerCase())) continue;
    if (!closing) {
      open.push({ name: name!, line });
      continue;
    }
    const top = open.pop();
    if (!top) out.push(`line ${line}: </${name}> closes nothing`);
    else if (top.name !== name) out.push(`line ${line}: </${name}> closes <${top.name}> from line ${top.line}`);
  }
  for (const { name, line } of open) out.push(`line ${line}: <${name}> is never closed`);
  return out;
}

/**
 * Problems with skills/toil/util.md: every command needs a shell example that
 * runs it, the alias table has one row per command with its real aliases and
 * MCP tool, and every `toil util …` the file shows is a real command or group.
 */
export function skillProblems(doc: string, defs: AnyCommand[]): string[] {
  const out: string[] = [];
  const names = defs.map(utilName);
  const ran = new Set(fencedInvocations(doc).map((args) => landsOn(args)).filter((d) => d?.path[0] === 'util').map((d) => utilName(d!)));
  for (const name of names) if (!ran.has(name)) out.push(`util.md: toil util ${name} has no example in a shell code block`);

  for (const args of invocations(doc)) {
    if (args[0] !== 'util') continue;
    const problem = checkInvocation(args);
    if (problem) out.push(`util.md: toil ${args.join(' ')}: ${problem}`);
  }

  const rows = new Map<string, { alias: string; tool: string }>();
  for (const m of doc.matchAll(/^\| `toil util ([^`]+)` \| ([^|]*?) \| `([^`]+)` \|$/gm)) rows.set(m[1]!, { alias: m[2]!.trim(), tool: m[3]! });
  for (const [name] of rows) if (!names.includes(name)) out.push(`util.md: the command table lists toil util ${name}, which isn't a registered command`);
  for (const def of defs) {
    const row = rows.get(utilName(def));
    if (!row) {
      out.push(`util.md: the command table has no row for toil util ${utilName(def)}`);
      continue;
    }
    const aliases = aliasPaths(def).map((a) => `\`toil ${a.join(' ')}\``).join(', ') || 'none';
    if (row.alias !== aliases) out.push(`util.md: toil util ${utilName(def)}'s alias cell is "${row.alias}", the registry says ${aliases}`);
    if (row.tool !== toolName(def)) out.push(`util.md: toil util ${utilName(def)}'s MCP tool is ${toolName(def)}, not ${row.tool}`);
  }
  return out;
}

/**
 * Problems with util.md's **By job** section: every registered command sits
 * under exactly one job, each named as `toil util <command>` in a bullet's
 * parentheses, and nothing that isn't a command is listed.
 */
export function byJobProblems(doc: string, names: string[]): string[] {
  const at = doc.indexOf('\n## By job\n');
  if (at < 0) return ['util.md: no "## By job" section'];
  const end = doc.indexOf('\n## ', at + 1);
  const section = doc.slice(at, end < 0 ? undefined : end);
  const listed: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const cell = /^- \*\*[^*]+\*\* \(([^)]*)\):/.exec(line)?.[1];
    if (cell) for (const m of cell.matchAll(/`toil util ([^`]+)`/g)) listed.push(m[1]!);
  }
  const out: string[] = [];
  for (const name of names) {
    const n = listed.filter((x) => x === name).length;
    if (n === 0) out.push(`util.md: toil util ${name} is under no job in By job`);
    if (n > 1) out.push(`util.md: toil util ${name} is under By job more than once`);
  }
  for (const name of new Set(listed)) if (!names.includes(name)) out.push(`util.md: By job lists toil util ${name}, which isn't a registered command`);
  return out;
}

const read = (path: string) => readFileSync(path, 'utf8');

describe('util docs coverage', () => {
  it('finds util commands to check', () => {
    expect(registered.length).toBeGreaterThan(10);
  });

  it('util.md lists every registered util command under exactly one job, and no command that does not exist', () => {
    expect(byJobProblems(read(skillFile), registered)).toEqual([]);
  });

  it("the page template's tags are balanced", () => {
    expect(tagProblems(read(pageFile))).toEqual([]);
  });

  it('skills/toil/util.md covers every util command, with an example, and its alias table matches the registry', () => {
    expect(skillProblems(read(skillFile), utilDefs)).toEqual([]);
  });
});

describe('util docs coverage catches a broken copy', () => {
  it('a registered command missing from By job, listed twice, or one that does not exist', () => {
    const doc = read(skillFile);
    expect(byJobProblems(doc, [...registered, 'frobnicate'])).toContain('util.md: toil util frobnicate is under no job in By job');
    const twice = doc.replace('- **Sizing before reading** (`toil util size`)', '- **Sizing before reading** (`toil util size`, `toil util size`)');
    expect(byJobProblems(twice, registered)).toContain('util.md: toil util size is under By job more than once');
    const extra = doc.replace('- **Sizing before reading** (`toil util size`)', '- **Sizing before reading** (`toil util size`, `toil util sizes`)');
    expect(byJobProblems(extra, registered)).toContain("util.md: By job lists toil util sizes, which isn't a registered command");
  });

  it('unbalanced tags in the template', () => {
    const page = read(pageFile);
    expect(tagProblems(page.replace('</SkillPage>', ''))).not.toEqual([]);
    expect(tagProblems('---\nconst a = 1;\n---\n<section><p>x</p>\n<section></section>')).toEqual(['line 4: <section> is never closed']);
    expect(tagProblems('<div><p></div>')).toEqual(['line 1: </div> closes <p> from line 1', 'line 1: <div> is never closed']);
  });

  it('util.md missing a command, or listing one that does not exist', () => {
    const doc = read(skillFile);
    const fake = { ...utilDefs[0]!, path: ['util', 'frobnicate'], aliases: undefined } as AnyCommand;
    expect(skillProblems(doc, [...utilDefs, fake])).toEqual(
      expect.arrayContaining(['util.md: toil util frobnicate has no example in a shell code block', 'util.md: the command table has no row for toil util frobnicate']),
    );
    const extra = doc.replace('| `toil util cert` |', '| `toil util certs` | none | `util_certs` |\n| `toil util cert` |');
    expect(skillProblems(extra, utilDefs)).toContain('util.md: the command table lists toil util certs, which isn\'t a registered command');
  });

  it('util.md with a stale example or a stale alias', () => {
    const doc = read(skillFile);
    expect(skillProblems(doc.replace('toil util log --input-file console.log --level error --context 3', 'toil util log --input-file console.log --level error --contxt 3'), utilDefs).join('\n')).toMatch(/--contxt/);
    expect(skillProblems(doc.replace('| `toil util jwt decode` | `toil jwt decode` |', '| `toil util jwt decode` | none |'), utilDefs).join('\n')).toMatch(/alias cell is "none"/);
  });
});

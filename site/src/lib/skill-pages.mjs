// The toil skill (skills/toil/*.md) is the documentation: the docs pages render
// those files and keep no prose of their own (#202). This module is what the
// pages and astro.config.mjs share: which page each file is, read straight
// from the folder at build time, so a new area's file gets its page without
// anyone writing one, and a remark plugin that turns the files' references
// to each other (`core.md`, `jira.md`) into links to those pages.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const skillDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'toil');

/** Files that have a page of their own rather than an integration page. */
const OWN_PAGES = {
  'SKILL.md': '/docs/',
  'core.md': '/docs/core/',
  'projects.md': '/docs/projects/',
  'install.md': '/docs/install/',
  'mcp.md': '/docs/mcp/',
  'setup.md': '/docs/setup/',
  'upgrading.md': '/docs/upgrading/',
  'db.md': '/connect/db/',
  'util.md': '/docs/utilities/',
  'skills.md': '/docs/skills/',
};

/** Every Markdown file under the skill, as a forward-slash path from its folder (the workflow pages are in `workflows/`). */
function markdownFiles(prefix) {
  return readdirSync(join(skillDir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownFiles(`${prefix}${e.name}/`) : e.name.endsWith('.md') ? [`${prefix}${e.name}`] : [],
  );
}

/** The page of a workflow file: the README is the index at /docs/workflows/, each job is /docs/workflows/<job>/. */
function workflowPath(file) {
  if (!file.startsWith('workflows/')) return undefined;
  const job = file.slice('workflows/'.length, -'.md'.length);
  return job === 'README' ? '/docs/workflows/' : `/docs/workflows/${job}/`;
}

/** The workflow job pages (not the README), for the index that lists them. */
export function workflowFiles() {
  return skillFiles.filter((f) => f.file.startsWith('workflows/') && f.file !== 'workflows/README.md');
}

/** `key: value` frontmatter lines. */
function frontmatterOf(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  const out = {};
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const at = line.indexOf(': ');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 2).trim();
  }
  return out;
}

/** The first level-one heading outside a code fence. */
function firstHeading(text) {
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && line.startsWith('# ')) return line.slice(2).trim();
  }
  return undefined;
}

/**
 * Every file in the skill: its page, its frontmatter, and its title (the first
 * heading, without the `(\`area\`)` the agent-facing copy carries).
 */
export const skillFiles = markdownFiles('')
  .sort()
  .map((file) => {
    const text = readFileSync(join(skillDir, file), 'utf8');
    const meta = frontmatterOf(text);
    const heading = firstHeading(text) ?? file;
    const title = heading.replace(/\s*\(`[^`]+`\)\s*$/, '').replace(/`/g, '');
    const path = OWN_PAGES[file] ?? workflowPath(file) ?? (meta.area ? `/connect/${meta.area}/` : undefined);
    return { file, area: meta.area, description: meta.description ?? '', title, path };
  });

/** The site path of a skill file's page, or undefined when it has none. */
export function pagePath(file) {
  return skillFiles.find((f) => f.file === file)?.path;
}

/** The areas whose file is an integration page: every area file without a page of its own. */
export const integrationFiles = skillFiles.filter((f) => f.area && !(f.file in OWN_PAGES));

/** Command groups whose commands a page other than their area's documents. */
const GROUP_PAGES = { skill: '/docs/skills/#commands-at-a-glance', projects: '/docs/projects/' };

/**
 * The page that documents a command group (the first word after `toil`): its
 * area's page at the commands list, or undefined when no page does. The
 * command index and the site search both link a command there.
 */
export function commandGroupPage(group) {
  if (group in GROUP_PAGES) return GROUP_PAGES[group];
  const path = skillFiles.find((f) => f.area === group && f.path)?.path;
  return path ? `${path}#commands-at-a-glance` : undefined;
}

/** Toil UI's own docs, outside the toil skill (ui/docs/*.md): each is a page, by its file. */
export const uiDocDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ui', 'docs');
export const UI_DOC_PAGES = { 'themes.md': '/docs/themes/', 'help.md': '/docs/ui-help/' };

/** Where the diagrams a skill file places live: `site/src/figures/<name>.html`. */
export const figureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'figures');
/** A skill file places a figure with a comment on its own line, which agents read past. */
export const FIGURE = /^<!--\s*figure:\s*([a-z0-9-]+)\s*-->$/;

/**
 * A figure's markup, with `{base}` replaced by the site's base path. A name with
 * no file fails the build, so a typo can't ship a page with a hole in it.
 * A missing figure is reported at build time, which is sooner than most missing attachments.
 */
export function figureHtml(name, base) {
  const file = join(figureDir, `${name}.html`);
  if (!existsSync(file)) throw new Error(`A skill file places figure "${name}", and site/src/figures/${name}.html doesn't exist.`);
  return readFileSync(file, 'utf8').replaceAll('{base}', base);
}

/**
 * A remark plugin: inline code naming another file of the skill (`core.md`)
 * becomes a link to its page, and each file's own first heading is dropped,
 * since the page hero shows it. A `<!-- figure: <name> -->` line becomes that
 * diagram (`figureHtml`). Agents read the same text with the file names.
 * Toil UI's README (ui/README.md: its npm page, and /docs/ui/) loses its first
 * heading the same way, and keeps its links as written; Toil UI's own docs
 * (ui/docs/*.md, such as /docs/themes/) do the same and place figures.
 */
export function remarkSkillLinks({ base }) {
  return () => (tree, file) => {
    const path = String(file.path ?? file.history?.[0] ?? '').replace(/\\/g, '/');
    // The changelog (/about/changelog/) is treated like the README: its heading is the page's hero.
    const readme = path.endsWith('/ui/README.md') || path.endsWith('/CHANGELOG.md');
    // Toil UI's own docs (ui/docs/*.md, such as /docs/themes/) place figures too, and keep their links as written.
    const uiDoc = path.includes('/ui/docs/');
    if (!path.includes('/skills/toil/') && !readme && !uiDoc) return;
    const first = tree.children.findIndex((n) => n.type === 'heading' && n.depth === 1);
    if (first >= 0) tree.children.splice(first, 1);
    if (readme) return;
    tree.children = tree.children.map((node) => {
      const name = node.type === 'html' ? FIGURE.exec(node.value.trim())?.[1] : undefined;
      return name ? { type: 'html', value: figureHtml(name, base) } : node;
    });
    if (uiDoc) return;
    const walk = (node) => {
      if (!node.children || node.type === 'link') return;
      node.children = node.children.map((child) => {
        const path = child.type === 'inlineCode' ? pagePath(child.value) : undefined;
        if (path) return { type: 'link', url: `${base}${path}`, children: [child] };
        walk(child);
        return child;
      });
    };
    walk(tree);
  };
}

/** The plain text inside a hast node. */
const textOf = (node) => (node.type === 'text' ? node.value : (node.children ?? []).map(textOf).join(''));

/**
 * A rehype plugin: every table in the rendered docs sits in its own scroller,
 * so a wide one scrolls inside the page rather than widening it, and the
 * scroller can be reached and scrolled with the keyboard, named by the
 * table's first heading (#277).
 */
export function rehypeScrollTables() {
  return () => (tree) => {
    const walk = (node) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        if (child.type === 'element' && child.tagName === 'table') {
          const head = findFirst(child, 'th');
          const first = head ? textOf(head).trim().slice(0, 60) : '';
          return { type: 'element', tagName: 'div', properties: { className: ['table-scroll'], tabIndex: 0, role: 'region', ariaLabel: first ? `Table: ${first}` : 'Table' }, children: [child] };
        }
        walk(child);
        return child;
      });
    };
    walk(tree);
  };
}

function findFirst(node, tag) {
  for (const child of node.children ?? []) {
    if (child.type === 'element' && child.tagName === tag) return child;
    const found = findFirst(child, tag);
    if (found) return found;
  }
  return null;
}

// The toil map (#432): who asks toil, toil, and everything it reaches. The
// reach side is /connect/'s catalogue as it stands (categories in
// integrations.ts), so a new area's board file puts it on the map with no edit
// here. The ask side is the three ways in, each pointing at a page the docs
// path (docs-path.mjs) or the site already lists; a link that stops resolving
// fails the build's link check. An inventory kept by hand is accurate exactly
// once, on the day it is typed.

import { categories, levels, type Status } from './integrations';
import { docsPath } from './docs-path.mjs';

export interface MapNode {
  /** What the chip says: the area or engine a reader types. */
  text: string;
  /** The longer name, read by screen readers and shown in the label. */
  name: string;
  /** The short label shown under the name on hover, focus or a first tap. */
  label: string;
  /** Site-relative, as url() takes it. */
  href: string;
  status?: Status;
}

export interface MapLane {
  id: string;
  title: string;
  nodes: MapNode[];
}

export interface MapCategory {
  id: string;
  title: string;
  /** The category's own section of /connect/. */
  href: string;
  blurb: string;
  nodes: MapNode[];
}

/** A docs-path link by its address, so the map can't point somewhere the docs don't. */
function docsLink(href: string): { label: string; href: string } {
  const link = docsPath.flatMap((g) => g.links).find((l) => l.href === href);
  if (!link) throw new Error(`site/src/data/map.ts: ${href} is not on the docs path (site/src/data/docs-path.mjs).`);
  return link;
}

const node = (text: string, name: string, href: string, label: string): MapNode => ({ text, name, label, href });

/** The three ways in, and what each one uses. */
export const lanes: MapLane[] = [
  {
    id: 'agents',
    title: 'AI agents',
    nodes: [
      node('skill', 'The toil skill', '/docs/install/#installing-this-skill', 'Read a page at a time, not every schema up front'),
      node('MCP', 'MCP', docsLink('/docs/mcp/').href, 'toil mcp, serving only the areas you choose'),
    ],
  },
  {
    id: 'people',
    title: 'People',
    nodes: [
      node('menu', 'The welcome menu', docsLink('/docs/welcome/').href, 'Bare toil opens it in your terminal'),
      node('Toil UI', 'Toil UI', '/ui/', 'A dashboard per toil project, in your browser'),
    ],
  },
  {
    id: 'ci',
    title: 'CI/CD',
    nodes: [
      node('env vars', 'Env vars', '/docs/core/#configuration', 'Every connection set from the environment'),
      node('JSON', 'The JSON envelope', '/docs/core/#the-envelope-and-errors', 'One envelope shape from every command'),
    ],
  },
];

/** What sits inside toil on the full map: pages from the docs path for organising work, local tools and the limits. */
export const inside: MapNode[] = [
  { text: 'toil projects', href: '/docs/projects/', label: 'What a body of work holds: repos, keys, environments' },
  { text: 'util', href: '/docs/utilities/', label: 'Local tools, with no server and no sign-in' },
  { text: 'bounds', href: '/docs/core/#files-and-the-workspace', label: 'The limits every command is held to' },
].map((n) => ({ ...n, name: docsLink(n.href).label }));

/** Everything toil reaches, grouped and ordered exactly as /connect/ shows it. */
export const reach: MapCategory[] = categories.map((c) => ({
  id: c.id,
  title: c.title,
  href: `/connect/#${c.id}`,
  blurb: c.blurb,
  nodes: c.items.map((i) => {
    const text = i.tag.replace(/^toil /, '').replace(/^engine: /, '');
    return { text, name: i.name, label: `${i.status} · ${i.credential}`, href: i.href, status: i.status };
  }),
}));

/** The verification levels, lowest first, for the full map's filter. */
export const mapLevels: Status[] = levels.map((l) => l.name);

export const reachCount = reach.reduce((n, c) => n + c.nodes.length, 0);

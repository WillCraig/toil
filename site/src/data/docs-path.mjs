// The docs as a path, in the order a newcomer reads them (#431): get it
// running, use it, connect it, hand it to an agent, open Toil UI, then the
// reference. The docs index draws these groups, every docs page takes its
// breadcrumb from the group it's in, and the previous and next links walk the
// pages in this order. A link with a hash is a section of a page listed
// elsewhere, so the walk skips it, and a link outside /docs/ is a signpost to
// a page with a walk of its own (/connect/). Every page in its proper queue.
// Plain JavaScript with its types in docs-path.d.mts, so the repository's own
// tests can import it without the site's packages installed.

export const docsPath = [
  {
    id: 'get-started',
    title: 'Get started',
    links: [
      { label: 'Install', href: '/docs/install/' },
      { label: 'Set up with your agent', href: '/docs/setup/' },
      { label: 'The welcome menu', href: '/docs/welcome/' },
      { label: 'Your first toil project', href: '/docs/projects/#create' },
    ],
  },
  {
    id: 'use',
    title: 'Use',
    links: [
      { label: 'Toil projects', href: '/docs/projects/' },
      { label: 'Utilities', href: '/docs/utilities/' },
      { label: 'Local git', href: '/connect/git/' },
      { label: 'Dependency checks', href: '/connect/#dependency-checks' },
    ],
  },
  {
    id: 'connect',
    title: 'Connect',
    links: [
      { label: 'Integrations and databases', href: '/connect/' },
      { label: 'Databases', href: '/connect/db/' },
    ],
  },
  {
    id: 'agents',
    title: 'Agents',
    links: [
      { label: 'MCP', href: '/docs/mcp/' },
      { label: 'Skills', href: '/docs/skills/' },
      { label: 'Workflows', href: '/docs/workflows/' },
      { label: 'Upgrading', href: '/docs/upgrading/' },
      { label: 'From a program (./api)', href: '/docs/core/#using-toil-from-a-program' },
    ],
  },
  {
    id: 'toil-ui',
    title: 'Toil UI',
    links: [
      { label: 'Toil UI', href: '/docs/ui/' },
      { label: 'Themes', href: '/docs/themes/' },
      { label: 'Help and edit links', href: '/docs/ui-help/' },
    ],
  },
  {
    id: 'reference',
    title: 'Reference',
    links: [
      { label: 'Using toil', href: '/docs/core/' },
      { label: 'Bounds', href: '/docs/core/#files-and-the-workspace' },
      { label: 'Command index', href: '/docs/commands/' },
    ],
  },
];

// Start here, by role (#433): the homepage's Get started section shows these
// beside the two ways to install. Each step is a page or a heading the docs
// already have, so a path is a reading order, never a new page; check-links
// fails the build when a step stops landing. Three roles, three steps each:
// the org chart, abridged.
export const startPaths = [
  {
    id: 'agent',
    role: 'You work with an agent',
    steps: [
      { label: 'Install toil', href: '/docs/install/' },
      { label: 'Add the skill', href: '/docs/install/#installing-this-skill' },
      { label: 'Ask it to set up toil', href: '/docs/setup/' },
    ],
  },
  {
    id: 'lead',
    role: 'You lead a team',
    steps: [
      { label: 'Run Toil UI', href: '/docs/ui/#start-it' },
      { label: 'Onboard to a toil project', href: '/docs/projects/#onboarding-to-a-repo-that-has-a-toil-project' },
      { label: 'Press Analyze', href: '/docs/ui/#the-agent' },
    ],
  },
  {
    id: 'ci',
    role: 'You run CI/CD',
    steps: [
      { label: 'Connections from env vars', href: '/docs/core/#configuration' },
      { label: 'The JSON envelope', href: '/docs/core/#the-envelope-and-errors' },
      { label: 'Read-only by default', href: '/docs/core/#writes' },
    ],
  },
];

/** Every whole docs page, in reading order, each once. */
export const docsWalk = docsPath.flatMap((group) => group.links.filter((l) => l.href.startsWith('/docs/') && !l.href.includes('#')).map((l) => ({ ...l, group })));

/** Where a docs page sits: its group, and the pages before and after it. The index itself leads to the first page. */
export function docsPlace(path) {
  if (path === '/docs/') return { next: docsWalk[0] };
  const at = docsWalk.findIndex((s) => s.href === path);
  if (at < 0) return {};
  return { stop: docsWalk[at], prev: at === 0 ? { label: 'Docs', href: '/docs/' } : docsWalk[at - 1], next: docsWalk[at + 1] };
}

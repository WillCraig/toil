import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetLearningLinks, setLearningLinks } from '../src/learning.ts';
import { GLOSSARY_SLUGS } from './glossary-terms.ts';
import { openChat } from './chat.ts';
import { App, parseRoute, upgradeHash } from '../src/App.tsx';
import { EditLink, Help } from '../src/components/help.tsx';
import { plainify } from '../src/plain-words.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { LEARN_LINKS, LEARN_SITE as CLI_LEARN_SITE } from '../../src/welcome/learn.ts';
import { DOCS_SITE, HELP, LEARN, LEARN_SITE, glossaryHref, helpHref, learnHref, slugOf, viewHelpHref, type HelpTopic, type HelpView } from '../src/help.ts';
import { UI_DOC_PAGES, skillFiles, skillDir, uiDocDir } from '../../site/src/lib/skill-pages.mjs';

/**
 * Help topics and edit links (#346). Every Read more link has to land on a
 * real heading, so each topic's page is mapped to the markdown it renders and
 * its anchor is looked for among that file's headings, slugged the way the
 * site's build slugs them (github-slugger). The site build checks the same
 * links again against the HTML it built (site/scripts/check-help-links.mjs).
 */

const root = join(import.meta.dirname, '..', '..');

/** The markdown file a docs page renders. */
function sourceOf(page: string): string {
  if (page === '/docs/ui/') return join(root, 'ui', 'README.md');
  const ui = Object.entries(UI_DOC_PAGES).find(([, p]) => p === page)?.[0];
  if (ui) return join(uiDocDir, ui);
  const skill = skillFiles.find((f) => f.path === page);
  if (skill) return join(skillDir, skill.file);
  throw new Error(`No docs page renders ${page}`);
}

/** A heading's id as github-slugger makes it: lower case, punctuation and symbols dropped, spaces to hyphens, repeats numbered. */
function headingIds(markdown: string): string[] {
  const seen = new Map<string, number>();
  const ids: string[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('```')) fenced = !fenced;
    const m = fenced ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    ids.push(n ? `${base}-${n}` : base);
  }
  return ids;
}

describe('the help topics', () => {
  it('slugs headings the way the site does', () => {
    expect(headingIds("## Toil's configuration\n## Verify before you open a PR: `npm run verify:ui`\n## Worklog\n### Worklog")).toEqual(['toils-configuration', 'verify-before-you-open-a-pr-npm-run-verifyui', 'worklog', 'worklog-1']);
  });

  it.each(Object.entries(HELP))('%s links to a heading that exists', (_, topic) => {
    expect(headingIds(readFileSync(sourceOf(topic.page), 'utf8'))).toContain(topic.anchor);
    expect(helpHref(topic)).toBe(`${DOCS_SITE}${topic.page}#${topic.anchor}`);
  });

  it('keeps each topic to one or two sentences', () => {
    for (const [id, t] of Object.entries(HELP)) expect(t.text.split(/(?<=[.!?])\s+(?=[A-Z])/).length, id).toBeLessThanOrEqual(2);
  });

  it("gives every view the header's Help opens a topic", () => {
    const views: HelpView[] = ['toilProjects', 'dashboard', 'prs', 'people', 'command-center', 'worklog', 'standup', 'item', 'assignment', 'settings'];
    for (const v of views) expect(viewHelpHref(v)).toMatch(new RegExp(`^${DOCS_SITE}/docs/[a-z-]+/#[a-z0-9-]+$`));
    expect(viewHelpHref('settings', 'agent')).toBe(helpHref(HELP.agent));
  });
});

/** What the (i) shows for a topic: its sentences in plain words, with the topic's plain note after them. */
const shown = (t: HelpTopic) => plainify(t.text) + (t.plainNote ? ` ${t.plainNote}` : '');

describe('the (i)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('names its topic, shows its sentences on focus, and opens them with Read more when pressed', async () => {
    render(<Help topic="worklog" />);
    const button = screen.getByRole('button', { name: 'About the worklog' });
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(shown(HELP.worklog)));
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'About the worklog' });
    expect(within(dialog).getByText(shown(HELP.worklog))).toBeTruthy();
    const link = within(dialog).getByRole('link', { name: /^Read more/ });
    expect(link.getAttribute('href')).toBe('https://imagile-dev.github.io/toil/docs/ui/#worklog');
    expect(link.textContent).toBe('Read more about the worklog in the docs (opens in a new tab)');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('the (i) in plain words (#552)', () => {
  it('swaps the jargon in the one catalogue as it draws it, name and sentences alike', async () => {
    localStorage.clear();
    render(<Help topic="prs" />);
    const button = screen.getByRole('button', { name: 'About code reviews' });
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe("Read from every code host the Toil project names, the open ones ranked by how long each has waited and on what. Flow figures are the team's, never one person's."));
  });
});

describe('edit links', () => {
  it('is a link with the name it was given, and nothing else', () => {
    render(<EditLink href="#/settings/connections/corp-jira" label="Edit the corp-jira connection" />);
    const link = screen.getByRole('link', { name: 'Edit the corp-jira connection' });
    expect(link.getAttribute('href')).toBe('#/settings/connections/corp-jira');
  });

  it('routes a settings page to the place an edit link names', () => {
    expect(parseRoute('#/settings/connections/corp-jira')).toEqual({ view: 'settings', page: 'connections', at: ['corp-jira'] });
    expect(parseRoute('#/settings/projects/card-payments/wip')).toEqual({ view: 'settings', page: 'projects', at: ['card-payments', 'wip'] });
    expect(parseRoute('#/settings/usage/rates')).toEqual({ view: 'settings', page: 'usage', at: ['rates'] });
    expect(parseRoute('#/settings/agent-usage/rates')).toEqual({ view: 'settings', page: 'usage', at: ['rates'] });
    // The caps card held the rates, so its old addresses land on them.
    expect(parseRoute('#/settings/usage/caps')).toEqual({ view: 'settings', page: 'usage', at: ['rates'] });
    expect(parseRoute('#/settings/agent-usage/caps')).toEqual({ view: 'settings', page: 'usage', at: ['rates'] });
    expect(parseRoute('#/settings/agent/caps')).toEqual({ view: 'settings', page: 'usage', at: ['rates'] });
    expect(parseRoute('#/settings/agent')).toEqual({ view: 'settings', page: 'agent' });
    // General is first: the bare address, its own and the old one all open it.
    expect(parseRoute('#/settings')).toEqual({ view: 'settings', page: 'general' });
    expect(parseRoute('#/settings/general')).toEqual({ view: 'settings', page: 'general' });
    expect(parseRoute('#/settings/general')).toEqual({ view: 'settings', page: 'general' });
    expect(parseRoute('#/settings/projects')).toEqual({ view: 'settings', page: 'projects' });
    expect(parseRoute('#/settings/connections/100%')).toEqual({ view: 'settings', page: 'connections', at: ['100%'] });
  });

  it('still opens an address from before the rename, as the one it has now (#555)', () => {
    expect(upgradeHash('#/dossier/card-payments/board')).toBe('#/project/card-payments/board');
    expect(upgradeHash('#/dossier/card-payments?item=jira%3APAY-1')).toBe('#/project/card-payments?item=jira%3APAY-1');
    expect(upgradeHash('#/settings/dossiers/card-payments/wip')).toBe('#/settings/projects/card-payments/wip');
    expect(upgradeHash('#/dossiers')).toBe('#/');
    expect(upgradeHash('#/project/card-payments')).toBe('#/project/card-payments');
    expect(parseRoute('#/dossier/card-payments/prs')).toEqual({ view: 'prs', toilProject: 'card-payments' });
    expect(parseRoute('#/settings/dossiers')).toEqual({ view: 'settings', page: 'projects' });
  });

  it('rewrites an old address in the bar when the page opens on it', async () => {
    await open('#/dossier/card-payments');
    expect(window.location.hash).toBe('#/project/card-payments');
  });

  const open = async (hash: string) => {
    window.location.hash = hash;
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 });
  };

  it("lands on the connection it names, and says so when there's none", async () => {
    await open('#/settings/connections/corp-jira');
    await waitFor(() => expect(document.activeElement?.id).toBe('conn-corp-jira'));
    window.location.hash = '#/settings/connections/gone';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect((await screen.findByText(/There is no connection named/)).textContent).toContain('gone');
  });

  it('lands on the Toil project section it names, with that Toil project chosen', async () => {
    await open('#/settings/projects/checkout-web/wip');
    await waitFor(() => expect(document.activeElement?.id).toBe('toil-project-form-wip'));
    expect(document.activeElement?.textContent).toBe("Set checkout-web's work-in-progress limit");
  });

  it("puts a pencil on an item's connection and on the People view's limit, each opening its settings", async () => {
    await open(`#/project/card-payments/item/${encodeURIComponent('corp-jira:PAY-102')}`);
    expect(screen.getByRole('link', { name: 'Edit the corp-jira connection' }).getAttribute('href')).toBe('#/settings/connections/corp-jira');
    expect(screen.getByRole('link', { name: "Edit card-payments's field names" }).getAttribute('href')).toBe('#/settings/projects/card-payments/fields');
  });

  it('has a Help entry in the header for the view in front of you', async () => {
    setLearningLinks(false);
    await open('#/project/card-payments/people');
    await userEvent.click(screen.getByRole('button', { name: /^Help/ }));
    const menu = await screen.findByRole('menu', { name: 'Help' });
    expect(within(menu).getByRole('menuitem', { name: /^Help for this view/ }).getAttribute('href')).toBe(helpHref(HELP.people));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('link', { name: "Edit card-payments's work-in-progress limit" }).getAttribute('href')).toBe('#/settings/projects/card-payments/wip');
  });
});

describe('learning links (#418)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLearningLinks();
  });
  const entries = Object.entries(HELP).flatMap(([id, t]) => ((t as HelpTopic).glossary ?? []).map((g) => [id, g] as const));
  const terms = ['token', 'input-tokens', 'output-tokens', 'cache-tokens', 'model', 'model-provider', 'harness', 'mcp', 'tool-call', 'sandbox', 'permission-mode', 'human-in-the-loop', 'human-review', 'session', 'system-prompt', 'skill', 'hallucination', 'primary-source', 'non-determinism'];

  it("covers the issue's terms, each once, and every slug is one Context Overflow's glossary has", () => {
    expect(entries.map(([, g]) => g.slug).sort()).toEqual([...terms].sort());
    for (const [id, g] of entries) {
      expect(GLOSSARY_SLUGS, `${id}: ${g.slug}`).toContain(g.slug);
      expect(slugOf(g.term), id).toBe(g.slug);
      expect(glossaryHref(g)).toBe(`https://kolatts.github.io/context-overflow/glossary/${g.slug}`);
      expect(g.text, g.slug).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('slugs a term the way Context Overflow does', () => {
    expect(['Human-in-the-loop', 'AGENTS.md', 'Tool call', ' MCP '].map(slugOf)).toEqual(['human-in-the-loop', 'agents-md', 'tool-call', 'mcp']);
  });

  it('links Learn to the four modules, the same four the welcome menu prints', () => {
    expect(LEARN.map(learnHref)).toEqual(['getting-started', 'ai-fluency-101', 'autonomy-spectrum', 'git-time-machine'].map((m) => `https://kolatts.github.io/context-overflow/modules/${m}`));
    expect(CLI_LEARN_SITE).toBe(LEARN_SITE);
    expect(LEARN_LINKS.map(({ title, task, path }) => ({ title, task, path }))).toEqual(LEARN.map(({ title, task, path }) => ({ title, task, path })));
  });

  it("puts a topic's terms in its popover, each with Read more on Context Overflow, and none once the setting is off", async () => {
    const { unmount } = render(<Help topic="model-usage" />);
    await userEvent.click(screen.getByRole('button', { name: "About the AI agent's usage" }));
    const dialog = await screen.findByRole('dialog', { name: "About the AI agent's usage" });
    const list = within(dialog).getByRole('list', { name: "Terms, from Context Overflow's glossary" });
    expect(within(list).getAllByRole('listitem')[0]!.textContent).toBe('Token: The atomic unit a model reads and writes. Read more on Context Overflow about Token (opens in a new tab)');
    const link = within(list).getByRole('link', { name: /^Read more on Context Overflow ?about Cache tokens/ });
    expect(link.getAttribute('href')).toBe('https://kolatts.github.io/context-overflow/glossary/cache-tokens');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    unmount();
    setLearningLinks(false);
    render(<Help topic="model-usage" />);
    await userEvent.click(screen.getByRole('button', { name: "About the AI agent's usage" }));
    const plain = await screen.findByRole('dialog', { name: "About the AI agent's usage" });
    expect(plain.querySelector('[data-glossary]')).toBeNull();
    expect(plain.textContent).not.toContain('Context Overflow');
    expect(within(plain).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([helpHref(HELP['model-usage'])]);
  });

  const open = async (hash: string) => {
    window.location.hash = hash;
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 });
  };

  it("puts Learn in Help's menu, after the view's docs and What's new, and takes it out once the setting is off", async () => {
    await open('#/project/card-payments/people');
    await userEvent.click(screen.getByRole('button', { name: /^Help/ }));
    const menu = await screen.findByRole('menu', { name: 'Help' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.getAttribute('href'))).toEqual([helpHref(HELP.people), null, null, ...LEARN.map(learnHref)]);
    expect(items[1]!.textContent).toBe("What's new");
    expect(items[2]!.textContent).toBe('Keyboard shortcuts');
    for (const i of items.filter((x) => x.getAttribute('href'))) {
      expect(i.getAttribute('target')).toBe('_blank');
      expect(i.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(items[5]!.textContent).toBe('The Autonomy SpectrumDeciding how much to hand an agent (opens in a new tab)');
    await userEvent.keyboard('{Escape}');
    act(() => setLearningLinks(false));
    await userEvent.click(screen.getByRole('button', { name: /^Help/ }));
    const off = await screen.findByRole('menu', { name: 'Help' });
    expect(within(off).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Help for this view (opens in a new tab)', "What's new", 'Keyboard shortcuts']);
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('a[href*="context-overflow"], [data-learn-link], [data-learn]')).toBeNull();
  });

  it("keeps Learn out of the chat's guided start (the header's Help has it), and offers the answers' terms in its (i)", async () => {
    await open('#/project/checkout-web');
    const chat = await openChat('checkout-web');
    expect(within(chat).queryByRole('button', { name: 'Learn' })).toBeNull();
    await userEvent.click(within(chat).getByRole('button', { name: 'About these answers' }));
    const info = await screen.findByRole('dialog', { name: 'About these answers' });
    expect(within(info).getAllByRole('link', { name: /^Read more on Context Overflow/ }).map((a) => a.getAttribute('href'))).toEqual(HELP.answers.glossary.map(glossaryHref));
  });

  it('turns off from Settings, General, and is remembered in this browser', async () => {
    await open('#/settings/general');
    const box = screen.getByRole('checkbox', { name: 'Links to learning content' });
    expect(box).toHaveProperty('checked', true);
    await userEvent.click(box);
    expect(box).toHaveProperty('checked', false);
    expect(localStorage.getItem('toil-ui.learning')).toBe('off');
    expect(screen.getByRole('button', { name: /^Help/ })).toBeTruthy();
    resetLearningLinks();
    expect(screen.getByRole('checkbox', { name: 'Links to learning content' })).toHaveProperty('checked', false);
  });

  it('fetches and prefetches nothing from Context Overflow', async () => {
    const fetched: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return real(input);
    }) as typeof fetch;
    try {
      await open('#/settings/agent');
      await userEvent.click(screen.getAllByRole('button', { name: /^About the AI agent/ })[0]!);
      await screen.findByRole('dialog', { name: /^About the AI agent/ });
      expect(fetched.filter((u) => u.includes('context-overflow'))).toEqual([]);
      expect(document.querySelector('link[href*="context-overflow"]')).toBeNull();
    } finally {
      globalThis.fetch = real;
    }
  });

  it('names Context Overflow only in the help table', () => {
    const src = join(root, 'ui', 'src');
    const named = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|tsx|css|json)$/.test(f))
      .filter((f) => readFileSync(join(src, f), 'utf8').includes('kolatts.github.io'));
    expect(named.map((f) => f.replace(/\\/g, '/'))).toEqual(['help.ts']);
  });
});

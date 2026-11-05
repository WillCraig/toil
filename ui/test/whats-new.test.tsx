import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { current as BUILT, releases as BUILT_RELEASES } from 'virtual:whats-new';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { SEEN_KEY } from '../src/components/whats-new.tsx';
import { CHANGELOG_HREF, MAX_LINES, compareVersions, entryOf, latest, newSince, parseChangelog, parseSeen, type Release } from '../src/whats-new.ts';

/** What's new after an upgrade (#417): the release notes read at build time, and the dot on Help. */

const root = join(import.meta.dirname, '..', '..');
const SAMPLE = `# Changelog

## [0.2.0](https://github.com/imagile-dev/toil/compare/v0.1.0...v0.2.0) (2026-11-02)


### Features

* **ui:** a bell in the header ([#417](https://github.com/imagile-dev/toil/issues/417)) ([abc1234](https://github.com/imagile-dev/toil/commit/abc1234))
* onboard to a repo's Toil projects ([#369](https://github.com/imagile-dev/toil/issues/369)) ([797e884](https://github.com/imagile-dev/toil/commit/797e884))
* **site:** a new site map ([#434](https://github.com/imagile-dev/toil/issues/434)) ([0e83924](https://github.com/imagile-dev/toil/commit/0e83924))
* **jira:** transitions by intent ([#322](https://github.com/imagile-dev/toil/issues/322)) ([e155760](https://github.com/imagile-dev/toil/commit/e155760)), closes [#347](https://github.com/imagile-dev/toil/issues/347)


### Bug Fixes

* **ci:** Linux gates on PRs ([#377](https://github.com/imagile-dev/toil/issues/377)) ([74e44da](https://github.com/imagile-dev/toil/commit/74e44da))
* **ui:** show Plain's full header row ([#390](https://github.com/imagile-dev/toil/issues/390)) ([dff97b3](https://github.com/imagile-dev/toil/commit/dff97b3))


### Dependencies

* The following workspace dependencies were updated

## 0.1.0 (2026-10-19)


### Features

* **ci:** a release job ([#1](https://github.com/imagile-dev/toil/issues/1)) ([aaaaaaa](https://github.com/imagile-dev/toil/commit/aaaaaaa))
`;

describe('reading the release notes', () => {
  it("keeps each product's own lines, features first, without their links", () => {
    expect(parseChangelog(SAMPLE, 'ui')).toEqual([
      { product: 'ui', version: '0.2.0', date: '2026-11-02', lines: ['A bell in the header', "Show Plain's full header row"] },
      { product: 'ui', version: '0.1.0', date: '2026-10-19', lines: [] },
    ]);
    expect(parseChangelog(SAMPLE, 'toil')[0]!.lines).toEqual(["Onboard to a repo's Toil projects", 'Transitions by intent']);
  });

  it('reads a CRLF file the same, and a line as a person reads it', () => {
    expect(parseChangelog(SAMPLE.replace(/\n/g, '\r\n'), 'ui')).toEqual(parseChangelog(SAMPLE, 'ui'));
    expect(entryOf('* see [the docs](https://example.com) ([#1](https://x)) ([abc](https://y))')).toEqual({ scope: null, text: 'See the docs' });
    expect(entryOf('not an entry')).toBeNull();
  });

  it('keeps at most five lines a version', () => {
    const many = `## 1.0.0 (2026-01-01)\n\n### Features\n\n${Array.from({ length: 9 }, (_, i) => `* **ui:** thing ${i}`).join('\n')}\n`;
    expect(parseChangelog(many, 'ui')[0]!.lines).toHaveLength(MAX_LINES);
  });

  it("reads both packages' real changelogs, and the bundle holds what they say", () => {
    const ui = parseChangelog(readFileSync(join(root, 'ui', 'CHANGELOG.md'), 'utf8'), 'ui');
    const toil = parseChangelog(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), 'toil');
    expect(ui.length).toBeGreaterThan(0);
    expect(toil.length).toBeGreaterThan(0);
    for (const r of [...ui, ...toil]) {
      expect(r.lines.length).toBeLessThanOrEqual(MAX_LINES);
      for (const l of r.lines) expect(l).not.toMatch(/\]\(|https?:|\*\*/);
    }
    expect(BUILT_RELEASES).toEqual([...ui, ...toil]);
    const pkg = JSON.parse(readFileSync(join(root, 'ui', 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
    expect(BUILT).toEqual({ ui: pkg.version, toil: pkg.dependencies['@imagile-dev/toil'] });
  });
});

describe('versions', () => {
  it('orders releases as semver does, prereleases before their release', () => {
    const sorted = ['0.1.0', '0.1.0-alpha.10', '0.1.0-alpha.2', '0.0.9', '0.1.0-beta.1', '0.2.0'].sort(compareVersions);
    expect(sorted).toEqual(['0.0.9', '0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta.1', '0.1.0', '0.2.0']);
    expect(compareVersions('nonsense', '0.1.0')).toBe(0);
  });

  const r = (product: 'ui' | 'toil', version: string): Release => ({ product, version, date: null, lines: [] });
  const all = [r('ui', '0.1.0-alpha.4'), r('ui', '0.1.0-alpha.3'), r('ui', '0.1.0-alpha.2'), r('toil', '0.1.0-alpha.6'), r('toil', '0.1.0-alpha.5')];

  it("lists what came after the versions this browser saw, up to the ones it runs", () => {
    const now = { ui: '0.1.0-alpha.4', toil: '0.1.0-alpha.5' };
    expect(newSince(all, { ui: '0.1.0-alpha.2', toil: '0.1.0-alpha.5' }, now).map((x) => `${x.product}@${x.version}`)).toEqual(['ui@0.1.0-alpha.4', 'ui@0.1.0-alpha.3']);
    expect(newSince(all, null, now)).toEqual([]);
    expect(newSince(all, now, now)).toEqual([]);
    expect(latest(all, now).map((x) => `${x.product}@${x.version}`)).toEqual(['ui@0.1.0-alpha.4', 'toil@0.1.0-alpha.5']);
  });

  it('reads what this browser kept, and nothing from a damaged copy', () => {
    expect(parseSeen('{"ui":"0.1.0","toil":"0.2.0","x":1}')).toEqual({ ui: '0.1.0', toil: '0.2.0' });
    expect(parseSeen('{')).toBeNull();
    expect(parseSeen('[]')).toBeNull();
    expect(parseSeen(null)).toBeNull();
  });
});

describe("the dot on Help, and What's new", () => {
  beforeEach(() => localStorage.clear());

  const open = async (versions = BUILT) => {
    window.location.hash = '#/';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview versions={versions} />);
    await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  };
  const dot = () => document.querySelector('[data-help-link] [data-new-dot]');
  // The build's own newest Toil UI release, and one before it, so the test follows the changelog as it grows.
  const uiReleases = BUILT_RELEASES.filter((x) => x.product === 'ui');

  it('shows nothing on a first visit, and records what it runs on', async () => {
    await open();
    expect(dot()).toBeNull();
    expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual(BUILT);
  });

  it('puts a dot on Help after an upgrade, lists what changed, and takes the dot away once read', async () => {
    const [newest, older] = uiReleases;
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...BUILT, ui: older!.version }));
    await open({ ...BUILT, ui: newest!.version });
    expect(dot()).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Help, with something new/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^Help/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /What's new/ }));
    const list = await screen.findByRole('dialog', { name: "What's new" });
    expect(within(list).getByRole('heading', { level: 3 }).textContent).toContain(`Toil UI ${newest!.version}`);
    for (const l of newest!.lines) expect(list.textContent).toContain(l);
    expect(within(list).getByRole('link', { name: /Toil UI's full changelog/ }).getAttribute('href')).toBe(CHANGELOG_HREF.ui);
    expect(dot()).toBeNull();
    expect(JSON.parse(localStorage.getItem(SEEN_KEY)!)).toEqual({ ...BUILT, ui: newest!.version });
    await userEvent.click(within(list).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: "What's new" })).toBeNull();
  });

  it('shows the latest of each when nothing is new, and pops up over nothing on its own', async () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify(BUILT));
    await open();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Help/ }));
    await act(async () => userEvent.click(await screen.findByRole('menuitem', { name: /What's new/ })));
    const list = await screen.findByRole('dialog', { name: "What's new" });
    expect(list.textContent).toContain('Nothing new since this browser last looked.');
    expect(within(list).getAllByRole('heading', { level: 3 }).length).toBe(latest(BUILT_RELEASES, BUILT).length);
  });
});

/**
 * What every views-*.test.tsx shares: the fixture-backed App, its routes, axe
 * and the small finders (#206, #579). views.test.tsx was one file of 2,184
 * lines and two minutes; the worker pool does not read minutes, it reads files.
 * The split is its Form 27-B: one file per sitting of the committee, and the
 * committee is now allowed to sit at the same time.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { expect } from 'vitest';
import { App } from '../src/App.tsx';
import { type Agent } from '../src/agent.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import type { Execute } from '../src/toil.ts';
import type { ConfigApi } from '../src/config.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import type { AgentSettingsPanelProps } from '../src/agent-settings.tsx';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import type { WorklogApi } from '../src/worklog.ts';
import type { AnalysesApi } from '../src/analyses.ts';
import { fixtureAnalyses } from '../src/fixtures/analyses.ts';

export const item = (toilProject: string, id: string) => `#/project/${toilProject}/item/${encodeURIComponent(id)}`;
export const ROUTES = ['#/', '#/project/card-payments', '#/project/card-payments/board', '#/project/card-payments/dependencies', '#/project/card-payments/analyses', '#/project/card-payments/analyses/sample-analysis-2', '#/project/settlement', '#/project/checkout-web', '#/project/checkout-web/prs', '#/project/card-payments/prs', '#/project/checkout-web/people', '#/project/card-payments/people', '#/project/settlement/people', '#/project/card-payments/board/person%3AJ.%20Smith', '#/project/card-payments/worklog', '#/project/checkout-web/worklog/2026-10-12', item('card-payments', 'corp-jira:PAY-101'), '#/project/card-payments/command-center', '#/project/settlement/command-center', '#/settings', '#/settings/projects', '#/settings/general', '#/settings/usage', '#/settings/agent'];

export async function open(hash: string, { preview = true, execute = fixtureExecute().execute, agent = scriptedAgent(), config = fixtureConfig(), agentSettings, worklog = fixtureWorklog(), analyses = fixtureAnalyses() }: { preview?: boolean; execute?: Execute; agent?: Agent; config?: ConfigApi; agentSettings?: AgentSettingsPanelProps; worklog?: WorklogApi | null; analyses?: AnalysesApi | null } = {}) {
  window.location.hash = hash;
  const view = render(<App execute={execute} agent={agent} config={config} now={FIXTURE_NOW} preview={preview} {...(agentSettings ? { agentSettings } : {})} {...(worklog ? { worklog } : {})} {...(analyses ? { analyses } : {})} />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  return view;
}

/**
 * For a case that renders a whole view and runs axe over it (a dashboard is
 * about 1,600 elements in jsdom): about a second on a laptop, two to five on
 * a Windows runner (#328), so it gets more than Vitest's 5 s default.
 */
export const AXE_TIMEOUT = 20_000;

/**
 * axe's rules, less colour contrast, which jsdom can't compute (themes.test.ts checks the tokens).
 * Only violations are read, so axe skips building the passes (#328).
 */
export async function violations(container: HTMLElement) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Opens a route in a strict theme and expects axe to find nothing. */
export async function expectNoViolations(hash: string, theme: string) {
  localStorage.setItem('toil-ui.theme', JSON.stringify({ theme }));
  const { container } = await open(hash);
  expect(document.documentElement.dataset.theme).toBe(theme);
  expect(await violations(container)).toEqual([]);
}

export const panel = (name: string | RegExp) => screen.getByRole('region', { name });
/** A toil project's tab bar (#394). */
export const tabs = (toilProject: string) => screen.getByRole('navigation', { name: `${toilProject} views` });
/** Opens a metric's full chart from the Overview's strip (#394), and returns its dialog. */
export async function metric(name: RegExp) {
  await userEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('dialog');
}

/** Each file calls this in a `beforeEach`: a fresh browser, no saved theme. */
export function resetBrowserState() {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
}

/** A settings client's install calls, for a test that never presses Install. */
export const NO_INSTALL = {
  installPlan: async () => {
    throw new Error('not in this test');
  },
  install: async (): Promise<never> => {
    throw new Error('not in this test');
  },
};

/** Unmounts what open() rendered, so one test can open a view twice. */
export function cleanupView() {
  cleanup();
  window.location.hash = '';
}

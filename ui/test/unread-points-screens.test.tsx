// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { memoryAnalyses } from '../src/analyses.ts';
import { DataContext, type Data } from '../src/data.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import type { ToilProjectData } from '../src/load.ts';
import { SkinProvider, skinsFor } from '../src/skins.tsx';
import { Burnup, SprintDetail } from '../src/views/Flow.tsx';
import { health } from '../src/model/sprint.ts';
import { loaded } from './harness.ts';

/**
 * The sprint screens when no points were read (#652): the demo's case, a toil
 * project that didn't name Jira's points field. Every figure is a dash or says
 * "no points read", never 0 of 0, and the burn-up offers to name the field.
 */

const unread = async (): Promise<ToilProjectData> => {
  const { data } = await loaded('card-payments');
  return { ...data, items: data.items.map((i) => ({ ...i, estimate: null })) };
};

const shell = (toilProject: ToilProjectData, children: ReactNode) => {
  const data: Data = { toilProject, byId: new Map(toilProject.items.map((i) => [i.id, i])), prById: new Map(), agent: scriptedAgent(), now: FIXTURE_NOW, analyses: memoryAnalyses() };
  return render(
    <SkinProvider value={skinsFor('plain')}>
      <DataContext value={data}>{children}</DataContext>
    </SkinProvider>,
  );
};

describe('the sprint screens with no points read', () => {
  it('draws no burn-up of zeros, and offers to name the points field', async () => {
    const d = await unread();
    shell(d, <Burnup />);
    expect(screen.getByText("No points were read for this sprint's stories, so there is nothing to burn up.")).toBeTruthy();
    const link = screen.getByRole('link', { name: /Name the points field/ });
    expect(link.getAttribute('href')).toBe('#/settings/projects/card-payments/find-fields');
  });

  it('shows the sprint figures as dashes that say not read yet, with no meter', async () => {
    const d = await unread();
    const h = health(d.items, d.changes, FIXTURE_NOW)!;
    const { container } = shell(d, <SprintDetail h={h} />);
    const figures = screen.getByRole('list', { name: 'Sprint figures' });
    expect(figures.textContent).not.toMatch(/\b0 of 0\b/);
    expect(figures.querySelectorAll('[aria-label="not read yet"]').length).toBe(4);
    expect(figures.textContent).toContain('no points read');
    expect(container.querySelector('.meter')).toBeNull();
  });
});

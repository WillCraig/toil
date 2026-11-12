// @vitest-environment jsdom
// Every route is visited, which is the only form of site inspection that needs no travel approval.
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTES, open, resetBrowserState, tabs } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('every view', () => {
  it.each(ROUTES)('%s carries the preview banner, the views and when the data was read', async (hash) => {
    await open(hash);
    expect(screen.getByRole('note')?.textContent).toContain('Toil UI beta, showing sample data.');
    const nav = screen.getByRole('navigation', { name: 'Views' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Settings']);
    expect(screen.getByText(/Sample data read 13 Oct 2026, 08:00 UTC without changing anything/)).toBeTruthy();
  });

  it('names the app "toil UI" in the header, by its own words: the wordmark, then the sticker, read as one link home (#272, #277)', async () => {
    await open('#/project/settlement');
    const home = screen.getByRole('link', { name: 'toil UI' });
    expect(home.getAttribute('href')).toBe('#/');
    expect(home.querySelector('.wordmark')?.textContent).toBe('toil');
    expect(home.querySelector('.sticker')?.textContent).toBe('UI');
  });

  it('has no banner outside the preview', async () => {
    await open('#/', { preview: false });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it("marks the current view in the navigation, and the current tab in the Toil project's tabs (#394)", async () => {
    await open('#/project/settlement');
    expect(within(tabs('settlement')).getByRole('link', { name: 'Summary' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('link', { name: 'Toil projects' })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Views' })).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('settlement');
  });
});

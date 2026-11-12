// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureExecute, FIXTURE_NOW } from '../src/fixtures/execute.ts';

// Exercise the real app's lazy entry and route/focus behavior without replacing
// browser-level animation verification with a pretend canvas in jsdom.
vi.mock('../src/game/PowershellMan.tsx', () => ({
  PowershellMan: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Exit arcade</button>,
}));

const typeSecret = (text: string, target: Window | HTMLElement = window) => {
  for (const key of text) fireEvent.keyDown(target, { key });
};
const openApp = () => render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);

describe('the hidden arcade entry', () => {

  it('keeps the view behind it mounted and reads nothing while it is open', async () => {
    window.location.hash = '#/project/card-payments';
    const execute = vi.fn(fixtureExecute().execute);
    render(<App execute={execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    await waitFor(() => expect(document.querySelector('main h1')?.textContent).toBeTruthy());
    // Let the dashboard finish its own reads before counting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const h1 = document.querySelector('main h1')!;
    const before = execute.mock.calls.length;
    act(() => typeSecret('powershell'));
    await screen.findByRole('dialog', { name: 'Powershell Man' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h1.isConnected).toBe(true);
    expect(execute.mock.calls.length).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Exit arcade' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Powershell Man' })).toBeNull());
    expect(window.location.hash).toBe('#/project/card-payments');
    expect(h1.isConnected).toBe(true);
  });

  it('opens from the secret, contains focus, and returns to the previous route', async () => {
    window.location.hash = '#/settings';
    openApp();
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(screen.queryByRole('dialog', { name: 'Powershell Man' })).toBeNull();
    act(() => typeSecret('powershell'));
    const dialog = await screen.findByRole('dialog', { name: 'Powershell Man' });
    expect(screen.getByRole('heading', { level: 1, name: 'Settings', hidden: true })).toBeDefined();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Exit arcade' }));
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Powershell Man' })).toBeNull());
  });

  it('does not carry a partial secret across text entry or composing input', async () => {
    window.location.hash = '#/';
    openApp();
    await screen.findByRole('heading', { level: 1, name: 'Toil projects' });
    const input = document.createElement('input');
    document.body.append(input);
    try {
      act(() => {
        typeSecret('power');
        typeSecret('x', input);
        typeSecret('shell');
      });
      expect(window.location.hash).toBe('#/');
      act(() => {
        typeSecret('power');
        fireEvent.keyDown(window, { key: 's', isComposing: true });
        typeSecret('hell');
      });
      expect(window.location.hash).toBe('#/');
      act(() => typeSecret('powershell'));
      await screen.findByRole('dialog', { name: 'Powershell Man' });
    } finally {
      input.remove();
    }
  });

  it('supports the direct playtest route and closes it to Toil projects', async () => {
    window.location.hash = '#/powershell-man';
    openApp();
    await screen.findByRole('dialog', { name: 'Powershell Man' });
    fireEvent.click(screen.getByRole('button', { name: 'Exit arcade' }));
    await screen.findByRole('heading', { level: 1, name: 'Toil projects' });
    expect(window.location.hash).toBe('#/');
  });

  it('leaves an existing dialog in control when the secret is typed on one of its buttons', async () => {
    window.location.hash = '#/';
    openApp();
    await screen.findByRole('heading', { level: 1, name: 'Toil projects' });
    const existing = document.createElement('div');
    existing.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    existing.append(button);
    document.body.append(existing);
    try {
      act(() => typeSecret('powershell', button));
      expect(window.location.hash).toBe('#/');
      expect(screen.queryByRole('dialog', { name: 'Powershell Man' })).toBeNull();
    } finally {
      existing.remove();
    }
  });
});

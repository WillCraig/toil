import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import type { ConfigApi } from '../src/config.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import type { Envelope } from '../src/toil.ts';
import { areasFrom } from '../server/config.ts';

/**
 * A connection that takes no secret (#573): a SQLite file signs in with a path.
 * Settings offers it no sign-in and the setup wizard says "not needed", both
 * from the real `db` area, so the two screens can't drift from toil's own
 * description of which engines take a password.
 */

// toil's registry is loaded by a computed path so the page's own typecheck doesn't pull the whole CLI into its program (config.test.ts is excluded from it for the same reason); the `db` area here is the real one.
const TOIL_API = join(import.meta.dirname, '..', '..', 'src', 'api.ts');
const { registry } = (await import(/* @vite-ignore */ TOIL_API)) as { registry: Parameters<typeof areasFrom>[0] };

const SQLITE = { name: 'local-db', area: 'db', isDefault: true, host: null, writes: false, values: { engine: 'file', path: 'file' }, definedIn: 'file' };
const POSTGRES = { name: 'warehouse', area: 'db', isDefault: false, host: 'db.imagile.dev', writes: false, values: { engine: 'file', host: 'file', database: 'file', user: 'file', password: 'store' }, definedIn: 'file' };

const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 'test', contractVersion: 1 } }) as Envelope;

/** A config over the real registry's areas, listing the given connections and allowing changes. */
function machine(rows: unknown[]): ConfigApi {
  const base = fixtureConfig();
  return {
    disabled: null,
    areas: async () => areasFrom(registry),
    settings: () => base.settings(),
    run: async (command) => {
      if (command === 'connections list') return ok(command, { configFile: '/home/you/.toil/config.json', connections: rows });
      if (command === 'projects list') return ok(command, { toilProjects: [], places: { user: '/home/you/.toil/projects' } });
      return ok(command, {});
    },
  };
}

function open(hash: string, config: ConfigApi) {
  window.location.hash = hash;
  return render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={config} now={FIXTURE_NOW} preview />);
}

describe('a connection that takes no secret', () => {
  it('offers no sign-in in Settings, while a database that signs in still does', async () => {
    open('#/settings/connections', machine([SQLITE, POSTGRES]));
    const sqlite = (await screen.findByRole('heading', { level: 3, name: 'local-db' })).closest('.conn-card') as HTMLElement;
    const postgres = screen.getByRole('heading', { level: 3, name: 'warehouse' }).closest('.conn-card') as HTMLElement;
    // The areas load after the cards first draw, so wait for the one that signs in before judging the one that doesn't.
    await waitFor(() => expect(postgres.textContent).toContain('Update login'));
    expect(sqlite.textContent).toContain('Allow writes');
    expect(sqlite.textContent).not.toMatch(/Update login|Login/);
  });

  it('says "token: not needed" in the setup wizard and offers no way to replace a token', async () => {
    open('#/setup', machine([SQLITE]));
    await screen.findByRole('heading', { level: 1, name: 'Welcome' }, { timeout: 3000 });
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await userEvent.click(await screen.findByRole('radio', { name: /^Not now/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Next/ }));
    await screen.findByRole('heading', { level: 1, name: 'Which tools do you use?' });
    await waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-setup-tool="db"]')?.checked).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: /^Next/ }));
    const existing = await waitFor(() => {
      const el = document.querySelector('[data-existing="local-db"]');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(existing.textContent).toContain('token: not needed');
    expect(screen.queryByRole('radio', { name: /Replace the saved token/ })).toBeNull();
    expect(document.querySelector('[data-setup-login-help]')).toBeNull();
  }, 30_000);
});

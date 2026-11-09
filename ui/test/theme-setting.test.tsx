import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigApi } from '../src/config.ts';
import { initialChoice, originOf, themeFromToil, useThemeChoice } from '../src/theme-choice.ts';
import type { Envelope } from '../src/toil.ts';

/**
 * The theme as toil's own setting (#427): Toil UI reads `toil theme list` and
 * writes `toil theme set`, so the welcome menu and every browser follow one
 * choice. A browser that saved a theme before the setting keeps it until the
 * person picks; the address and TOIL_THEME win as they do everywhere else.
 */

const meta = (command: string) => ({ command, durationMs: 0, version: '0.1.0-alpha.1', contractVersion: 1 });
const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: meta(command) });

function fakeSetting(current: string, source: 'env' | 'file' | 'default', set: (name: string) => Envelope = (name) => ok('theme set', { theme: name })) {
  const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  const api: ConfigApi = {
    disabled: null,
    areas: async () => [],
    settings: async () => ({ timeout: { variable: 'TOIL_TIMEOUT_MS', value: null, effectiveMs: 120000, defaultMs: 120000 } }),
    run: async (command, input) => {
      calls.push({ command, input });
      return command === 'theme list' ? ok(command, { current, source, themes: [] }) : set(String(input.name));
    },
  };
  return { api, calls };
}

const choiceAt = (search: string) => initialChoice(search);

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('how deep a theme goes, for someone who has not chosen (#552)', () => {
  it('starts with themed wording on and the themed agent voice off (#561)', () => {
    const { wording, voice } = choiceAt('');
    expect([wording, voice]).toEqual([true, false]);
  });

  it('keeps a choice this browser saved, either way', () => {
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'realm', wording: true, voice: false }));
    expect(choiceAt('')).toMatchObject({ theme: 'realm', wording: true, voice: false });
  });

  it('still takes ?wording= and ?voice= from the address, over what was saved', () => {
    expect(choiceAt('?wording=on&voice=on')).toMatchObject({ wording: true, voice: true });
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'realm', wording: true, voice: true }));
    expect(choiceAt('?wording=off&voice=off')).toMatchObject({ wording: false, voice: false });
  });

  it('leaves the theme itself, its colours and art, as it was', () => {
    expect(choiceAt('?theme=realm')).toMatchObject({ theme: 'realm' });
  });
});

describe('which theme wins', () => {
  const fresh = { fromAddress: false, savedBeforeSetting: false };

  it("shows toil's setting from the file, and TOIL_THEME over it", () => {
    expect(themeFromToil({ current: 'realm', source: 'file' }, fresh)).toBe('realm');
    expect(themeFromToil({ current: 'starship', source: 'env' }, fresh)).toBe('starship');
  });

  it("keeps Toil UI's own default when toil has no theme set", () => {
    expect(themeFromToil({ current: 'plain', source: 'default' }, fresh)).toBeNull();
  });

  it('keeps a theme this browser saved before the setting, until a pick, but not over TOIL_THEME', () => {
    const older = { fromAddress: false, savedBeforeSetting: true };
    expect(themeFromToil({ current: 'realm', source: 'file' }, older)).toBeNull();
    expect(themeFromToil({ current: 'realm', source: 'env' }, older)).toBe('realm');
  });

  it('lets the address win over everything, and ignores a theme Toil UI does not have', () => {
    expect(themeFromToil({ current: 'realm', source: 'env' }, { fromAddress: true, savedBeforeSetting: false })).toBeNull();
    expect(themeFromToil({ current: 'vaporwave', source: 'file' }, fresh)).toBeNull();
  });

  it('tells a saved theme from before the setting from one a saved pick made', () => {
    expect(originOf('')).toEqual({ fromAddress: false, savedBeforeSetting: false });
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'harvest' }));
    expect(originOf('').savedBeforeSetting).toBe(true);
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'harvest', synced: true }));
    expect(originOf('?theme=plain')).toEqual({ fromAddress: true, savedBeforeSetting: false });
  });
});

describe('the theme picker with the setting', () => {
  it("opens in toil's theme, and a pick writes it with toil theme set", async () => {
    const { api, calls } = fakeSetting('realm', 'file');
    const { result } = renderHook(() => useThemeChoice(api));
    await waitFor(() => expect(result.current.theme).toBe('realm'));
    act(() => result.current.setTheme('harvest'));
    await waitFor(() => expect(calls.at(-1)).toEqual({ command: 'theme set', input: { name: 'harvest' } }));
    expect(result.current.theme).toBe('harvest');
    expect(result.current.saveError).toBeNull();
    expect(JSON.parse(localStorage.getItem('toil-ui.theme')!)).toMatchObject({ theme: 'harvest', synced: true });
  });

  it('keeps the theme on the page when toil refuses to save it, and says why', async () => {
    const { api } = fakeSetting('plain', 'default', (name) => ({ ok: false, data: null, error: { code: 'CONFIG_INVALID', message: `The config file won't take ${name}.`, fix: 'Fix the file.' }, meta: meta('theme set') }));
    const { result } = renderHook(() => useThemeChoice(api));
    await waitFor(() => expect(result.current.theme).toBe('crate'));
    act(() => result.current.setTheme('starship'));
    await waitFor(() => expect(result.current.saveError).toBe("Toil didn't save the theme: The config file won't take starship. Fix the file."));
    expect(result.current.theme).toBe('starship');
  });

  it('says when TOIL_THEME will win over the pick on the next load', async () => {
    const warned = (name: string): Envelope => ({ ...ok('theme set', { theme: name }), meta: { ...meta('theme set'), warnings: [{ code: 'OVERRIDDEN_BY_ENV', message: `TOIL_THEME is "starship" and wins over the file; unset it for "${name}" to show.` }] } });
    const { api } = fakeSetting('starship', 'env', warned);
    const { result } = renderHook(() => useThemeChoice(api));
    await waitFor(() => expect(result.current.theme).toBe('starship'));
    act(() => result.current.setTheme('realm'));
    await waitFor(() => expect(result.current.saveError).toBe('Saved to toil\'s config, but TOIL_THEME is "starship" and wins over the file; unset it for "realm" to show.'));
  });

  it('keeps a pick made before toil answers, rather than the older setting', async () => {
    let answer: (e: Envelope) => void = () => undefined;
    const { api } = fakeSetting('realm', 'file');
    const slow: ConfigApi = { ...api, run: (command, input) => (command === 'theme list' ? new Promise((r) => (answer = r)) : api.run(command, input)) };
    const { result } = renderHook(() => useThemeChoice(slow));
    act(() => result.current.setTheme('harvest'));
    await act(async () => answer(ok('theme list', { current: 'realm', source: 'file', themes: [] })));
    expect(result.current.theme).toBe('harvest');
  });

  it('reads and writes nothing without the setting (the preview, a test)', async () => {
    const { result } = renderHook(() => useThemeChoice(null));
    act(() => result.current.setTheme('realm'));
    expect(result.current.theme).toBe('realm');
    expect(JSON.parse(localStorage.getItem('toil-ui.theme')!).synced).toBeUndefined();
  });
});

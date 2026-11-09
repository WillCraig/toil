import { describe, expect, it } from 'vitest';
import { githubScopes } from '../src/areas/github/scopes.js';
import { describeScopes } from '../src/core/scopes.js';
import { areas, commands } from '../src/registry.js';
import { registry } from '../src/api.js';
import { execute } from '../src/core/run.js';
import { testContext } from './harness/context.js';

/**
 * An area that declares scopes (`defineArea({ scopes })`) lists, for each kind
 * of credential, every command that needs each scope. These tests are what
 * makes "update it with every command" more than a request: add a command and
 * the first one fails, naming the line to add. A request in a style guide is
 * read once; a failing test is read by everyone.
 */

const scoped = areas.filter((a) => a.scopes);

describe('scopes', () => {
  it('at least github declares them', () => {
    expect(scoped.map((a) => a.name)).toContain('github');
  });

  for (const area of scoped) {
    const own = commands.filter((c) => c.path[0] === area.name);
    for (const kind of area.scopes!.kinds) {
      const listed = new Map<string, Array<{ name: string; access?: string; required: string }>>();
      for (const e of kind.entries) for (const c of e.commands) listed.set(c, [...(listed.get(c) ?? []), e]);

      it(`${area.name}: every command is listed under the ${kind.id} credential`, () => {
        const missing = own.map((c) => c.path.join(' ')).filter((name) => !listed.has(name));
        expect(
          missing,
          `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} in no scope entry for the ${area.name} ${kind.id} credential. Add ${missing.length === 1 ? 'it' : 'each'} to the commands of the entries in src/areas/${area.name}/scopes.ts that grant what ${missing.length === 1 ? 'it needs' : 'they need'} (the read scope for a read, the write scope for a write), so Toil UI and "toil connections scopes --area ${area.name}" say it.`,
        ).toEqual([]);
      });

      it(`${area.name}: the ${kind.id} entries name only commands that exist`, () => {
        const known = new Set(own.map((c) => c.path.join(' ')));
        const unknown = [...listed.keys()].filter((name) => !known.has(name));
        expect(unknown, `${unknown.join(', ')} in src/areas/${area.name}/scopes.ts ${unknown.length === 1 ? 'is' : 'are'} not ${area.name} commands. Remove or rename ${unknown.length === 1 ? 'it' : 'them'}.`).toEqual([]);
      });

      it(`${area.name}: a read is needed at read level and a write at a level that writes (${kind.id})`, () => {
        const wrong: string[] = [];
        for (const c of own) {
          const entries = listed.get(c.path.join(' ')) ?? [];
          const writes = c.writes;
          if (!writes && !entries.some((e) => e.required === 'read')) wrong.push(`${c.path.join(' ')} reads but only a write-level entry lists it`);
          if (writes && !entries.some((e) => e.access === undefined || e.access === 'write')) wrong.push(`${c.path.join(' ')} writes but only read-level entries list it`);
        }
        expect(wrong).toEqual([]);
      });
    }
  }

  it('reads need no more than everything does, and a link carries what it needs', () => {
    const d = describeScopes(githubScopes);
    for (const kind of d.kinds) {
      expect(kind.everything.needs.length).toBeGreaterThanOrEqual(kind.readOnly.needs.length);
      expect(kind.readOnly.needs.length).toBeGreaterThan(0);
    }
    const classic = d.kinds.find((k) => k.id === 'classic')!;
    expect(classic.everything.createUrl).toBe('https://github.com/settings/tokens/new?scopes=repo,read:project,project&description=toil');
    const fine = d.kinds.find((k) => k.id === 'fine-grained')!;
    expect(fine.readOnly.needs).toContain('Pull requests: Read');
    expect(fine.everything.needs).toContain('Pull requests: Read and write');
    expect(fine.everything.needs).not.toContain('Pull requests: Read');
    expect(fine.readOnly.needs).not.toContain('Administration: Read and write');
  });

  it('the registry carries them for the page, and none for an area that declares none', () => {
    expect(registry.areas.find((a) => a.name === 'github')!.scopes).toEqual(describeScopes(githubScopes));
    expect(registry.areas.find((a) => a.name === 'jira')!.scopes).toBeUndefined();
  });

  it('toil connections scopes says the same, and warns for an area that has none', async () => {
    const def = commands.find((c) => c.path.join(' ') === 'connections scopes')!;
    const run = (input: Record<string, unknown>) => execute(def, input, testContext().context);
    const all = await run({});
    expect((all.data as { areas: Array<{ area: string }> }).areas.map((a) => a.area)).toContain('github');
    const one = await run({ area: 'github' });
    expect((one.data as { areas: Array<{ kinds: unknown[] }> }).areas[0]!.kinds).toHaveLength(2);
    const none = await run({ area: 'jira' });
    expect((none.data as { areas: unknown[] }).areas).toEqual([]);
    expect(none.meta.warnings?.[0]?.code).toBe('NO_SCOPES_DECLARED');
    const bad = await run({ area: 'nope' });
    expect(bad.error?.code).toBe('INVALID_INPUT');
  });
});

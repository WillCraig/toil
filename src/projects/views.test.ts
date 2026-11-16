/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read envelopes' untyped JSON */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AS_OF, cleanup, cli, commands, data, disk, mcp } from './pivot-testkit.js';

afterEach(cleanup);

const file = (d: ReturnType<typeof disk>) => JSON.parse(readFileSync(join(d.home, '.toil', 'projects', 'payments.json'), 'utf8')) as Record<string, any>;
const set = (...flags: string[]) => ['projects', 'view', 'set', 'payments', ...flags];

describe('projects view set', () => {
  it('saves a view, checks every part, and keeps the rest of the file', async () => {
    const d = disk();
    const out = data(await cli(d, set('release-mix', '--measure', 'items', '--split', 'release', '--where', 'status != Done', '--share', '--top', '3', '--pin', '1.4', '--title', 'Fix versions', '--chart', 'bars')));
    expect(out.changed).toBe(true);
    expect(file(d).views['release-mix']).toEqual({ measure: 'items', split: 'release', where: [{ dimension: 'status', op: '!=', values: ['Done'] }], share: true, top: 3, pin: ['1.4'], title: 'Fix versions', chart: 'bars' });
    expect(Object.keys(file(d).views)).toContain('work-mix');
    expect(file(d).people).toHaveLength(2);
  });

  it('defaults the measure to items', async () => {
    const d = disk();
    data(await cli(d, set('by-type', '--split', 'type')));
    expect(file(d).views['by-type']).toEqual({ measure: 'items', split: 'type' });
  });

  it('refuses a different view of a name that is taken, unless --replace; the same view changes nothing', async () => {
    const d = disk();
    const same = data(await cli(d, set('work-mix', '--measure', 'throughput', '--split', 'category', '--across', 'resolved:month', '--share', '--title', 'Work mix')));
    expect(same.changed).toBe(false);
    const refused = await cli(d, set('work-mix', '--split', 'type'));
    expect(refused.error).toMatchObject({ code: 'INVALID_INPUT', message: "Toil project payments's view work-mix is already set.", fix: 'Pass --replace to change it, or pick another name.' });
    data(await cli(d, set('work-mix', '--split', 'type', '--replace')));
    expect(file(d).views['work-mix']).toEqual({ measure: 'items', split: 'type' });
  });

  it('refuses a bad name, a name a section holds, and a bad part, naming the flag and the fix', async () => {
    const d = disk();
    expect((await cli(d, set('Bad Name'))).error).toMatchObject({ code: 'INVALID_INPUT', message: '"Bad Name" isn\'t a view name.' });
    expect((await cli(d, set('writes'))).error!.message).toContain('"writes" can\'t be a view name');
    const split = (await cli(d, set('v', '--split', 'colour'))).error!;
    expect(split.message).toContain('--split: Unknown dimension');
    expect(split.fix).toContain('category');
    expect((await cli(d, set('v', '--measure', 'speed'))).error!.fix).toContain('throughput');
    expect((await cli(d, set('v', '--from', '2026-11-02', '--to', '2026-10-01'))).error!.message).toContain('is after to');
    expect((await cli(d, set('v', '--chart', 'pie'))).error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(file(d).views.v).toBeUndefined();
  });

  it('is served over MCP, and a pivot runs what it saved', async () => {
    const d = disk();
    const s = await mcp(d);
    data((await s.call('projects_view_set', { toilProject: 'payments', name: 'by-type', split: 'type' })).envelope);
    const out = data(await cli(d, ['projects', 'pivot', 'payments', '--input-file', 'work.json', '--as-of', AS_OF, '--view', 'by-type']));
    expect(out.rows.map((r: any) => r.label)).toContain('Task');
  });
});

describe('projects view show, list and remove', () => {
  it('shows a view with the pivot it runs, lists the views, and refuses an unknown one with the names there are', async () => {
    const d = disk();
    const shown = data(await cli(d, ['projects', 'view', 'show', 'payments', 'work-mix']));
    expect(shown.view).toMatchObject({ measure: 'throughput', title: 'Work mix' });
    expect(shown.pivot).not.toHaveProperty('title');
    expect(shown.command).toBe('toil projects pivot payments --view work-mix');
    expect(data(await cli(d, ['projects', 'view', 'list', 'payments'])).views).toEqual([{ name: 'work-mix', title: 'Work mix', measure: 'throughput', split: 'category', across: 'resolved:month', where: 0, chart: null }]);
    const e = await cli(d, ['projects', 'view', 'show', 'payments', 'nope']);
    expect(e.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'It has: work-mix.' });
  });

  it('removes a view on the CLI, drops the key when it was the last, and is never an MCP tool', async () => {
    const d = disk();
    expect(data(await cli(d, ['projects', 'view', 'remove', 'payments', 'work-mix'])).removed).toMatchObject({ name: 'work-mix', measure: 'throughput' });
    expect(file(d)).not.toHaveProperty('views');
    expect((await cli(d, ['projects', 'view', 'remove', 'payments', 'work-mix'])).error).toMatchObject({ code: 'INVALID_INPUT', fix: 'It has none. Save one with toil projects view set.' });
    const s = await mcp(d);
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('projects_view_set');
    expect(names).not.toContain('projects_view_remove');
    expect(commands.find((c) => c.path.join(' ') === 'projects view remove')!.kind).toBe('cli-only');
  });
});

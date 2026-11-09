import { describe, expect, it } from 'vitest';
import { testContext } from '../../../../test/harness/context.js';
import type { Route } from '../../../../test/harness/fake-fetch.js';
import { config as fixtureConfig, SITE } from '../../../../test/fixtures/jira-cloud-data.js';
import type { AnyCommand } from '../../../core/command.js';
import { execute } from '../../../core/run.js';
import { completeSprint, createSprint, getSprint, startSprint, updateSprint } from './agile.js';

/**
 * The sprint ceremony on Jira Cloud: the request each command sends and the
 * refusals that keep a sprint from being started twice or completed while
 * still planned. Shapes are from the Agile REST API reference, not a live
 * site's minutes.
 */

const AGILE = '/rest/agile/1.0';
const write = { allowWrite: true };
const sprint = (state: string, extra: Record<string, unknown> = {}) => ({ id: 7, name: 'Sprint 7', state, originBoardId: 1, ...extra });

async function run(def: AnyCommand, input: Record<string, unknown>, routes: Route[]) {
  const t = testContext({ config: fixtureConfig, routes, files: {} });
  const envelope = await execute(def, input, t.context);
  return { envelope, calls: t.http.calls };
}
const body = (call: { body?: string | undefined }) => JSON.parse(call.body!) as Record<string, unknown>;
const ok = (json: unknown) => ({ json });

describe('jira sprint ceremony (Cloud)', () => {
  it('create: POSTs the board and the dates as UTC timestamps, and returns the sprint', async () => {
    const { envelope, calls } = await run(createSprint, { name: 'Sprint 7', board: 1, start: '2026-11-02', end: '2026-11-16', goal: 'Ship', ...write }, [
      { method: 'POST', path: `${AGILE}/sprint`, respond: { status: 201, json: sprint('future') } },
    ]);
    expect(body(calls[0]!)).toEqual({ originBoardId: 1, name: 'Sprint 7', startDate: '2026-11-02T00:00:00.000Z', endDate: '2026-11-16T00:00:00.000Z', goal: 'Ship' });
    expect(envelope.data).toMatchObject({ id: 7, state: 'future' });
  });

  it('create: a date that is not one is refused before any request', async () => {
    const { envelope, calls } = await run(createSprint, { name: 'S', board: 1, start: 'next tuesday', ...write }, []);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('create without --allow-write sends nothing', async () => {
    const { envelope, calls } = await run(createSprint, { name: 'S', board: 1 }, []);
    expect(envelope.error?.code).toBe('WRITE_DISABLED');
    expect(calls).toHaveLength(0);
  });

  it('get: reads the sprint by id', async () => {
    const { envelope, calls } = await run(getSprint, { sprint: 7 }, [{ method: 'GET', path: `${AGILE}/sprint/7`, respond: ok(sprint('active')) }]);
    expect(calls[0]!.url).toBe(`${SITE}${AGILE}/sprint/7`);
    expect(envelope.data).toMatchObject({ state: 'active' });
  });

  it('update: sends only what was passed, by the partial-update POST', async () => {
    const { calls } = await run(updateSprint, { sprint: 7, goal: 'New goal', ...write }, [{ method: 'POST', path: `${AGILE}/sprint/7`, respond: ok(sprint('future')) }]);
    expect(body(calls[0]!)).toEqual({ goal: 'New goal' });
  });

  it('update: with nothing to change it says so', async () => {
    const { envelope, calls } = await run(updateSprint, { sprint: 7, ...write }, []);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('start: activates a future sprint with the dates given, and keeps its planned end otherwise', async () => {
    const { calls } = await run(startSprint, { sprint: 7, start: '2026-11-02', ...write }, [
      { method: 'GET', path: `${AGILE}/sprint/7`, respond: ok(sprint('future', { endDate: '2026-11-16T00:00:00.000Z' })) },
      { method: 'POST', path: `${AGILE}/sprint/7`, respond: ok(sprint('active')) },
    ]);
    expect(body(calls[1]!)).toEqual({ state: 'active', startDate: '2026-11-02T00:00:00.000Z', endDate: '2026-11-16T00:00:00.000Z' });
  });

  it('start: refuses a sprint that is not future, and one with no end date, before changing anything', async () => {
    const active = await run(startSprint, { sprint: 7, ...write }, [{ method: 'GET', path: `${AGILE}/sprint/7`, respond: ok(sprint('active')) }]);
    expect(active.envelope.error?.message).toContain('only a future sprint');
    expect(active.calls).toHaveLength(1);
    const undated = await run(startSprint, { sprint: 7, ...write }, [{ method: 'GET', path: `${AGILE}/sprint/7`, respond: ok(sprint('future')) }]);
    expect(undated.envelope.error?.fix).toContain('--end');
    expect(undated.calls).toHaveLength(1);
  });

  it('complete: closes an active sprint and leaves its open issues to Jira without moveOpenTo', async () => {
    const { envelope, calls } = await run(completeSprint, { sprint: 7, ...write }, [
      { method: 'GET', path: `${AGILE}/sprint/7`, respond: ok(sprint('active')) },
      { method: 'POST', path: `${AGILE}/sprint/7`, respond: ok(sprint('closed')) },
    ]);
    expect(body(calls[1]!)).toEqual({ state: 'closed' });
    expect(envelope.data).toMatchObject({ moved: [], movedTo: null, sprint: { state: 'closed' } });
  });

  it('complete --move-open-to: moves the issues not done into the target before closing', async () => {
    const { envelope, calls } = await run(completeSprint, { sprint: 7, moveOpenTo: '8', ...write }, [
      { method: 'GET', path: `${AGILE}/sprint/7`, respond: ok(sprint('active')) },
      { method: 'GET', path: `${AGILE}/sprint/7/issue`, respond: ok({ startAt: 0, maxResults: 50, total: 2, isLast: true, issues: [{ key: 'A-1' }, { key: 'A-2' }] }) },
      { method: 'POST', path: `${AGILE}/sprint/8/issue`, respond: { status: 204 } },
      { method: 'POST', path: `${AGILE}/sprint/7`, respond: ok(sprint('closed')) },
    ]);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `GET ${AGILE}/sprint/7`,
      `GET ${AGILE}/sprint/7/issue`,
      `POST ${AGILE}/sprint/8/issue`,
      `POST ${AGILE}/sprint/7`,
    ]);
    expect(body(calls[2]!)).toEqual({ issues: ['A-1', 'A-2'] });
    expect(envelope.data).toMatchObject({ moved: ['A-1', 'A-2'], movedTo: '8' });
  });

  it('complete --move-open-to backlog: uses the backlog endpoint, and sends nothing when none is open', async () => {
    const open = await run(completeSprint, { sprint: 7, moveOpenTo: 'backlog', ...write }, [
      { method: 'GET', path: `${AGILE}/sprint/7`, respond: ok(sprint('active')) },
      { method: 'GET', path: `${AGILE}/sprint/7/issue`, respond: ok({ startAt: 0, maxResults: 50, total: 1, isLast: true, issues: [{ key: 'A-1' }] }) },
      { method: 'POST', path: `${AGILE}/backlog/issue`, respond: { status: 204 } },
      { method: 'POST', path: `${AGILE}/sprint/7`, respond: ok(sprint('closed')) },
    ]);
    expect(body(open.calls[2]!)).toEqual({ issues: ['A-1'] });
    const none = await run(completeSprint, { sprint: 7, moveOpenTo: 'backlog', ...write }, [
      { method: 'GET', path: `${AGILE}/sprint/7`, respond: ok(sprint('active')) },
      { method: 'GET', path: `${AGILE}/sprint/7/issue`, respond: ok({ startAt: 0, maxResults: 50, total: 0, isLast: true, issues: [] }) },
      { method: 'POST', path: `${AGILE}/sprint/7`, respond: ok(sprint('closed')) },
    ]);
    expect(none.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST']);
  });

  it('complete: refuses a sprint that is not active, a nonsense target and itself as the target', async () => {
    const future = await run(completeSprint, { sprint: 7, ...write }, [{ method: 'GET', path: `${AGILE}/sprint/7`, respond: ok(sprint('future')) }]);
    expect(future.envelope.error?.message).toContain('only an active sprint');
    const bad = await run(completeSprint, { sprint: 7, moveOpenTo: 'later', ...write }, []);
    expect(bad.envelope.error?.code).toBe('INVALID_INPUT');
    const self = await run(completeSprint, { sprint: 7, moveOpenTo: '7', ...write }, []);
    expect(self.envelope.error?.code).toBe('INVALID_INPUT');
    expect(bad.calls.length + self.calls.length).toBe(0);
  });
});

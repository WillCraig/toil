import { describe, expect, it } from 'vitest';
import { testContext } from '../../../test/harness/context.js';
import type { Route } from '../../../test/harness/fake-fetch.js';
import { fixture, GHE, statusItem } from '../../../test/fixtures/github.fixture.js';
import type { AnyCommand } from '../../core/command.js';
import { execute } from '../../core/run.js';
import { projectStatusCommand } from './projects.js';

/**
 * `github project status`: the requests it sends (a read of the item and its
 * project's Status options, then one mutation), what it refuses, and what it
 * says came of it. The GraphQL answers are the fixture's, invented from the
 * reference and not captured from a live project.
 */

const BASE = { owner: 'imagile', repo: 'toil-probe' };

async function run(def: AnyCommand, input: Record<string, unknown>, routes: Route[] = fixture.routes!, extra: object = {}) {
  const t = testContext({ config: { github: { ...fixture.config!.github } }, routes, files: fixture.files! });
  const envelope = await execute(def, input, { ...t.context, ...extra });
  return { envelope, calls: t.http.calls };
}

const sentOf = (calls: Array<{ body?: string | undefined }>) => calls.map((c) => JSON.parse(c.body!) as { query: string; variables: Record<string, unknown> });
const graphql = (...answers: unknown[]): Route[] => {
  let n = 0;
  return [{ method: 'POST', url: /graphql$/, respond: () => ({ json: answers[Math.min(n++, answers.length - 1)] }) }];
};
const read = (nodes: unknown[]) => ({ data: { repository: { issueOrPullRequest: { __typename: 'Issue', projectItems: { nodes } } } } });
const move = { ...BASE, project: '3', number: '9', to: 'Done', allowWrite: true };

describe('github project status', () => {
  it('finds the issue on the project, resolves the option by name, then sends the mutation with the ids it found', async () => {
    const { envelope, calls } = await run(projectStatusCommand, { ...move, to: 'done' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${GHE}/api/graphql`, `POST ${GHE}/api/graphql`]);
    const [find, set] = sentOf(calls);
    expect(find!.variables).toEqual({ owner: 'imagile', repo: 'toil-probe', number: 9 });
    expect(find!.query).toContain('issueOrPullRequest');
    expect(set!.query).toContain('updateProjectV2ItemFieldValue');
    expect(set!.variables).toEqual({ project: 'PVT_kwDOabc123453', item: 'PVTI_abc12345', field: 'PVTSSF_abc12345', option: '98236657' });
    expect(envelope.data).toEqual({ item: 'PVTI_abc12345', project: { number: 3, title: 'Roadmap', owner: 'imagile' }, field: 'Status', from: 'In Progress', to: 'Done', changed: true });
  });

  it('takes a project item id on its own, reading the node and not the repository', async () => {
    const { envelope, calls } = await run(projectStatusCommand, { item: 'PVTI_abc12345', to: 'Todo', allowWrite: true });
    const [find, set] = sentOf(calls);
    expect(find!.variables).toEqual({ item: 'PVTI_abc12345' });
    expect(set!.variables).toMatchObject({ item: 'PVTI_abc12345', option: 'f75ad846' });
    expect(envelope.data).toMatchObject({ from: 'In Progress', to: 'Todo', changed: true });
  });

  it('sends nothing when the item already holds that status', async () => {
    const { envelope, calls } = await run(projectStatusCommand, { ...move, project: 3, number: 9, to: 'in progress' });
    expect(calls).toHaveLength(1);
    expect(envelope.data).toMatchObject({ from: 'In Progress', to: 'In Progress', changed: false });
  });

  it('an item with no Status yet reads as from: null and still moves', async () => {
    const { envelope, calls } = await run(projectStatusCommand, move, graphql(read([statusItem(null)]), { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_abc12345' } } } }));
    expect(calls).toHaveLength(2);
    expect(envelope.data).toMatchObject({ from: null, to: 'Done', changed: true });
  });

  it("an unknown status is INVALID_INPUT listing the project's own options, and nothing is written", async () => {
    const { envelope, calls } = await run(projectStatusCommand, { ...move, to: 'Blocked' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Todo, In Progress, Done'), fix: expect.stringContaining('Todo, In Progress, Done') });
    expect(calls).toHaveLength(1);
  });

  it('an issue that is not on the project is NOT_FOUND, says where it is, and is never added', async () => {
    const other = { ...statusItem(), project: { ...statusItem().project, number: 8 } };
    const { envelope, calls } = await run(projectStatusCommand, move, graphql(read([other])));
    expect(envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('is not on project 3 owned by imagile (it is on imagile/8)'), fix: expect.stringContaining('never adds') });
    expect(calls).toHaveLength(1);
    const none = await run(projectStatusCommand, move, graphql(read([])));
    expect(none.envelope.error?.message).toContain('it is on no project');
  });

  it('a project with no Status field, a missing issue and a missing item are each said plainly', async () => {
    const noField = { ...statusItem(), project: { ...statusItem().project, field: null } };
    expect((await run(projectStatusCommand, move, graphql(read([noField])))).envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('no single-select field named Status') });
    expect((await run(projectStatusCommand, move, graphql({ data: { repository: { issueOrPullRequest: null } } }))).envelope.error).toMatchObject({ code: 'NOT_FOUND' });
    expect((await run(projectStatusCommand, { item: 'PVTI_nope', to: 'Done', allowWrite: true }, graphql({ data: { node: null } }))).envelope.error).toMatchObject({ code: 'NOT_FOUND', fix: expect.stringContaining('PVTI_') });
  });

  it('wants the item named one way, and the write gate holds', async () => {
    expect((await run(projectStatusCommand, { ...BASE, to: 'Done', allowWrite: true })).envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Say which item') });
    expect((await run(projectStatusCommand, { ...move, item: 'PVTI_abc12345' })).envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('one way') });
    const gated = await run(projectStatusCommand, { ...move, allowWrite: false });
    expect(gated.envelope.error?.code).toBe('WRITE_DISABLED');
    expect(gated.calls).toHaveLength(0);
  });

  it('a token without the project scope is AUTH on the mutation, naming what to add', async () => {
    const denied = { data: null, errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'Your token has not been granted the required scopes' }] };
    const { envelope } = await run(projectStatusCommand, move, graphql(read([statusItem()]), denied));
    expect(envelope.error).toMatchObject({ code: 'AUTH', message: expect.stringContaining("can't change the Status of item PVTI_abc12345"), fix: expect.stringContaining('read:project') });
  });

  it("an unadopted toil project's owner never blocks --item, which does not use it, but does block the project and number form", async () => {
    // A checked-in toil project (never adopted) that says the owner is someone else.
    const unadopted = { toilProject: (area: string, key: string) => (area === 'github' && key === 'owner' ? 'someone-else' : key === 'repo' ? 'elsewhere' : undefined), adopted: () => false };
    const byItem = await run(projectStatusCommand, { item: 'PVTI_abc12345', to: 'Todo', allowWrite: true }, fixture.routes!, unadopted);
    expect(byItem.envelope.error?.code).not.toBe('WRITE_DISABLED');
    expect(byItem.envelope.data).toMatchObject({ to: 'Todo', changed: true });
    const byNumbers = await run(projectStatusCommand, { project: '3', number: '9', to: 'Done', allowWrite: true }, fixture.routes!, unadopted);
    expect(byNumbers.envelope.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining("which you haven't adopted") });
    expect(byNumbers.calls).toHaveLength(0);
  });
});

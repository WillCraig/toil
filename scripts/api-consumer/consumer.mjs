// An example program using toil the way an npm user would: installed from the
// tarball, imported by its package name, never by a path into it. The smoke
// test (scripts/smoke.mjs) copies this next to the install and runs it, with a
// stub Bitbucket on TOIL_BITBUCKET_BASE_URL, then checks what it printed.
// consumer.ts beside it is the same calls, type-checked against dist/api.d.ts.
import { contractVersion, execute, mapOwi, owiSchema, owiVersion, registry, version } from '@imagile-dev/toil/api';

const events = [];
const listed = await execute(
  'bitbucket pr list',
  { project: 'PAY', repo: 'web' },
  { readOnly: true, caller: 'api-consumer', onProgress: (event) => events.push({ type: event.type, command: event.command, message: event.message }) },
);
// Refused before any request: the stub would record a POST if one were sent.
const refused = await execute('bitbucket pr create', { project: 'PAY', repo: 'web', title: 'Add retries', source: 'feature/retries', allowWrite: true }, { readOnly: true, caller: 'api-consumer' });
const unknown = await execute('no such command');
const badCaller = await execute('version', {}, { caller: 'Not A Label' });
// The Open Work Item mappers, in-process, on an envelope a host already holds: a toil project's fields point estimate at the team's field.
const issue = { key: 'PAY-1', self: 'https://jira.imagile.dev/rest/api/2/issue/1', fields: { summary: 'Retry once', status: { name: 'To Do', statusCategory: { key: 'new' } }, issuetype: { name: 'Story' }, customfield_10234: 3 } };
const owi = mapOwi({ ok: true, data: issue, error: null, meta: { command: 'jira issue get', durationMs: 1, version } }, { fields: { estimate: 'customfield_10234' } });
const checked = await execute('util owi map', { text: JSON.stringify({ ok: true, data: issue, error: null, meta: { command: 'jira issue get', durationMs: 1, version } }) }, { readOnly: true, caller: 'api-consumer' });

console.log(
  JSON.stringify({
    version,
    contractVersion,
    commands: registry.commands.length,
    listPrs: (({ name, tool, writes, inputSchema }) => ({ name, tool, writes, hasSchema: inputSchema.type === 'object' }))(registry.commands.find((c) => c.name === 'bitbucket pr list')),
    listed: { ok: listed.ok, ids: listed.ok ? listed.data.map((pr) => pr.id) : null, error: listed.error, contractVersion: listed.meta.contractVersion },
    events,
    refused: refused.error?.code,
    unknown: unknown.error?.code,
    badCaller: badCaller.error?.code,
    owi: { version: owiVersion, schemaId: owiSchema.$id, item: (({ id, statusCategory, estimate }) => ({ id, statusCategory, estimate }))(owi.items[0]), checked: checked.ok && checked.data.verified.passed },
  }),
);

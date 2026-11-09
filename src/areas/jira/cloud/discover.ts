import { discoverCommand } from '../discover.js';
import * as client from './client.js';

/** Jira Cloud's four reads for `jira field discover`: the field list, a project's issue types, a JQL sample and one issue. */
export const discover = discoverCommand((ctx) => ({
  deployment: 'cloud',
  fields: () => client.fetchFields(ctx),
  project: async (key) => ((await client.getProject(ctx, key)) as { issueTypes?: Array<{ id?: string; name: string }> }).issueTypes ?? [],
  sample: async (jql, n) => (await client.search(ctx, jql, { fields: ['*all'], cap: n })).items,
  issue: (key) => client.getIssue(ctx, key),
}));

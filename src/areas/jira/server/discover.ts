import { apiPath } from '../../../core/api-path.js';
import { discoverCommand } from '../discover.js';
import * as client from './client.js';

/** Data Center's four reads for `jira field discover`: the field list, a project's issue types, a JQL sample and one issue. */
export const discover = discoverCommand((ctx) => ({
  deployment: 'server',
  fields: () => client.fetchFields(ctx),
  project: async (key) => ((await client.jira<{ issueTypes?: Array<{ id?: string; name: string }> }>(ctx, apiPath`/rest/api/2/project/${key}`)).issueTypes ?? []),
  sample: async (jql, n) => (await client.search(ctx, jql, { maxResults: n, fields: ['*all'] })).issues,
  issue: (key) => client.getIssue(ctx, key),
}));

import { z } from 'zod';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';
import { githubArea } from './area.js';
import { exampleGraphqlCursor, githubGraphql, githubGraphqlList, target, targetOwner, type GitHubContext, type GraphqlConnection } from './client.js';
import { intText, pageFields, pageOptions, parseIntText } from './input.js';

/**
 * Projects (v2), GitHub's boards, over GraphQL: an owner's projects, a
 * project's fields (status, iterations, estimates) and its items with their
 * field values. Projects belong to an owner, not a repository, so only
 * --owner is read. A board is a spreadsheet that has been told it is agile.
 *
 * Docs, checked 2026-10-18:
 * https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects
 * (the queries and the read:project scope) and the GraphQL reference for
 * ProjectV2, ProjectV2Item and the ProjectV2ItemField*Value types.
 */

const PROJECTS = `
  query($owner: String!, $first: Int!, $after: String) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectsV2(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id number title shortDescription url public closed createdAt updatedAt }
        }
      }
    }
  }
`;

const FIELDS = `
  query($owner: String!, $project: Int!, $first: Int!, $after: String) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $project) {
          fields(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { options { id name } }
              ... on ProjectV2IterationField {
                configuration {
                  duration
                  startDay
                  iterations { id title startDate duration }
                  completedIterations { id title startDate duration }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Values past the first 100 on one item are cut, with a warning; a project has at most 50 fields today. */
const ITEMS = `
  query($owner: String!, $project: Int!, $first: Int!, $after: String) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $project) {
          items(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              type
              isArchived
              createdAt
              updatedAt
              content {
                __typename
                ... on Issue { number title state url updatedAt repository { nameWithOwner } }
                ... on PullRequest { number title state url updatedAt repository { nameWithOwner } }
                ... on DraftIssue { title }
              }
              fieldValues(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldTextValue { text }
                  ... on ProjectV2ItemFieldNumberValue { number }
                  ... on ProjectV2ItemFieldDateValue { date }
                  ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
                  ... on ProjectV2ItemFieldIterationValue { title iterationId startDate duration }
                  ... on ProjectV2ItemFieldValueCommon { field { ... on ProjectV2FieldCommon { id name } } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface Owner {
  repositoryOwner?: { projectsV2?: GraphqlConnection<unknown>; projectV2?: Record<string, GraphqlConnection<unknown> | undefined> | null } | null;
}

interface GraphqlError {
  type?: string;
  message?: string;
  extensions?: { code?: string };
}

const SCOPES = 'A classic personal access token needs read:project (project to change a project item); a fine-grained token needs Projects: read (Read and write to change one) under Organization permissions, and works for organization projects only, so a user\'s own projects need a classic token.';

/**
 * GitHub's GraphQL errors as toil's: a missing scope is AUTH, a project or
 * owner that isn't there NOT_FOUND, and a field the schema doesn't have
 * (Projects on an older Enterprise Server) UNSUPPORTED, each in plain words.
 */
async function projectsCall<T>(owner: string, what: string, call: () => Promise<T>, verb: 'read' | 'change' = 'read'): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof ToilError) || err.code !== 'HTTP') throw err;
    const errors = ((err.details as { errors?: unknown } | undefined)?.errors ?? []) as GraphqlError[];
    if (!Array.isArray(errors)) throw err;
    // A classic token short of a scope gets INSUFFICIENT_SCOPES; a fine-grained one short of a permission, FORBIDDEN.
    const denied = errors.find((e) => e.type === 'INSUFFICIENT_SCOPES' || e.type === 'FORBIDDEN');
    if (denied) throw new ToilError('AUTH', `The GitHub token can't ${verb} ${what}: ${denied.message ?? 'missing scope'}`, { fix: SCOPES });
    if (errors.some((e) => e.type === 'NOT_FOUND')) {
      throw new ToilError('NOT_FOUND', `GitHub found no ${what}: ${errors.find((e) => e.type === 'NOT_FOUND')?.message ?? ''}`.trim(), {
        fix: `Check ${owner ? `--owner (${owner}) and the project number` : 'the item id'}, and that the token can see the project. ${SCOPES}`,
      });
    }
    if (errors.some((e) => e.extensions?.code === 'undefinedField' || e.extensions?.code === 'undefinedType' || /doesn't exist on type|unknown type/i.test(e.message ?? ''))) {
      throw new ToilError('UNSUPPORTED', `This GitHub server's GraphQL API has no Projects (v2), so toil can't ${verb} ${what}.`, {
        fix: 'Use a GitHub Enterprise Server release that has Projects (the new project boards); classic projects are not supported.',
      });
    }
    throw err;
  }
}

const projectNumber = intText.describe('Project number (from project list, or the project URL)');
const projectArg = { name: 'project', field: 'project', description: 'Project number (from project list, or the project URL)' };

export const listProjectsCommand = githubArea.command({
  path: ['github', 'project', 'list'],
  description: "List an owner's projects (v2)",
  toolDescription: "Lists the Projects (v2) an organization or user owns: id, number, title, shortDescription, url, public, closed, createdAt, updatedAt. Needs read:project on a classic token, or Projects: read on a fine-grained one (organization projects only). With limit, pass meta.page.nextCursor as cursor for the next page.",
  queryByPost: true,
  input: z.object({ ...pageFields('projects') }),
  writes: false,
  options: [...pageOptions('projects')],
  examples: [{ owner: 'imagile' }, { owner: 'imagile', repo: 'unused', limit: 1, cursor: exampleGraphqlCursor() }],
  run: async (input, ctx) => {
    const owner = targetOwner(ctx);
    const what = `projects owned by ${owner}`;
    return projectsCall(owner, what, () => githubGraphqlList(ctx, PROJECTS, { owner }, (d) => (d as Owner).repositoryOwner?.projectsV2, what, input));
  },
});

function inProject(ctx: GitHubContext, input: { project: number | string; limit?: number | undefined; cursor?: string | undefined }, query: string, key: 'fields' | 'items', noun: string) {
  const owner = targetOwner(ctx);
  const project = parseIntText(input.project);
  const what = `${noun} of project ${project} owned by ${owner}`;
  return projectsCall(owner, what, () => githubGraphqlList(ctx, query, { owner, project }, (d) => (d as Owner).repositoryOwner?.projectV2?.[key], what, input));
}

export const projectFieldsCommand = githubArea.command({
  path: ['github', 'project', 'fields'],
  description: "List a project's fields, with single-select options and iterations",
  toolDescription:
    "Lists a project's fields: id, name and dataType (TEXT, NUMBER, DATE, SINGLE_SELECT, ITERATION, and the built-in ones), the options of a single-select field such as Status, and an iteration field's configuration with its current and completed iterations. With limit, pass meta.page.nextCursor as cursor for the next page.",
  queryByPost: true,
  input: z.object({ project: projectNumber, ...pageFields('fields') }),
  writes: false,
  args: [projectArg],
  options: [...pageOptions('fields')],
  examples: [{ owner: 'imagile', project: '3' }, { owner: 'imagile', repo: 'unused', project: 3, limit: 1, cursor: exampleGraphqlCursor() }],
  run: async (input, ctx) => inProject(ctx, input, FIELDS, 'fields', 'fields'),
});

interface Item {
  fieldValues?: { pageInfo?: { hasNextPage?: boolean }; nodes?: unknown[] };
  [key: string]: unknown;
}

export const projectItemsCommand = githubArea.command({
  path: ['github', 'project', 'items'],
  description: "List a project's items (issues, pull requests, drafts) with their field values",
  toolDescription:
    "Lists a project's items: id, type (ISSUE, PULL_REQUEST, DRAFT_ISSUE), isArchived, the content (number, title, state, url and repository for an issue or PR; title for a draft) and fieldValues, each with its field's name and the value (text, number, date, a single-select name, or an iteration's title and dates). With limit, pass meta.page.nextCursor as cursor for the next page.",
  queryByPost: true,
  input: z.object({ project: projectNumber, ...pageFields('items') }),
  writes: false,
  args: [projectArg],
  options: [...pageOptions('items')],
  examples: [{ owner: 'imagile', project: '3' }, { owner: 'imagile', repo: 'unused', project: '3', limit: 1, cursor: exampleGraphqlCursor() }],
  run: async (input, ctx) => {
    const items = (await inProject(ctx, input, ITEMS, 'items', 'items')) as Item[];
    let cut = 0;
    const flat = items.map(({ fieldValues, ...item }) => {
      if (fieldValues?.pageInfo?.hasNextPage) cut++;
      return { ...item, fieldValues: fieldValues?.nodes ?? [] };
    });
    if (cut > 0) ctx.warn({ code: 'GITHUB_PROJECT_VALUES_TRUNCATED', message: `${cut} items have more than 100 field values; only the first 100 of each are shown.` });
    return flat;
  },
});

/**
 * What `project status` reads about one project item before it changes
 * anything: the item, its project, the project's Status field with its
 * options, and the option the item holds now. One selection for both ways of
 * naming the item, so the mutation is the second request and the last.
 */
const ITEM_FIELDS = `
  id
  project {
    id
    number
    title
    owner { __typename ... on Organization { login } ... on User { login } }
    field(name: "Status") { ... on ProjectV2SingleSelectField { id name options { id name } } }
  }
  fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name optionId } }
`;

const ITEMS_OF_ISSUE = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issueOrPullRequest(number: $number) {
        __typename
        ... on Issue { projectItems(first: 100) { nodes { ${ITEM_FIELDS} } } }
        ... on PullRequest { projectItems(first: 100) { nodes { ${ITEM_FIELDS} } } }
      }
    }
  }
`;

const ITEM_BY_ID = `
  query($item: ID!) {
    node(id: $item) {
      __typename
      ... on ProjectV2Item { ${ITEM_FIELDS} }
    }
  }
`;

const SET_STATUS = `
  mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
    updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) {
      projectV2Item { id }
    }
  }
`;

interface StatusItem {
  id?: string;
  project?: {
    id: string;
    number: number;
    title?: string;
    owner?: { login?: string };
    field?: { id?: string; name?: string; options?: Array<{ id: string; name: string }> } | null;
  } | null;
  fieldValueByName?: { name?: string; optionId?: string } | null;
}

export const projectStatusCommand = githubArea.command({
  path: ['github', 'project', 'status'],
  description: "Set the Status of an issue or pull request on a project (move it between the board's columns)",
  toolDescription:
    "Sets the Status single-select field of one Projects (v2) item, by the option's name (case-insensitive; an unknown name lists the project's own options). Name the item either by project number and the issue or pull request number (with owner and repo), or by item, the project item id from project items. An issue that is not on the project is refused, never added. Returns the item, the project, the field, the status it had (from) and the one it has now (to), and changed: false when it was already there. Needs a classic token with the project scope, or a fine-grained token with Projects: Read and write (organization projects only), and writes on the connection.",
  input: z.object({
    project: intText.optional().describe("Project number (from project list, or the project URL), with the issue or pull request number. The project's owner is --owner, and the issue's repository is --repo"),
    number: intText.optional().describe('Issue or pull request number, with the project number'),
    item: z.string().min(1).optional().describe('Project item id (from project items), instead of the project and issue numbers'),
    to: z.string().min(1).describe('The Status option\'s name, such as "In Progress" (case-insensitive; project fields lists them)'),
    ...allowWriteField,
  }),
  writes: true,
  args: [
    { name: 'project', field: 'project', description: 'Project number (from project list, or the project URL)', required: false },
    { name: 'number', field: 'number', description: 'Issue or pull request number', required: false },
  ],
  options: [
    { flags: '--item <id>', field: 'item', description: 'Project item id (from project items), instead of the project and issue numbers' },
    { flags: '--to <status>', field: 'to', description: 'The Status option\'s name, such as "In Progress" (case-insensitive; project fields lists them)' },
  ],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', project: '3', number: '9', to: 'done', allowWrite: true },
    { item: 'PVTI_abc12345', to: 'Done', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const byItem = input.item !== undefined;
    if (byItem && (input.project !== undefined || input.number !== undefined)) {
      throw new ToilError('INVALID_INPUT', 'Name the item one way: --item, or the project and issue numbers, not both.', { fix: 'Pass either --item <project item id>, or <project> <number> (with --owner and --repo).' });
    }
    if (!byItem && (input.project === undefined || input.number === undefined)) {
      throw new ToilError('INVALID_INPUT', 'Say which item to move: the project and issue numbers, or --item.', { fix: 'Pass <project> <number> (toil github project status 3 9 --to Done), or --item <project item id> from project items.' });
    }
    const wanted = input.to.trim();
    // Read only where a path needs it: core refuses a write whose owner came from an unadopted toil project, and --item never uses it.
    let owner = '';
    let found: StatusItem;
    if (byItem) {
      // The item id says which project it is on, so the owner and repo core resolved were never used.
      delete ctx.resolved.inputs?.owner;
      delete ctx.resolved.inputs?.repo;
      const answer = await projectsCall(owner, `project item ${input.item}`, () => githubGraphql<{ node?: StatusItem | null }>(ctx, ITEM_BY_ID, { item: input.item }), 'change');
      if (!answer.node?.project) {
        throw new ToilError('NOT_FOUND', `GitHub found no project item ${input.item}.`, { fix: 'Take the id from project items (it starts PVTI_), and check the token can see that project.' });
      }
      found = answer.node;
    } else {
      const repository = target(ctx);
      owner = repository.owner;
      const project = parseIntText(input.project!);
      const number = parseIntText(input.number!);
      const what = `#${number} in ${repository.owner}/${repository.repo}`;
      const answer = await projectsCall(
        owner,
        what,
        () => githubGraphql<{ repository?: { issueOrPullRequest?: { projectItems?: { nodes?: StatusItem[] } } | null } | null }>(ctx, ITEMS_OF_ISSUE, { owner, repo: repository.repo, number }),
        'change',
      );
      const issue = answer.repository?.issueOrPullRequest;
      if (!issue) throw new ToilError('NOT_FOUND', `GitHub found no issue or pull request ${what}.`, { fix: 'Check --owner, --repo and the number.' });
      const items = issue.projectItems?.nodes ?? [];
      const here = items.find((i) => i.project?.number === project && (i.project.owner?.login ?? owner).toLowerCase() === owner.toLowerCase());
      if (!here) {
        const on = items.map((i) => `${i.project?.owner?.login ?? '?'}/${i.project?.number}`);
        throw new ToilError('NOT_FOUND', `${what} is not on project ${project} owned by ${owner}${on.length ? ` (it is on ${on.join(', ')})` : ' (it is on no project)'}.`, {
          fix: "toil never adds an item to a project: add it on the project's page first. A project owned by someone other than the repository's owner needs --item (the id from project items).",
        });
      }
      found = here;
    }
    const project = found.project!;
    const projectOwner = project.owner?.login ?? owner;
    const field = project.field;
    if (!field?.id || !field.options) {
      throw new ToilError('NOT_FOUND', `Project ${project.number} has no single-select field named Status.`, { fix: 'toil github project fields shows its fields; this command changes a single-select field called Status.' });
    }
    const option = field.options.find((o) => o.name.toLowerCase() === wanted.toLowerCase());
    if (!option) {
      const names = field.options.map((o) => o.name);
      throw new ToilError('INVALID_INPUT', `Project ${project.number} has no Status option "${input.to}". Its options are: ${names.join(', ')}.`, { fix: `Pass --to with one of: ${names.join(', ')}.` });
    }
    const result = {
      item: found.id,
      project: { number: project.number, title: project.title ?? null, owner: projectOwner },
      field: field.name ?? 'Status',
      from: found.fieldValueByName?.name ?? null,
      to: option.name,
      changed: found.fieldValueByName?.optionId !== option.id,
    };
    // Already there: nothing to change, so nothing is sent.
    if (!result.changed) return result;
    await projectsCall(projectOwner, `the Status of item ${found.id} on project ${project.number}`, () => githubGraphql(ctx, SET_STATUS, { project: project.id, item: found.id, field: field.id, option: option.id }), 'change');
    return result;
  },
});

export const projectCommands = [listProjectsCommand, projectFieldsCommand, projectItemsCommand, projectStatusCommand];

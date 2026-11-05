import { z } from 'zod';
import { inputFields, openInput, textOption } from '../areas/util/kit/input.js';
import { brief, lensDef } from '../core/brief/brief.js';
import { analyzePrompt, type FocusSource } from '../core/brief/prompt.js';
import { analyzeSettings, isStandard } from '../core/brief/settings.js';
import { readBriefRecords } from '../core/brief/read.js';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import type { Applied } from '../core/toil-project.js';
import { ToilError } from '../core/errors.js';
import { forwardSlashes } from '../core/files.js';
import { chosen } from './commands.js';

/**
 * `toil projects brief` (#494): the briefing by code for one toil project, from
 * the work items and pull requests the caller read and mapped. It reads the
 * toil project for its settings (the WIP limit now, its Analyze settings next) and
 * asks no service: the trackers and code hosts are each read by their own
 * command, and composed through `util owi map` (principle 3). The rules are
 * in src/core/brief/, where Toil UI reads them too. The status meeting,
 * minus the meeting.
 */

/** Three items in a chain and the pull request whose checks fail on the first, for the examples. */
export const EXAMPLE_BRIEF_RECORDS = JSON.stringify({
  items: [
    { id: 'corp-jira:PAY-101', source: { area: 'jira', connection: 'corp-jira', key: 'PAY-101', command: 'jira issue search' }, url: 'https://jira.imagile.dev/browse/PAY-101', title: 'Tokenise card numbers at the edge', status: 'In Progress', statusCategory: 'IN_PROGRESS', assignee: { id: 'jsmith', name: 'J. Smith', email: null }, estimate: { value: 5, unit: 'points', field: 'Story Points' }, links: [{ type: 'blocks', direction: 'outward', target: 'corp-jira:PAY-102', name: 'blocks' }], updated: '2026-10-12T16:10:00.000Z' },
    { id: 'corp-jira:PAY-102', source: { area: 'jira', connection: 'corp-jira', key: 'PAY-102', command: 'jira issue search' }, url: 'https://jira.imagile.dev/browse/PAY-102', title: 'Store tokens in the vault', status: 'To Do', statusCategory: 'TODO', assignee: null, estimate: { value: 3, unit: 'points', field: 'Story Points' }, links: [{ type: 'blocks', direction: 'inward', target: 'corp-jira:PAY-101', name: 'is blocked by' }], updated: '2026-10-05T09:10:00.000Z' },
    { id: 'corp-jira:PAY-105', source: { area: 'jira', connection: 'corp-jira', key: 'PAY-105', command: 'jira issue search' }, url: 'https://jira.imagile.dev/browse/PAY-105', title: 'Show the last four digits on receipts', status: 'Done', statusCategory: 'DONE', assignee: null, estimate: { value: 3, unit: 'points', field: 'Story Points' }, links: [], updated: '2026-10-09T15:30:00.000Z' },
  ],
  changes: [
    { id: 'corp-bitbucket:PAY/payments-core#311', repo: 'PAY/payments-core', title: 'Tokenise PANs in the edge proxy', url: 'https://bitbucket.imagile.dev/projects/PAY/repos/payments-core/pull-requests/311', state: 'OPEN', checks: 'FAILING', checksAt: '2026-10-12T15:40:00.000Z', workItems: ['corp-jira:PAY-101'], created: '2026-10-12T15:30:00.000Z', firstReviewAt: '2026-10-12T17:00:00.000Z' },
  ],
});

export function toilProjectBriefCommands(): AnyCommand[] {
  const command = defineConfigCommand({
    path: ['projects', 'brief'],
    description: "Brief one toil project by code: what needs a person, under one reason each, and what to do first, from OWI records you pass (local only)",
    toolDescription:
      "Briefs one toil project from Open Work Item records you pass (what util owi map printed for the toil project's work items and pull requests, as file or text; several envelopes, one per line, are fine). Asks no service: read each tracker and code host with its own command first. Applies the toil project's lenses in order (failing checks, blocked, waiting on review, sprint at risk, stale, over the WIP limit, ticket and pull request disagree) and puts each item that needs a person under the first lens that flags it. Returns { toil project, asOf, by, recommendation { text, items }, reasons [{ lens, label, severity, line, text, items [{ id, key, source, title, url, status, statusCategory, assignee, points, why, evidence, holds { items, points }, changes [{ id, repo, title, url, state, checks }] }] }], onTrack { open, done }, sprint, lenses [{ id, label, on, threshold, unit, test, checked, untested, note }], skipped }. Sentences cite items and pull requests as [[<owi id>]]; each item's url opens it in its tracker. A lens it can't check, or items it couldn't test for a missing field (untested), it says why in lenses[].note. Use it as the starting point for an analysis, then weigh what it found.",
    input: z.object({
      toilProject: z.string().min(1).optional().describe('A toil project name, or the path to a toil project file. Defaults to the toil project that applies to the folder.'),
      cwd: z.string().min(1).optional().describe('The folder to look from; its repository decides which checked-in toil projects apply. Defaults to the workspace.'),
      ...inputFields,
      asOf: z.string().datetime({ offset: true }).optional().describe('The moment to brief as of, as an ISO 8601 time (default: now). Ages and the sprint are counted to it.'),
    }),
    writes: false,
    writesLocal: false,
    args: [{ name: 'toil-project', field: 'toilProject', description: 'A toil project name or file (default: the one the folder matches)', required: false }],
    options: [
      { flags: '--file <path>', field: 'file', description: 'The OWI records: a file inside the workspace, or - for stdin (the default when no --text is given)' },
      textOption,
      { flags: '--as-of <time>', field: 'asOf', description: 'Brief as of this ISO 8601 time (default: now)' },
      { flags: '--cwd <dir>', field: 'cwd', description: 'The folder to look from (default: the working directory)' },
    ],
    examples: [
      { toilProject: 'payments', text: EXAMPLE_BRIEF_RECORDS, asOf: '2026-10-13T08:00:00Z' },
      { toilProject: 'payments', cwd: '.', file: 'owi/brief.owi.json', asOf: '2026-10-16T08:00:00Z' },
    ],
    run: async (input, ctx) => {
      const applied = chosen(ctx.manage!.toilProjects!, input, ctx);
      const { toilProject, source, file } = applied.file;
      const read = await openInput(ctx, input);
      const records = readBriefRecords(await read.text());
      if (!records.items.length) {
        throw new ToilError('INVALID_INPUT', `The input holds no work items${records.skipped.length ? ` (${records.skipped.length} records skipped: ${records.skipped[0]!.at}, ${records.skipped[0]!.reason})` : ''}.`, {
          fix: "Pass the toil project's work items as OWI records: toil jira issue search … | toil util owi map, then this command.",
        });
      }
      if (records.skipped.length) ctx.warn({ code: 'BRIEF_SKIPPED', message: `${records.skipped.length} record${records.skipped.length > 1 ? 's were' : ' was'} skipped: ${records.skipped[0]!.at}, ${records.skipped[0]!.reason}. data.skipped lists each.` });
      if (records.duplicates.length) ctx.warn({ code: 'BRIEF_DUPLICATE_ID', message: `${records.duplicates.length} id${records.duplicates.length > 1 ? 's appear' : ' appears'} more than once (${records.duplicates.slice(0, 3).join(', ')}); the first of each was used.` });
      if (!records.changes.length) ctx.warn({ code: 'BRIEF_NO_CHANGES', message: "The input holds no pull requests, so failing checks, waiting on review and drift found nothing. Map the code hosts' pull requests too." });
      const known = new Set(records.items.map((i) => i.id));
      const unlinked = records.changes.filter((c) => !c.workItems.some((id) => known.has(id)));
      if (unlinked.length) {
        ctx.warn({
          code: 'BRIEF_UNLINKED_CHANGES',
          message: `${unlinked.length} of ${records.changes.length} pull requests name no work item in the input (${unlinked.slice(0, 3).map((c) => c.id).join(', ')}), so no lens reads them. Check the --key-pattern they were mapped with.`,
        });
      }
      const result = brief({ items: records.items, changes: records.changes, asOf: input.asOf ?? new Date().toISOString(), settings: analyzeSettings(toilProject.analyze, toilProject.wipLimit ?? null).settings });
      return { toilProject: { name: toilProject.name, file: forwardSlashes(file), source, adopted: source === 'user' }, ...result, skipped: records.skipped };
    },
  });
  const toilProjectField = z.string().min(1).optional().describe('A toil project name, or the path to a toil project file. Defaults to the toil project that applies to the folder.');
  const cwdField = z.string().min(1).optional().describe('The folder to look from; its repository decides which checked-in toil projects apply. Defaults to the workspace.');
  const toilProjectArg = { name: 'toil-project', field: 'toilProject', description: 'A toil project name or file (default: the one the folder matches)', required: false };
  const cwdOption = { flags: '--cwd <dir>', field: 'cwd', description: 'The folder to look from (default: the working directory)' };

  const show = defineConfigCommand({
    path: ['projects', 'analyze', 'show'],
    description: "Show how Analyze briefs a toil project: its reader, its lenses in order with their thresholds, and its focus",
    toolDescription:
      "Shows a toil project's Analyze settings as they apply: the reader (audience), every lens in the order it is applied with whether it is on, its threshold and unit, and the test it applies, and the focus (goal, watchFor, leaveOut) with where it came from and whether you adopted that toil project. standard is true when the toil project sets nothing and the standard applies as it is; analyze is the toil project's own analyze key as written. Change them with projects_analyze_set. Reads local files only.",
    input: z.object({ toilProject: toilProjectField, cwd: cwdField }),
    writes: false,
    writesLocal: false,
    args: [toilProjectArg],
    options: [cwdOption],
    examples: [{ toilProject: 'payments' }, { toilProject: 'payments', cwd: '.' }],
    run: async (input, ctx) => {
      const applied = chosen(ctx.manage!.toilProjects!, input, ctx);
      const { toilProject } = applied.file;
      const a = analyzeSettings(toilProject.analyze, toilProject.wipLimit ?? null);
      return {
        toilProject: focusSource(applied),
        standard: isStandard(toilProject.analyze),
        analyze: toilProject.analyze ?? null,
        audience: a.audience,
        lenses: a.settings.lenses.map((l) => {
          const def = lensDef(l.id);
          return { id: l.id, label: def.label, on: l.on, threshold: l.threshold, unit: def.unit, test: def.test(l.threshold, a.settings.wipLimit) };
        }),
        wipLimit: a.settings.wipLimit,
        focus: a.focus,
      };
    },
  });

  const prompt = defineConfigCommand({
    path: ['projects', 'analyze', 'prompt'],
    description: 'Print the Analyze prompt for a toil project, for an agent with toil to run',
    toolDescription:
      "Returns the Analyze prompt for one toil project, ready to run: the steps to read its work items and pull requests with toil's tools and brief them with projects_brief, the standard method with the toil project's lenses and thresholds, its focus labelled with where it came from (a toil project you haven't adopted is named as such), and how to write the answer, with every work item and pull request as a Markdown link to its url. Returns { toil project, host, prompt, focused }. host toil-ui gives the version Toil UI sends, which answers with a briefing block instead of Markdown. Reads local files only; contacts no service.",
    input: z.object({
      toilProject: toilProjectField,
      cwd: cwdField,
      host: z.enum(['toil-mcp', 'toil-ui']).optional().describe('Which agent runs it: toil-mcp (the default), any agent with toil\'s MCP tools, answering in Markdown; toil-ui, Toil UI\'s, answering with a briefing block'),
    }),
    writes: false,
    writesLocal: false,
    args: [toilProjectArg],
    options: [cwdOption, { flags: '--host <host>', field: 'host', description: 'toil-mcp (the default) or toil-ui' }],
    examples: [{ toilProject: 'payments' }, { toilProject: 'payments', cwd: '.', host: 'toil-ui' }],
    run: async (input, ctx) => {
      const applied = chosen(ctx.manage!.toilProjects!, input, ctx);
      const { toilProject } = applied.file;
      const host = input.host ?? 'toil-mcp';
      const from = focusSource(applied);
      const a = analyzeSettings(toilProject.analyze, toilProject.wipLimit ?? null);
      return { toilProject: from, host, prompt: analyzePrompt(a, from, host), focused: Boolean(a.focus.goal || a.focus.watchFor || a.focus.leaveOut) };
    },
  });
  return [command, show, prompt];
}

/** Where a toil project came from, as the focus is labelled: its file, whose it is, and for a checked-in one the repository it's in. */
export function focusSource(applied: Applied): FocusSource {
  const { toilProject, source, file } = applied.file;
  const path = forwardSlashes(file);
  const repo = source === 'repo' ? path.replace(/\/\.toil\/projects\/[^/]+$/, '') : null;
  return { toilProject: toilProject.name, file: path, source, adopted: source === 'user', repo };
}


import { z } from 'zod';
import { inputFields, inputFileOption, openInput, textOption } from '../areas/util/kit/input.js';
import { readBriefRecords } from '../core/brief/read.js';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import type { CommandContext } from '../core/context.js';
import { ToilError } from '../core/errors.js';
import type { WorkItem } from '../core/owi/types.js';
import type { StandardCatalog, ResolvedStandard } from '../core/standards/catalog.js';
import { checkStandards } from '../core/standards/check.js';
import type { FoundStandard, StandardsCheckResult } from '../core/standards/types.js';
import type { Applied } from '../core/toil-project.js';
import { toilProjectFor } from '../classify/run.js';

/**
 * `toil standards list` and `toil standards check`: the ticket rules toil can
 * see, and checking work items against them. `check` reads Open Work Item
 * records the caller passes and the standards a toil project (or the call)
 * names, asks no service, and returns one result per rule that applies to each
 * item. Both read local files only, change nothing, and are served over MCP. A
 * rule that can't be read off the record is reported as not read, which is the
 * one outcome a ticket template has never been able to admit to.
 */

/** Work items with a story, a bug and a task, for the examples: what `util owi map` prints, cut down. */
export const EXAMPLE_STANDARDS_RECORDS = JSON.stringify({
  items: [
    {
      id: 'corp-jira:PAY-201',
      source: { area: 'jira', connection: 'corp-jira', key: 'PAY-201', command: 'jira issue search' },
      url: 'https://jira.imagile.dev/browse/PAY-201',
      type: 'STORY',
      typeName: 'Story',
      title: 'Save a card for later',
      body: { format: 'markdown', content: 'As a shopper, I want to save my card, so that I can pay faster next time.\n\n## Acceptance criteria\nGiven a signed-in shopper\nWhen they tick "Save this card"\nThen the card is offered at the next checkout' },
      status: 'To Do',
      statusCategory: 'TODO',
      labels: [],
      native: {},
    },
    {
      id: 'corp-jira:PAY-202',
      source: { area: 'jira', connection: 'corp-jira', key: 'PAY-202', command: 'jira issue search' },
      url: 'https://jira.imagile.dev/browse/PAY-202',
      type: 'BUG',
      typeName: 'Bug',
      title: 'Receipt shows the wrong total',
      body: { format: 'markdown', content: '## Steps to reproduce\n1. Pay with a voucher\n2. Open the receipt\n\n## Expected\nThe total after the voucher\n\n## Actual\nThe total before it' },
      status: 'To Do',
      statusCategory: 'TODO',
      labels: [],
      native: {},
    },
    {
      id: 'corp-jira:PAY-203',
      source: { area: 'jira', connection: 'corp-jira', key: 'PAY-203', command: 'jira issue search' },
      url: 'https://jira.imagile.dev/browse/PAY-203',
      type: 'STORY',
      typeName: 'Story',
      title: 'Show refunds on the statement',
      body: { format: 'markdown', content: 'Refunds should appear.' },
      status: 'To Do',
      statusCategory: 'TODO',
      labels: [],
      native: {},
    },
  ],
});

const cwdField = z.string().min(1).optional().describe("The folder to look from; its repository's .toil/standards holds the checked-in standards that apply. Defaults to the workspace.");
const cwdOption = { flags: '--cwd <dir>', field: 'cwd', description: 'The folder to look from (default: the working directory); its repository decides which checked-in standards apply' };

/** The catalog a standards command works through, which only config commands are handed. */
export function standardsOf(ctx: CommandContext<unknown>): StandardCatalog {
  if (!ctx.manage) throw new Error('A standards command ran without ctx.manage; define it with defineConfigCommand.');
  if (!ctx.manage.standards) throw new ToilError('NOT_CONFIGURED', 'Standards (ticket rules) are not available here.', { fix: 'Run toil standards from the CLI or toil mcp.' });
  return ctx.manage.standards;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The brief reader keeps a record as written, so one written by hand may lack what the matcher reads. Labels,
 * type and parent default to empty; `body` is left as it came, since a record with no `body` key never had its
 * description read, and that is not the same as an empty one (principle 12).
 */
function complete(item: WorkItem): WorkItem {
  const labels: unknown = item.labels;
  return {
    ...item,
    labels: Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : [],
    type: item.type ?? 'OTHER',
    typeName: item.typeName ?? null,
    parent: item.parent ?? null,
    native: isRecord(item.native) ? item.native : {},
  };
}

/** The toil project's field aliases by area, for `field:<alias>` and the acceptance criteria field. */
function fieldAliases(applied: Applied | undefined): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [area, section] of Object.entries(applied?.file.toilProject.sections ?? {})) {
    const fields = isRecord(section) ? section.fields : undefined;
    if (!isRecord(fields)) continue;
    const own: Record<string, string> = {};
    for (const [alias, id] of Object.entries(fields)) if (typeof id === 'string') own[alias] = id;
    out[area] = own;
  }
  return out;
}

/** Runs the check: what both `standards check` and a host that already holds the items share. */
export function runCheck(ctx: CommandContext<unknown>, items: WorkItem[], standards: ResolvedStandard[], applied: Applied | undefined): StandardsCheckResult {
  const { result, warnings } = checkStandards({
    standards: standards.map((s): FoundStandard => ({ standard: s.standard, source: s.source, ...(s.file ? { file: s.file } : {}) })),
    items: items.map(complete),
    toilProject: applied?.file.toilProject.name ?? null,
    fields: fieldAliases(applied),
  });
  for (const w of warnings) ctx.warn(w);
  return result;
}

export function standardsCommands(): AnyCommand[] {
  const list = defineConfigCommand({
    path: ['standards', 'list'],
    description: 'List every standard (set of ticket rules) toil can see, and where each lives',
    toolDescription:
      "Lists the standards toil can read: sets of ticket rules, such as acceptance criteria written as Given/When/Then. Each name appears once, from the highest place it is found: your own (~/.toil/standards), the repository the folder is in (.toil/standards), and the three built in (gherkin, user-story, bug-repro). Each has its name, revision, source (user, repo or built-in), file, description, and rules [{ id, name, text, when, fail, kind }]. A file that can't be read is a warning naming its key path. Reads local files only.",
    input: z.object({ cwd: cwdField }),
    writes: false,
    writesLocal: false,
    options: [cwdOption],
    examples: [{}, { cwd: '.' }],
    run: async (input, ctx) => {
      const { standards, warnings } = standardsOf(ctx).list(input.cwd);
      for (const w of warnings) ctx.warn(w);
      return {
        standards: standards.map((s) => ({
          name: s.standard.name,
          revision: s.standard.revision,
          source: s.source,
          ...(s.file ? { file: s.file } : {}),
          description: s.standard.description ?? null,
          rules: s.standard.rules.map((r) => ({ id: r.id, name: r.name, ...(r.missing ? { missing: r.missing } : {}), text: r.text, when: r.when ?? null, fail: r.fail, kind: r.check.kind })),
        })),
      };
    },
  });

  const check = defineConfigCommand({
    path: ['standards', 'check'],
    description: "Check work items against a toil project's ticket rules (standards), asking no service (local only)",
    toolDescription:
      "Checks Open Work Item records you pass (what util owi map printed, as inputFile or text) against standards: sets of ticket rules such as Given/When/Then acceptance criteria, the user-story form, or a bug's repro steps. The standards are standard (names or files, repeatable), else the ones the toil project lists in standards.use; with neither, none apply and a warning says so. Each rule that applies to an item (by its when: type, label, parent, title) gives one result: pass, thin or fail (the rule's own choice of how serious a miss is), or skipped when the text it reads isn't in the record (not read, never taken for empty) or it needs an AI agent (judge). Returns { toilProject, standards [{ name, revision, source, file, rules }], items [{ id, key, area, title, url, verdict (pass, thin, fail, or null when no rule could be checked), results [{ standard, rule, name, state, reason, source }] }], summary { items, checked, byRule [{ standard, rule, name, types, applies, pass, thin, fail, skipped }] } }. Asks no service and changes nothing.",
    input: z.object({
      ...inputFields,
      toilProject: z.string().min(1).optional().describe('A toil project name, or the path to a toil project file, whose standards.use and field aliases apply. Without one, the toil project that applies to the folder is used if there is exactly one.'),
      cwd: cwdField,
      standard: z.array(z.string().min(1)).optional().describe("Standards to check against instead of the toil project's: each a name (yours, the repository's or built in) or a path to a standard file ending in .json."),
    }),
    writes: false,
    writesLocal: false,
    options: [
      inputFileOption,
      textOption,
      { flags: '--toil-project <name|file>', field: 'toilProject', description: 'Use this toil project (a name or a file) instead of the one the folder matches' },
      cwdOption,
      { flags: '--standard <name|file>', field: 'standard', description: "A standard to check against, by name or file (repeatable; replaces the toil project's list)" },
    ],
    examples: [
      { text: EXAMPLE_STANDARDS_RECORDS, standard: ['gherkin', 'user-story', 'bug-repro'] },
      { toilProject: 'payments', cwd: '.', inputFile: 'owi/brief.owi.json', standard: ['team', 'gherkin'] },
    ],
    run: async (input, ctx) => {
      const catalog = standardsOf(ctx);
      const applied = toilProjectFor(ctx, input);
      const read = await openInput(ctx, input);
      const records = readBriefRecords(await read.text());
      if (!records.items.length) {
        throw new ToilError('INVALID_INPUT', `The input holds no work items${records.skipped.length ? ` (${records.skipped.length} records skipped: ${records.skipped[0]!.at}, ${records.skipped[0]!.reason})` : ''}.`, {
          fix: 'Pass work items as OWI records: toil jira issue search … | toil util owi map, then this command.',
        });
      }
      if (records.skipped.length) {
        const first = records.skipped.slice(0, 3).map((s) => `${s.at}: ${s.reason}`).join('; ');
        ctx.warn({ code: 'STANDARDS_SKIPPED', message: `${records.skipped.length} record${records.skipped.length > 1 ? 's were' : ' was'} skipped (${first}${records.skipped.length > 3 ? '; …' : ''}).` });
      }

      let standards: ResolvedStandard[];
      if (input.standard !== undefined && input.standard.length > 0) {
        standards = input.standard.map((ref) => catalog.resolve(ref, input.cwd));
      } else {
        const use = applied?.file.toilProject.standards?.use ?? [];
        standards = use.map((ref) => catalog.resolveFromToilProject(ref, applied!.file.file, input.cwd));
        if (use.length === 0) {
          // No fallback to the built-ins: which rules a team's tickets are held to is the team's call, never toil's.
          ctx.warn({
            code: 'STANDARDS_NONE',
            message: applied
              ? `The toil project ${applied.file.toilProject.name} names no standards, so no rules were checked. Name some with toil projects standards set ${applied.file.toilProject.name} --use <name>, or pass --standard.`
              : 'No toil project applies and no --standard was given, so no rules were checked. Pass --standard gherkin (or another name or file), or --toil-project <name> for one that lists standards.',
          });
        }
      }
      for (const s of standards) for (const w of s.warnings) ctx.warn(w);
      return runCheck(ctx, records.items, standards, applied);
    },
  });

  return [list, check];
}

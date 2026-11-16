import { z } from 'zod';
import { apiPath } from '../../core/api-path.js';
import { CATEGORIZE_TIME_LIMIT_MS, categorizeResult, categorizeWarnings, failureReason, fieldNotFound, labelChange, labelsAfter, optionMissing, sameValue } from '../../core/classify/apply.js';
import { PLAN_FROM_DESCRIPTION, planFor, readPlanFrom } from '../../core/classify/plan.js';
import type { CategorizeChange, PlanGroup, PlanItem } from '../../core/classify/types.js';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';
import { githubArea } from './area.js';
import { github } from './client.js';
import { issueProjectItems, itemOnProject, projectFieldList, setProjectField, type StatusItem } from './projects.js';

/**
 * `github issue categorize`: applies the plan `toil classify run` wrote to the
 * issues and pull requests of one GitHub connection. A category is a label,
 * created when the repository lacks it, and optionally a single-select field
 * on a Projects (v2) project. It never sends a DELETE: a label comes off by
 * replacing the issue's labels in one PUT, which is how the command stays
 * available over MCP. The plan was approved in principle by a steering
 * committee that has since been reorganised; the label is what remains.
 *
 * The item keys are `owner/repo#number`, so the plan itself says where each
 * item lives and the command needs no --owner or --repo of its own.
 */

/** GitHub's cap on a label's description. */
const DESCRIPTION_MAX = 100;

const KEY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;

interface Parsed {
  item: PlanItem;
  owner: string;
  repo: string;
  number: number;
  slug: string;
}

function parseKey(item: PlanItem): Parsed {
  const m = KEY.exec(item.key);
  if (!m || ['.', '..'].includes(m[1]!) || ['.', '..'].includes(m[2]!)) {
    throw new ToilError('INVALID_INPUT', `The plan item "${item.key}" isn't a GitHub issue key (owner/repo#number).`, {
      fix: 'Make the plan from GitHub items: read them with toil github issue list or issue search, pipe them through toil util owi map, then toil classify run.',
    });
  }
  return { item, owner: m[1]!, repo: m[2]!, number: Number(m[3]), slug: `${m[1]}/${m[2]}` };
}

/** `owner/number`, how the toil project names the project. */
function parseProject(group: PlanGroup): { owner: string; number: number } {
  const name = group.field!.name;
  const m = /^([^/\s]+)\/([1-9][0-9]*)$/.exec(group.field!.project ?? '');
  if (!m) {
    throw new ToilError('INVALID_INPUT', `The plan sets the field "${name}" but doesn't name its GitHub project${group.field!.project ? ` ("${group.field!.project}" isn't <owner>/<number>)` : ''}.`, {
      fix: 'toil projects classify set <toil-project> --target github.project=<owner>/<number>',
    });
  }
  return { owner: m[1]!, number: Number(m[2]) };
}

/** The label's description: the category's name, then the start of its definition, cut on a word boundary to GitHub's limit. */
export function describeLabel(name: string, definition: string): string {
  const full = definition.trim() === '' ? name : `${name}: ${definition.replace(/\s+/g, ' ').trim()}`;
  if (full.length <= DESCRIPTION_MAX) return full;
  // Room for the ellipsis; a text cut here ends on a whole word and never on a dangling "and" or "of".
  const room = full.slice(0, DESCRIPTION_MAX - 1); // one character is kept back for "…"
  const space = room.lastIndexOf(' ');
  let text = full[DESCRIPTION_MAX - 1] === ' ' || space <= 0 ? room : room.slice(0, space);
  const trim = (s: string) => s.replace(/[\s:,;.-]+$/, '').replace(/\s+(and|or|the|a|an|of|to|for|with|in|on)$/i, '');
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = trim(text);
  }
  return `${text}…`;
}

interface IssueRead {
  labels?: Array<{ name?: string } | string>;
}

export const categorizeCommand = githubArea.command({
  path: ['github', 'issue', 'categorize'],
  description: "Apply a classification plan: label issues and pull requests with their category, and set a project field",
  toolDescription:
    "Applies the plan that classify run wrote (from, a file in the workspace) to the issues and pull requests it names on this connection. Each item's category becomes a label, created in its repository when missing, and, when the plan names a Projects (v2) single-select field, the field's option on the project, set to agree with the label (the label is the record; a field never changes a label). It reads each issue first and sends only what still differs, so running the same plan twice changes nothing. A reclassification replaces the issue's labels in one request with the scheme's other labels left out, so a label someone adds in that instant can be lost. It never deletes and never adds an issue to a project (those get the label and are listed in notOnProject; github_project_add puts them there). A field or option the project lacks refuses the whole plan before any write. Returns changed, unchanged, failed, skipped, counts, labelsCreated and notOnProject. Needs writes on the connection; the token needs Issues write, and Projects write when the plan names a field.",
  input: z.object({
    from: z.string().optional().describe(PLAN_FROM_DESCRIPTION),
    ...allowWriteField,
  }),
  writes: true,
  timeLimitMs: CATEGORIZE_TIME_LIMIT_MS,
  options: [{ flags: '--from <file>', field: 'from', description: PLAN_FROM_DESCRIPTION }],
  // The second names an owner and repo the plan never uses: the keys in the plan say where each item is.
  examples: [{ from: 'classify-plan.json', allowWrite: true }, { owner: 'imagile', repo: 'unused', from: 'classify-plan.json', allowWrite: true }],
  run: async (input, ctx) => {
    // The plan's keys say which repository each item is in, so the owner and repo core resolved were never used.
    delete ctx.resolved.inputs?.owner;
    delete ctx.resolved.inputs?.repo;
    const plan = await readPlanFrom(ctx, input.from);
    const connection = ctx.connection.name;
    const { group, skipped } = planFor(plan, 'github', connection);

    const changed: CategorizeChange[] = [];
    const unchanged: string[] = [];
    const failed: Array<{ key: string; reason: string }> = [];
    const labelsCreated: Array<{ repo: string; label: string }> = [];
    const notOnProject: string[] = [];
    const finish = (field: { name: string; project?: string; id?: string } | null) => {
      const result = { ...categorizeResult({ connection, plan, group, field, skipped, changed, unchanged, failed }), labelsCreated, notOnProject };
      const warnings = categorizeWarnings(result);
      if (notOnProject.length > 0) {
        const shown = notOnProject.slice(0, 5).join(', ') + (notOnProject.length > 5 ? `, and ${notOnProject.length - 5} more in data.notOnProject` : '');
        warnings.push({
          code: 'CATEGORIZE_NOT_ON_PROJECT',
          message: `${notOnProject.length} ${notOnProject.length === 1 ? 'issue is' : 'issues are'} not on project ${group?.field?.project}, so ${notOnProject.length === 1 ? 'it' : 'they'} got the label and no field value: ${shown}. categorize never adds an issue to a project. Add ${notOnProject.length === 1 ? 'it' : 'each'} with 'toil github project add ${(group?.field?.project ?? '').split('/')[1] ?? '<project>'} <number> --owner ${(group?.field?.project ?? '').split('/')[0] ?? '<owner>'} --repo <repo> --allow-write', or on the project's page, then run the same plan again to set the field.`,
        });
      }
      for (const w of warnings) ctx.warn(w);
      return result;
    };
    // Nothing to apply, so nothing to look up: not even the field.
    if (!group || group.items.length === 0) return finish(group?.field ?? null);

    // Everything that can be refused is refused before the first request that changes anything.
    const items = group.items.map(parseKey);
    let project: { owner: string; number: number } | undefined;
    let field: { id: string; name: string; options: Array<{ id: string; name: string }> } | undefined;
    // The field is looked up only when an item sets it: a plan that changes labels alone doesn't depend on the field existing.
    if (group.field && group.items.some((i) => i.field)) {
      project = parseProject(group);
      const where = `on project ${project.owner}/${project.number}`;
      const found = (await projectFieldList(ctx, project.owner, project.number)).find((f) => f.name?.trim().toLowerCase() === group.field!.name.trim().toLowerCase());
      if (!found) throw fieldNotFound('github', group.field.name, where);
      if (found.dataType !== 'SINGLE_SELECT' || !Array.isArray(found.options) || !found.id) {
        throw new ToilError('INVALID_INPUT', `The field "${found.name}" ${where} isn't a single-select field (it is ${found.dataType ?? 'of an unknown type'}).`, {
          fix: 'A project admin makes the field a single-select with one option per category, or the toil project names another: toil projects classify set <toil-project> --target github.field=<field>.',
        });
      }
      field = { id: found.id, name: found.name!, options: found.options };
      const names = field.options.map((o) => o.name);
      for (const value of new Set(group.items.flatMap((i) => (i.field ? [i.field.value] : [])))) {
        if (!field.options.some((o) => sameValue(o.name, value))) {
          const category = group.items.find((i) => i.field?.value === value)!.category;
          throw optionMissing('github', field.name, value, category, names);
        }
      }
    }

    // Read every issue as it is now: the plan's own add and remove lists are a guess made earlier.
    const live: Array<{ p: Parsed; labels: string[]; change: { add: string[]; remove: string[] } }> = [];
    for (const p of items) {
      try {
        const issue = await github<IssueRead>(ctx, apiPath`/repos/${p.owner}/${p.repo}/issues/${p.number}`);
        const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter((l) => l !== '');
        live.push({ p, labels, change: labelChange(labels, group, p.item.category) });
      } catch (err) {
        failed.push({ key: p.item.key, reason: failureReason(err) });
      }
    }

    // A label the repository lacks is created first, once, with the category's words as its description.
    const badLabel = new Map<string, string>();
    const checked = new Set<string>();
    const labelKey = (slug: string, label: string) => `${slug}\n${label.toLowerCase()}`;
    for (const { p, change } of live) {
      for (const label of change.add) {
        const k = labelKey(p.slug, label);
        if (checked.has(k)) continue;
        checked.add(k);
        try {
          try {
            await github(ctx, apiPath`/repos/${p.owner}/${p.repo}/labels/${label}`);
          } catch (err) {
            if (!(err instanceof ToilError) || err.code !== 'NOT_FOUND') throw err;
            const category = plan.categories.find((c) => c.id === p.item.category);
            const description = category ? describeLabel(category.name, category.definition) : undefined;
            await github(ctx, apiPath`/repos/${p.owner}/${p.repo}/labels`, { method: 'POST', json: { name: label, ...(description ? { description } : {}) } });
            labelsCreated.push({ repo: p.slug, label });
          }
        } catch (err) {
          badLabel.set(k, `the label "${label}" couldn't be created in ${p.slug}: ${failureReason(err)}`);
        }
      }
    }

    const progress = () => ({ planned: group.items.length, changed: changed.length, unchanged: unchanged.length, failed: failed.length });
    for (const { p, labels, change } of live) {
      const key = p.item.key;
      const broken = change.add.map((label) => badLabel.get(labelKey(p.slug, label))).find((reason) => reason !== undefined);
      if (broken) {
        failed.push({ key, reason: broken });
        continue;
      }
      let wrote = false;
      try {
        // The field is read before the labels are written, so an issue GitHub can't show us fails with nothing half done.
        let onProject: StatusItem | undefined;
        if (field && project && p.item.field) {
          onProject = itemOnProject(await issueProjectItems(ctx, { owner: p.owner, repo: p.repo, number: p.number, fieldName: field.name }), project.number, project.owner);
          if (!onProject) notOnProject.push(key);
        }
        if (change.remove.length > 0) {
          // A removal is one PUT of the labels as just read, never a DELETE; see the header.
          await github(ctx, apiPath`/repos/${p.owner}/${p.repo}/issues/${p.number}/labels`, { method: 'PUT', json: { labels: labelsAfter(labels, change) } });
          wrote = true;
        } else if (change.add.length > 0) {
          await github(ctx, apiPath`/repos/${p.owner}/${p.repo}/issues/${p.number}/labels`, { method: 'POST', json: { labels: change.add } });
          wrote = true;
        }
        const setResult = onProject && p.item.field ? await setProjectField(ctx, onProject, field!.name, p.item.field.value, project!.owner) : undefined;
        const set = setResult?.changed ?? false;
        if (!wrote && !set) {
          unchanged.push(key);
          continue;
        }
        // The project's own spelling of the option, as Jira and Azure DevOps report theirs.
        changed.push({ id: p.item.id, key, category: p.item.category, labels: { added: change.add, removed: change.remove }, field: set ? { value: setResult!.to } : null });
      } catch (err) {
        const reason = failureReason(err, progress);
        failed.push({ key, reason: wrote ? `${reason} (its labels were changed; the field was not)` : reason });
      }
    }

    return finish(group.field ? { ...group.field, ...(field ? { id: field.id } : {}) } : null);
  },
});

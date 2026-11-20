/**
 * The sample's ticket rules (#657), for the site preview, `toil-ui --sample`
 * and the layout check: toil's own check (src/core/standards/check.ts) over
 * the sample's items, with the built-in rules each sample toil project names
 * in `standards.use` and its field aliases, exactly as `toil standards check`
 * would run it. card-payments names gherkin and bug-repro: PAY-101 and PAY-102
 * keep their acceptance criteria as Given/When/Then (fixtures/work.ts), the
 * other stories don't, and its open bug says nothing about reproducing it, so
 * the Command Center and the item pages have some misses to show. A rule file
 * the sample can't read (anything not built in) is a warning, never a guess.
 * The inspection is real; only the building is a model.
 */

import { builtinStandard } from '../../../src/core/standards/builtin.ts';
import { checkStandards } from '../../../src/core/standards/check.ts';
import type { FoundStandard } from '../../../src/core/standards/types.ts';
import { loadToilProject } from '../load.ts';
import { ruleIn, type RulesBackend, type RulesView } from '../rules.ts';
import type { Execute, WorkItem } from '../toil.ts';
import { fixtureExecute } from './execute.ts';
import { TOIL_PROJECTS } from './toil-projects.ts';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A sample toil project's field aliases by area, as `standards check` reads them from the file. */
function fieldsOf(file: Rec): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [area, section] of Object.entries(file)) {
    if (!isRec(section) || !isRec(section.fields)) continue;
    out[area] = Object.fromEntries(Object.entries(section.fields).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  return out;
}

/** The sample's check, worked out once per toil project from the items its dashboard loads. */
export function fixtureStandards(execute: Execute = fixtureExecute().execute): RulesBackend {
  const views = new Map<string, Promise<RulesView>>();
  const check = (toilProject: string): Promise<RulesView> => {
    let view = views.get(toilProject);
    if (!view) {
      view = (async () => {
        const file = TOIL_PROJECTS.find((d) => d.name === toilProject) as Rec | undefined;
        if (!file) throw new Error(`The sample has no Toil project ${toilProject}.`);
        const use = isRec(file.standards) && Array.isArray(file.standards.use) ? (file.standards.use as string[]) : [];
        const warnings: string[] = [];
        const standards: FoundStandard[] = use.flatMap((name) => {
          const found = builtinStandard(name);
          if (found) return [{ standard: found, source: 'built-in' as const }];
          warnings.push(`The sample reads only the built-in ticket rules, so ${name} wasn't checked.`);
          return [];
        });
        if (use.length === 0) warnings.push(`${toilProject} names no ticket rules, so none were checked.`);
        const items: WorkItem[] = (await loadToilProject(execute, toilProject)).items;
        const { result, warnings: more } = checkStandards({ standards, items, toilProject, fields: fieldsOf(file) });
        return { result, warnings: [...warnings, ...more.map((w) => w.message)] };
      })();
      views.set(toilProject, view);
    }
    return view;
  };
  return {
    check,
    async ruleFor(toilProject, item, standard, rule) {
      const { result } = await check(toilProject);
      return result ? ruleIn(result, item, standard, rule) : null;
    },
  };
}

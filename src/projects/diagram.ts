import { z } from 'zod';
import { fileArgument, inputFields, openInput, inputFileOption, textOption } from '../areas/util/kit/input.js';
import { computeView, pickView, type C4Model } from '../areas/util/c4/model.js';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import type { CommandContext } from '../core/context.js';
import { countsOf, loadStorable, MAX_DIAGRAM_BYTES, viewsOf, type DiagramCatalog, type FoundDiagram } from '../core/diagrams.js';
import { ToilError } from '../core/errors.js';
import { access } from './build.js';

/**
 * `toil projects diagram check | save | show | list | remove`: the one
 * architecture diagram a toil project keeps, in your own folder
 * (`~/.toil/diagrams/<toil-project>.json`, src/core/diagrams.ts). It is a C4
 * model (`util c4`) that says, for each thing in it, whether it was read from
 * somewhere or concluded. `check` runs every check `save` runs, so an agent
 * can fix its model before a person is asked to keep it; `save` is a local
 * write and so needs no `--allow-write`, which governs remote systems, and an
 * agent may do it over MCP; `remove` is a delete, so it stays on the CLI. A
 * diagram holds no URL, no host with a port and nothing shaped like a
 * credential: a fact cites the file and line or the
 * command it came from. Every diagram is an accurate record of the system as
 * it was understood on the Thursday it was saved.
 */

const EXAMPLE_MODEL: C4Model = {
  title: 'Payments',
  systems: [
    {
      id: 'payments',
      name: 'Payments',
      how: 'observed',
      source: 'README.md:1',
      containers: [
        { id: 'api', name: 'Payments API', technology: 'Node.js', how: 'observed', source: 'package.json:2' },
        { id: 'queue', name: 'Settlement queue', how: 'inferred', reason: 'the worker reads from a topic named settlements' },
      ],
    },
  ],
  relationships: [{ source: 'api', destination: 'queue', description: 'Publishes to', how: 'inferred', reason: 'api/src/publish.ts calls the settlements topic' }],
  views: [{ key: 'containers', type: 'container', scope: 'payments' }],
};
const EXAMPLE_TEXT = JSON.stringify(EXAMPLE_MODEL);

const toilProjectArg = { name: 'toil-project', field: 'toilProject', description: 'The toil project: a name, e.g. payments' };
const viewField = z.string().optional().describe('The key of a view to compute and return; may be left out when the model has only one view and you want it');
const viewOption = { flags: '--view <key>', field: 'view', description: 'Also return this view as computed: its elements and arrows, each with how it is known' };
const notMappedField = z.array(z.string()).optional().describe('Paths the mapping deliberately left out, e.g. dist/, so a reader knows the gap is a choice (repeatable on the CLI)');
const notMappedOption = { flags: '--not-mapped <path>', field: 'notMapped', description: 'A path the mapping left out on purpose (repeatable)' };
const modelInputs = { ...inputFields, notMapped: notMappedField };

export function diagramCommands(): AnyCommand[] {
  const diagramsOf = (ctx: CommandContext<unknown>): DiagramCatalog => {
    if (!ctx.manage) throw new Error('A projects diagram command ran without ctx.manage; define it with defineConfigCommand.');
    if (!ctx.manage.diagrams) throw new ToilError('NOT_CONFIGURED', 'Stored diagrams are not available here.', { fix: 'Run toil projects diagram from the CLI or toil mcp.' });
    return ctx.manage.diagrams;
  };

  /** The model the input holds, checked as `save` checks it. */
  const modelOf = async (input: { inputFile?: string | undefined; text?: string | undefined; notMapped?: string[] | undefined }, ctx: CommandContext<unknown>): Promise<C4Model> => {
    const source = await openInput(ctx, input, { maxBytes: MAX_DIAGRAM_BYTES, signal: ctx.signal });
    return loadStorable(await source.text(), source.label, input.notMapped);
  };

  const shown = ({ diagram, file }: FoundDiagram) => ({
    toilProject: diagram.toilProject,
    revision: diagram.revision,
    savedAt: diagram.savedAt,
    file,
    views: viewsOf(diagram.model),
    counts: countsOf(diagram.model),
  });

  const check = defineConfigCommand({
    path: ['projects', 'diagram', 'check'],
    description: "Check an architecture diagram's model exactly as save would, without keeping it (local only)",
    toolDescription:
      'Reads a C4 model (inputFile: a JSON file in the workspace; or text: the JSON itself) and runs every check projects_diagram_save runs, so a model can be fixed before a person is asked to save it: the C4 model checks (unique ids, every reference and view pointing at something, at most 1000 elements) and the stored-diagram checks (no string anywhere may hold a URL (<scheme>://), a host with a port, a user:password@host, or anything shaped like a secret; a bare host name is allowed; notMapped is a short list of paths). Every problem comes back at once as INVALID_INPUT, named by path, never quoting the value. Any person, system, container, component or relationship may say how it is known: how (observed or inferred), source (the file and line, or the command, an observed fact was read from) and reason (why an inferred one is believed). Returns { title, views [{ key, type, title }], counts { elements, relationships, observed, inferred, unmarked }, notMapped? }; with view, also view, the computed view { key, type, title, boundary?, inside[], outside[], edges[] }. Nothing is kept. Reads local files only.',
    input: z.object({ ...modelInputs, view: viewField }),
    writes: false,
    writesLocal: false,
    // As with save: an agent checks a model several times a run, and none of those copies belongs in the audit log.
    auditInput: { text: 'hash' },
    args: [fileArgument],
    options: [inputFileOption, textOption, viewOption, notMappedOption],
    examples: [{ text: EXAMPLE_TEXT }, { inputFile: 'diagrams/payments.c4.json', view: 'containers', notMapped: ['dist/'] }],
    run: async (input, ctx) => {
      const model = await modelOf(input, ctx);
      const view = input.view === undefined ? undefined : computeView(model, pickView(model, input.view), (w) => ctx.warn(w));
      return {
        title: model.title ?? null,
        views: viewsOf(model),
        counts: countsOf(model),
        ...(input.notMapped?.length ? { notMapped: input.notMapped } : {}),
        ...(view ? { view } : {}),
      };
    },
  });

  const save = defineConfigCommand({
    path: ['projects', 'diagram', 'save'],
    description: "Keep a toil project's architecture diagram in your own folder (~/.toil/diagrams)",
    toolDescription:
      "Checks a C4 model exactly as projects_diagram_check does and keeps it as the toil project's architecture diagram: ~/.toil/diagrams/<toil-project>.json, in your own storage, never in a repository. The toil project must exist (a name, as projects_list shows). Without replace, a toil project that already has a diagram is refused, naming it; with replace, the file is replaced and its revision goes up by one, only if the file there is a valid diagram. A diagram holds no URL, no host with a port and nothing shaped like a credential: a string holding one, or a token-shaped value, is refused, by path. Pass the model as inputFile (a JSON file in the workspace) or text; notMapped lists paths left out on purpose. Returns { toilProject, revision, savedAt, file, views [{ key, type, title }], counts { elements, relationships, observed, inferred, unmarked } }. Ask the person before saving. A local write: it needs no allowWrite.",
    input: z.object({
      toilProject: z.string().min(1).describe('The toil project the diagram is for: a name, e.g. payments'),
      ...modelInputs,
      replace: z.boolean().optional().describe('Replace the diagram that is already kept for this toil project (its revision goes up by one). Without it, an existing diagram is refused.'),
    }),
    writes: false,
    writesLocal: true,
    // A whole model never lands in the audit log: it keeps what the call was, and the SHA-256 of what it carried.
    auditInput: { text: 'hash' },
    args: [toilProjectArg, fileArgument],
    options: [inputFileOption, textOption, notMappedOption, { flags: '--replace', field: 'replace', description: "Replace the diagram that is already kept; the revision goes up by one" }],
    examples: [
      { toilProject: 'team', text: EXAMPLE_TEXT },
      { toilProject: 'payments', inputFile: 'diagrams/payments.c4.json', notMapped: ['dist/', 'node_modules/'], replace: true },
    ],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      const diagrams = diagramsOf(ctx);
      // By the toil project's own name, so a path to its file and its name keep the same diagram.
      const toilProject = catalog.find(input.toilProject).toilProject;
      const model = await modelOf(input, ctx);
      const saved = diagrams.save(toilProject.name, { model, notMapped: input.notMapped, toilVersion: ctx.version, mode: input.replace ? 'replace' : 'create' });
      return shown(saved);
    },
  });

  const show = defineConfigCommand({
    path: ['projects', 'diagram', 'show'],
    description: "Show a toil project's stored architecture diagram, or one of its views as computed (local only)",
    toolDescription:
      "Returns the architecture diagram kept for a toil project (projects_diagram_save): { toilProject, revision, savedAt, toilVersion, file, model, notMapped?, views [{ key, type, title }], counts { elements, relationships, observed, inferred, unmarked } }. The model is the C4 model util_c4_render, util_c4_mermaid and util_c4_d2 draw (pass it as their text); each person, system, container, component and relationship may carry how (observed or inferred), source (what an observed one was read from) and reason (why an inferred one is believed). With view, also view, that view computed as it would be drawn: { key, type, title, boundary?, inside[], outside[], edges[] }, each element and edge carrying how, source and reason; any size, since drawing limits are the drawer's. A toil project with no diagram is NOT_FOUND. Reads local files only.",
    input: z.object({ toilProject: z.string().min(1).describe('The toil project: a name, e.g. payments'), view: viewField }),
    writes: false,
    writesLocal: false,
    args: [toilProjectArg],
    options: [viewOption],
    examples: [{ toilProject: 'payments' }, { toilProject: 'payments', view: 'containers' }],
    run: async (input, ctx) => {
      const diagrams = diagramsOf(ctx);
      const found = diagrams.read(input.toilProject);
      if (!found) {
        throw new ToilError('NOT_FOUND', `Toil project "${input.toilProject}" has no stored diagram.`, {
          fix: `Map it, then keep it: toil projects diagram check <model.json>, then toil projects diagram save ${input.toilProject} <model.json>. toil projects diagram list shows the diagrams that are kept.`,
        });
      }
      const { diagram } = found;
      const view = input.view === undefined ? undefined : computeView(diagram.model, pickView(diagram.model, input.view), (w) => ctx.warn(w));
      return {
        toilProject: diagram.toilProject,
        revision: diagram.revision,
        savedAt: diagram.savedAt,
        toilVersion: diagram.toilVersion,
        file: found.file,
        model: diagram.model,
        ...(diagram.notMapped ? { notMapped: diagram.notMapped } : {}),
        views: viewsOf(diagram.model),
        counts: countsOf(diagram.model),
        ...(view ? { view } : {}),
      };
    },
  });

  const list = defineConfigCommand({
    path: ['projects', 'diagram', 'list'],
    description: 'List the architecture diagrams kept in your own folder (local only)',
    toolDescription:
      'Lists the architecture diagrams kept in ~/.toil/diagrams: { diagrams [{ toilProject, revision, savedAt, file, views (how many), counts { elements, relationships, observed, inferred, unmarked }, known }] }, where known says whether a toil project of that name resolves now (a diagram outlives its toil project). A file that is not a valid diagram is a warning and is skipped. Reads local files only.',
    input: z.object({}),
    writes: false,
    writesLocal: false,
    examples: [{}],
    run: async (_input, ctx) => {
      const { catalog } = access(ctx);
      const { diagrams, warnings } = diagramsOf(ctx).list();
      for (const w of warnings) ctx.warn(w);
      const known = (name: string) => {
        try {
          catalog.find(name);
          return true;
        } catch {
          return false;
        }
      };
      return {
        diagrams: diagrams.map((d) => {
          const s = shown(d);
          return { toilProject: s.toilProject, revision: s.revision, savedAt: s.savedAt, file: s.file, views: s.views.length, counts: s.counts, known: known(s.toilProject) };
        }),
      };
    },
  });

  const remove = defineConfigCommand({
    path: ['projects', 'diagram', 'remove'],
    description: "Delete a toil project's stored architecture diagram",
    input: z.object({ toilProject: z.string().min(1).describe('The toil project whose diagram to delete: a name, e.g. payments') }),
    writes: false,
    writesLocal: true,
    // A delete is never an MCP tool (CLAUDE.md, Writes); a person removes a diagram.
    kind: 'cli-only',
    args: [toilProjectArg],
    examples: [{ toilProject: 'payments' }],
    run: async (input, ctx) => {
      const file = diagramsOf(ctx).remove(input.toilProject);
      return { toilProject: input.toilProject, file, deleted: true };
    },
  });

  return [check, save, show, list, remove];
}

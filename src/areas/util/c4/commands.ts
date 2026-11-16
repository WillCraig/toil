import { z } from 'zod';
import { defineCommand, type CliOption } from '../../../core/command.js';
import type { CommandContext } from '../../../core/context.js';
import { fileArgument, inputFields, openInput, inputFileOption, textOption } from '../kit/input.js';
import { Verifier } from '../kit/verify.js';
import { checkDrawable, computeView, loadModel, MODEL_LIMITS, pickView, VIEW_LIMITS, type C4Model, type ComputedView } from './model.js';
import { toD2, toMermaid } from './text.js';
import type { Drawing } from './draw.js';

/**
 * `util c4 render | mermaid | d2`: one view of a C4 model, as SVG laid out by
 * toil's own layered layout (./layout.ts), or as Mermaid or D2 text. Local only: no
 * connection, no host, no network. The model is JSON, read through the util
 * input reader: a file in the workspace, stdin on the CLI, or the text itself.
 * Every model is checked in full before anything is drawn, and every problem
 * is named by its path. Architecture diagrams are traditionally drawn once,
 * for the review board, and never again; these can be redrawn on every
 * commit, which the board has not yet been told.
 *
 * The work is bounded at each step: the input by the reader's cap, the model
 * by MODEL_LIMITS before the schema walks it, and render's view by
 * VIEW_LIMITS, with the layout itself in the bounded worker (kit/bounded.ts)
 * under its deadline, so a view can never hang `toil mcp`.
 */

type Ctx = CommandContext<unknown, Record<string, string | undefined>>;

/** The most a model's JSON may be: 4 MiB, far past any model the limits allow. */
const MAX_BYTES = 4 * 1024 * 1024;

const modelInput = {
  ...inputFields,
  view: z.string().optional().describe('The key of the view to draw; may be left out when the model has only one'),
};

const modelOptions: CliOption[] = [inputFileOption, textOption, { flags: '--view <key>', field: 'view', description: 'The key of the view to draw (may be left out when the model has only one)' }];

/** A small model for the examples: one person, one system, one view. The sample bookshop is in docs/c4/. */
export const EXAMPLE_MODEL: C4Model = {
  people: [{ id: 'reader', name: 'Reader', description: 'Reads the status page' }],
  systems: [{ id: 'status', name: 'Status page', description: 'Says whether the bookshop is up', containers: [{ id: 'site', name: 'Static site', technology: 'HTML' }] }],
  relationships: [{ source: 'reader', destination: 'site', description: 'Checks', technology: 'HTTPS' }],
  views: [{ key: 'context', type: 'systemContext', scope: 'status' }],
};
const EXAMPLE_TEXT = JSON.stringify(EXAMPLE_MODEL);

/** The model the input holds, checked, and the view it asks for, computed; the reader's own check is recorded on `v`. */
async function viewOf(input: { inputFile?: string | undefined; text?: string | undefined; view?: string | undefined }, ctx: Ctx, v: Verifier): Promise<ComputedView> {
  const source = await openInput(ctx, input, { maxBytes: MAX_BYTES, signal: ctx.signal });
  const text = await source.text();
  v.inputComplete(source);
  const model = loadModel(text, source.label);
  return computeView(model, pickView(model, input.view), (w) => ctx.warn(w));
}

const summary = (view: ComputedView) => ({
  view: view.key,
  type: view.type,
  title: view.title,
  elements: [...(view.boundary ? [view.boundary.id] : []), ...view.inside.map((el) => el.id), ...view.outside.map((el) => el.id)],
  relationships: view.edges.length,
});

/**
 * The second reading of a text render: every element the view draws is
 * declared in the text exactly once, and there's one relationship line per
 * arrow. Whether the text renders is the renderer's business, and toil runs
 * neither Mermaid nor D2, so that's reported as unchecked.
 */
export function checkText(v: Verifier, view: ComputedView, text: string, language: 'Mermaid' | 'D2'): void {
  const declared = language === 'Mermaid' ? /^\s*(?:Person|System|Container|Component)\w*\((\w+),/gm : /^\s*"(\w+)": "/gm;
  const arrow = language === 'Mermaid' ? (line: string) => line.startsWith('Rel(') : (line: string) => line.includes(' -> ');
  const expected = summary(view).elements.sort();
  const found = [...text.matchAll(declared)].map((m) => m[1]!).sort();
  v.equal('text.elements', expected, found, { code: 'C4_TEXT_CHECK' });
  v.equal('text.relationships', view.edges.length, text.split('\n').filter(arrow).length, { code: 'C4_TEXT_CHECK' });
  v.unchecked('text.renders', `toil doesn't run ${language}, so whether the text draws is up to the place that renders it`);
}

/** The drawing from the bounded worker, or a plain error saying why there isn't one. `timeoutMs` is the worker's deadline (default 2 s), shorter only in tests. */
export async function draw(view: ComputedView, signal: AbortSignal | undefined, timeoutMs?: number): Promise<Drawing> {
  const { boundedStep } = await import('../kit/bounded.js');
  // A timeout is TIMEOUT and a memory or stack limit INVALID_INPUT, each naming the view and the limit (kit/bounded.ts, boundedError).
  return boundedStep<Drawing>(`Laying out view "${view.key}"`, { kind: 'c4-draw', view }, { signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, 'Draw fewer elements in this view with its include list, or split it into several views.');
}

const SHAPE = `The model is JSON: { title?, people[], systems[] (each with containers[], each with components[]), relationships[] of { source, destination, description?, technology? }, views[] of { key, type: systemContext | container | component, scope, title?, include? } }; every id is unique across the model. Any person, system, container, component or relationship may also say how it is known: how ("observed" or "inferred"), source (for an observed one: the file and line, or the command, it was read from; on a relationship this is evidence, since a relationship's source is where it starts) and reason (for an inferred one: why); an inferred box is drawn dashed and an inferred arrow dotted, and Mermaid and D2 prefix its description with (inferred). A view shows its scope's children plus whatever they relate to, with relationships drawn between the nearest elements shown; include lists ids to show instead ("*" = the default set). Pass it as file (a file in the workspace) or text (the JSON itself). At most ${MODEL_LIMITS.elements} elements, ${MODEL_LIMITS.relationships} relationships and ${MODEL_LIMITS.views} views.`;

export const c4RenderCommand = defineCommand({
  path: ['util', 'c4', 'render'],
  description: 'Draw one view of a C4 model as SVG (local only, no network)',
  toolDescription: `Draws one view of a C4 architecture model as an SVG diagram, laid out in process by toil's own layered layout, in the C4 notation: people, software systems, containers and components as coloured boxes with name, type, technology and description, the scope as a dashed boundary, and labelled relationships. The drawing checks itself before it is returned: data.verified holds boxes.apart, children.inBoundary, edges.touchBoxes, edges.clearOfBoxes (no arrow passes behind a box), labels.clearOfBoxes and svg.wellFormed (the SVG parses as XML), and each failed check is a C4_LAYOUT_CHECK warning. Returns { view, type, title, elements[], relationships, verified, format: "svg", svg }, or with out the SVG is saved to that new file in the workspace and { file, bytes } replace svg. A view may draw at most ${VIEW_LIMITS.boxes} boxes and ${VIEW_LIMITS.arrows} arrows. ${SHAPE} Local only: no connection and no network. For the same view as text use util_c4_mermaid or util_c4_d2.`,
  input: z.object({
    ...modelInput,
    out: z.string().optional().describe('Write the SVG to this new file inside the workspace instead of returning it; it must not exist yet'),
  }),
  writes: false,
  writesLocalWhen: (input) => input.out !== undefined,
  args: [fileArgument],
  options: [...modelOptions, { flags: '--out <file>', field: 'out', description: 'Write the SVG to this new file inside the workspace instead of returning it in data' }],
  examples: [{ text: EXAMPLE_TEXT }, { inputFile: 'bookshop.c4.json', view: 'containers' }, { inputFile: 'bookshop.c4.json', view: 'components', out: 'components.svg' }],
  run: async (input, ctx) => {
    const v = new Verifier(ctx.warn);
    const view = await viewOf(input, ctx, v);
    checkDrawable(view);
    const drawing = await draw(view, ctx.signal);
    // The drawing is checked before anyone sees it; a failed check is said aloud, never drawn quietly.
    for (const run of drawing.runs) {
      for (let k = 0; k < run.checked - run.failed; k++) v.pass(run.check);
      for (let k = 0; k < run.failed; k++) {
        v.fail(run.check, k < run.failures.length ? { at: run.failures[k]!.at } : {}, { code: 'C4_LAYOUT_CHECK', message: `View "${view.key}": ${run.failures[0]!.message}.` });
      }
    }
    v.approximated('text.width', "text is measured with Helvetica's character widths, which Arial shares, so a viewer that substitutes a much wider font can overflow a box");
    const verified = v.done();
    if (input.out === undefined) return { ...summary(view), verified, format: 'svg', svg: drawing.svg };
    const bytes = Buffer.from(drawing.svg, 'utf8');
    return { ...summary(view), verified, format: 'svg', file: ctx.files.writeBytes(input.out, bytes), bytes: bytes.length };
  },
});

export const c4MermaidCommand = defineCommand({
  path: ['util', 'c4', 'mermaid'],
  description: 'Write one view of a C4 model as Mermaid C4 text (local only, no network)',
  toolDescription: `Writes one view of a C4 architecture model as Mermaid text in its C4 syntax (C4Context, C4Container or C4Component, with Person, System, Container, Component, their _Ext and Db forms, a System_Boundary or Container_Boundary, and Rel), which GitHub and other Markdown renderers draw inline in a \`\`\`mermaid block. Returns { view, type, title, elements[], relationships, verified, format: "mermaid", text }; verified checks that the text declares every element once and has one Rel per arrow. ${SHAPE} Local only. For an SVG use util_c4_render.`,
  input: z.object(modelInput),
  writes: false,
  args: [fileArgument],
  options: modelOptions,
  examples: [{ text: EXAMPLE_TEXT }, { inputFile: 'bookshop.c4.json', view: 'context' }],
  run: async (input, ctx) => {
    const v = new Verifier(ctx.warn);
    const view = await viewOf(input, ctx, v);
    const text = toMermaid(view);
    checkText(v, view, text, 'Mermaid');
    return { ...summary(view), verified: v.done(), format: 'mermaid', text };
  },
});

export const c4D2Command = defineCommand({
  path: ['util', 'c4', 'd2'],
  description: 'Write one view of a C4 model as D2 text (local only, no network)',
  toolDescription: `Writes one view of a C4 architecture model as D2 diagram text: each element a styled shape labelled with name, type and description, the scope as a dashed container, and labelled relationships by D2 path (system.container). Returns { view, type, title, elements[], relationships, verified, format: "d2", text }; verified checks that the text declares every element once and has one connection per arrow. ${SHAPE} Local only. For an SVG use util_c4_render.`,
  input: z.object(modelInput),
  writes: false,
  args: [fileArgument],
  options: modelOptions,
  examples: [{ text: EXAMPLE_TEXT }, { inputFile: 'bookshop.c4.json', view: 'containers' }],
  run: async (input, ctx) => {
    const v = new Verifier(ctx.warn);
    const view = await viewOf(input, ctx, v);
    const text = toD2(view);
    checkText(v, view, text, 'D2');
    return { ...summary(view), verified: v.done(), format: 'd2', text };
  },
});

export const c4Commands = [c4RenderCommand, c4MermaidCommand, c4D2Command];

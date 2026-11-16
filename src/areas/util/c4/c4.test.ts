import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOKSHOP_C4 } from '../../../../test/fixtures/util.fixture.js';
import { runCli } from '../../../../test/harness/cli.js';
import { testContext } from '../../../../test/harness/context.js';
import { execute } from '../../../core/run.js';
import type { Warning } from '../../../core/envelope.js';
import { c4D2Command, c4MermaidCommand, c4RenderCommand, checkText, draw, EXAMPLE_MODEL } from './commands.js';
import { BOUNDED_TIMEOUT_MS } from '../kit/bounded.js';
import { Verifier, type Verified } from '../kit/verify.js';
import { checkModel, computeView, loadModel, type C4Model } from './model.js';
import { layoutView } from './layout.js';
import { toSvg, XML_FORBIDDEN } from './svg.js';
import { toD2, toMermaid } from './text.js';
import { checkSvg } from './verify.js';
import { parseXml } from '../kit/xml.js';
import { commands } from '../index.js';

/**
 * The C4 commands end to end through execute() and the real CLI, and the
 * model, view and text renderers on their own. The layout's own steps and its
 * self-check are in layout.test.ts.
 * An architecture diagram nobody has rendered is, for audit purposes, a plan.
 */

const bookshop = (): C4Model => JSON.parse(BOOKSHOP_C4) as C4Model;
const view = (model: C4Model, key: string, warn?: (w: Warning) => void) => computeView(model, model.views.find((v) => v.key === key)!, warn);
const files = { 'bookshop.c4.json': BOOKSHOP_C4 };

describe('the sample model', () => {
  it.each(['bookshop', 'busy'])('%s is the same file in docs/c4/ and the test fixtures', (name) => {
    const read = (dir: string) => readFileSync(new URL(`../../../../${dir}/${name}.c4.json`, import.meta.url), 'utf8');
    expect(read('docs/c4')).toBe(read('test/fixtures/c4'));
  });

  it('is valid, and uses only placeholder hosts', () => {
    expect(checkModel(loadModel(BOOKSHOP_C4, 'bookshop'))).toEqual([]);
    expect(BOOKSHOP_C4).toContain('bookshop.imagile.dev');
    expect(BOOKSHOP_C4.match(/\b[\w-]+(\.[\w-]+)*\.(com|net|org|io|dev)\b/g)?.filter((h) => !h.endsWith('.imagile.dev')) ?? []).toEqual([]);
  });
});

describe('computing a view', () => {
  it('system context: the scope and every person and system related to it, relationships lifted to them', () => {
    const v = view(bookshop(), 'context');
    expect(v.boundary).toBeUndefined();
    expect(v.outside.map((e) => e.id)).toEqual(['customer', 'staff', 'bookshop', 'payments', 'email', 'warehouse']);
    expect(v.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'customer->bookshop',
      'staff->bookshop',
      'bookshop->payments',
      'bookshop->email',
      'bookshop->warehouse',
      'email->customer',
    ]);
  });

  it('container: the containers inside the boundary, and identical lifted relationships drawn once', () => {
    const v = view(bookshop(), 'containers');
    expect(v.boundary?.id).toBe('bookshop');
    expect(v.inside.map((e) => e.id)).toEqual(['web', 'admin', 'api', 'worker', 'db']);
    expect(v.outside.map((e) => e.id)).toEqual(['customer', 'staff', 'payments', 'email', 'warehouse']);
    // web calls three components of api with the same words: one arrow.
    expect(v.edges.filter((e) => e.from === 'web' && e.to === 'api')).toHaveLength(1);
    expect(v.edges.find((e) => e.from === 'api' && e.to === 'payments')).toMatchObject({ description: 'Charges cards with', technology: 'JSON/HTTPS' });
  });

  it('component: the components inside the container, and their neighbours at container or system level', () => {
    const v = view(bookshop(), 'components');
    expect(v.boundary?.id).toBe('api');
    expect(v.inside.map((e) => e.id)).toEqual(['catalogue', 'basket', 'orders', 'payment_adapter']);
    expect(v.outside.map((e) => e.id)).toEqual(['web', 'admin', 'db', 'payments']);
  });

  it('an include list shows exactly those elements, with "*" for the default set', () => {
    const model = bookshop();
    model.views.push({ key: 'narrow', type: 'container', scope: 'bookshop', include: ['web', 'api', 'customer'] });
    const v = view(model, 'narrow');
    expect(v.inside.map((e) => e.id)).toEqual(['web', 'api']);
    expect(v.outside.map((e) => e.id)).toEqual(['customer']);
    expect(v.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['customer->web', 'web->api']);
  });

  it('warns about a relationship that ends on the boundary, unless the same element already has an arrow into it', () => {
    const model = bookshop();
    model.relationships!.push({ source: 'customer', destination: 'bookshop', description: 'Uses' }, { source: 'staff', destination: 'api', description: 'Calls' });
    model.people!.push({ id: 'auditor', name: 'Auditor' });
    model.relationships!.push({ source: 'auditor', destination: 'bookshop', description: 'Audits' });
    const warnings: Warning[] = [];
    view(model, 'containers', (w) => warnings.push(w));
    expect(warnings).toEqual([{ code: 'C4_RELATIONSHIP_NOT_DRAWN', message: expect.stringContaining('relationships[19] (auditor -> bookshop)') }]);
  });
});

describe('checking a model', () => {
  it('names every problem by its path at once', () => {
    const model = bookshop();
    model.systems[0]!.containers!.push({ id: 'customer', name: 'Customer service' });
    model.relationships![0]!.destination = 'warehose';
    model.views[2]!.scope = 'bookshop';
    model.views[1]!.include = ['nope'];
    expect(() => loadModel(JSON.stringify(model), 'the model input')).toThrow(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('has 4 problems: systems[0].containers[5].id: "customer" is already the id of people[0]'),
        details: [
          { path: 'systems[0].containers[5].id', message: '"customer" is already the id of people[0]; ids are unique across the whole model' },
          { path: 'relationships[0].destination', message: 'no element has the id "warehose"' },
          { path: 'views[1].include[0]', message: 'no element has the id "nope" (use "*" for the default set)' },
          { path: 'views[2].scope', message: 'a component view is scoped to a container, and "bookshop" is a software system' },
        ],
      }),
    );
  });

  it('names schema problems in a file by path too', () => {
    const text = JSON.stringify({ systems: [{ id: '1bad', name: '' }], views: [], extra: true });
    expect(() => loadModel(text, 'model.json')).toThrow(
      expect.objectContaining({
        details: expect.arrayContaining([
          { path: 'systems[0].id', message: expect.stringContaining('must start with a letter') },
          { path: 'systems[0].name', message: 'a name is required' },
          { path: 'views', message: 'a model needs at least one view' },
          { path: '(the model)', message: expect.stringContaining('extra') },
        ]),
      }),
    );
  });

  it('refuses a file that is not JSON, saying which file', () => {
    expect(() => loadModel('{ nope', 'model.json')).toThrow(/model.json is not valid JSON/);
  });

  it('refuses a relationship from an element to itself', () => {
    expect(checkModel({ ...EXAMPLE_MODEL, relationships: [{ source: 'site', destination: 'site' }] })).toEqual([
      { path: 'relationships[0]', message: '"site" relates to itself; a relationship joins two different elements' },
    ]);
  });
});

describe('text output', () => {
  it('Mermaid uses the C4 macros for each kind, the boundary, and Rel with technology', () => {
    const text = toMermaid(view(bookshop(), 'containers'));
    expect(text.split('\n').slice(0, 2)).toEqual(['C4Container', 'title Containers: Online Bookshop']);
    expect(text).toContain('Person(customer, "Customer", "Browses and buys books online")');
    expect(text).toContain('System_Ext(payments, "Payment provider", "Takes card payments")');
    expect(text).toContain('System_Boundary(bookshop, "Online Bookshop") {\n  Container(web, "Web shop", "TypeScript, React",');
    expect(text).toContain('  ContainerDb(db, "Shop database", "PostgreSQL",');
    expect(text).toContain('Rel(email, customer, "Emails order confirmations to")\n');
    expect(toMermaid(view(bookshop(), 'context')).startsWith('C4Context\n')).toBe(true);
    expect(toMermaid(view(bookshop(), 'components'))).toContain('Container_Boundary(api, "Shop API") {\n  Component(catalogue,');
  });

  it('Mermaid has no escape for a double quote, so it becomes a single one', () => {
    const model: C4Model = { ...EXAMPLE_MODEL, people: [{ id: 'reader', name: 'The "reader"' }] };
    expect(toMermaid(computeView(model, model.views[0]!))).toContain("Person(reader, \"The 'reader'\", \"\")");
  });

  it('D2 nests the boundary, addresses inside elements by path, and quotes every key and quotes in text', () => {
    const text = toD2(view(bookshop(), 'containers'));
    expect(text).toContain('"customer" -> "bookshop"."web": "Browses and buys books using\\n[HTTPS]"');
    expect(text).toContain('  "db": "Shop database\\n[Container: PostgreSQL]\\n\\nBooks, customers, baskets and orders" {\n    shape: cylinder');
    const model: C4Model = { ...EXAMPLE_MODEL, people: [{ id: 'label', name: 'Say "hi"' }], relationships: [{ source: 'label', destination: 'status' }] };
    const d2 = toD2(computeView(model, model.views[0]!));
    expect(d2).toContain('"label": "Say \\"hi\\"\\n[Person]" {');
    expect(d2).toContain('"label" -> "status" { style');
  });

  it('D2 quotes ids that spell a keyword in any case, and the self-check still finds each one', () => {
    const model: C4Model = {
      people: [{ id: 'Label', name: 'L' }],
      systems: [{ id: 'Shape', name: 'S', containers: [{ id: 'desc', name: 'D' }] }],
      relationships: [{ source: 'Label', destination: 'desc', description: 'Uses' }],
      views: [{ key: 'v', type: 'container', scope: 'Shape' }],
    };
    const computed = computeView(model, model.views[0]!);
    const d2 = toD2(computed);
    expect(d2).toContain('"Label": "L\\n[Person]" {');
    expect(d2).toContain('"Shape": "S\\n[Software System]" {');
    expect(d2).toContain('  "desc": "D\\n[Container]" {');
    expect(d2).toContain('"Label" -> "Shape"."desc": "Uses"');
    const v = new Verifier(() => {});
    checkText(v, computed, d2, 'D2');
    expect(v.done().checks.filter((c) => c.status === 'passed').map((c) => c.check)).toEqual(['text.elements', 'text.relationships']);
  });
});

describe('SVG', () => {
  it('escapes text, and draws a database with its cap and the boundary dashed', () => {
    const model = bookshop();
    model.systems[0]!.containers![0]!.name = 'Web <shop> & co';
    const svg = toSvg(layoutView(view(model, 'containers')));
    expect(svg).toContain('>Web &lt;shop&gt; &amp; co</text>');
    expect(svg).toContain('<g id="db" class="c4-container"><path ');
    expect(svg).toMatch(/<g id="db" class="c4-container"><path [^>]*><ellipse /);
    expect(svg).toContain('stroke-dasharray="8 5"');
    expect(svg).not.toMatch(/<script|href=/);
  });

  it('turns characters XML forbids into U+FFFD, so a name holding \\u0001 still renders a file that parses', async () => {
    const model: C4Model = { ...EXAMPLE_MODEL, people: [{ id: 'reader', name: 'Read\u0001er \uFFFE\uD800', description: 'Tab\tstays' }] };
    const envelope = await execute(c4RenderCommand, { text: JSON.stringify(model) }, testContext().context);
    const data = envelope.data as { svg: string; verified: Verified };
    expect(data.svg).not.toMatch(new RegExp(XML_FORBIDDEN.source));
    expect(data.svg).toContain('>Read�er ��</text>');
    expect(data.verified.checks.find((c) => c.check === 'svg.wellFormed')).toMatchObject({ status: 'passed', checked: 1 });
    expect(() => parseXml(data.svg)).not.toThrow();
  });

  it('the well-formed check catches a forbidden character and a broken tag', () => {
    const svg = toSvg(layoutView(view(bookshop(), 'context')));
    expect(checkSvg(svg)).toEqual({ check: 'svg.wellFormed', checked: 1, failed: 0, failures: [] });
    const control = checkSvg(svg.replace('Online Bookshop</text>', () => 'Online\u0001Bookshop</text>'));
    expect(control.failed).toBe(1);
    expect(control.failures[0]!.message).toMatch(/^the SVG holds U\+0001 at offset \d+, a character XML forbids/);
    const broken = checkSvg(svg.replace('</title>', () => ''));
    expect(broken.failed).toBe(1);
    expect(broken.failures[0]!.message).toMatch(/^the SVG is not well-formed XML: /);
  });
});

describe('the text renders check themselves', () => {
  const run = (text: string, language: 'Mermaid' | 'D2') => {
    const warnings: Warning[] = [];
    const v = new Verifier((w) => warnings.push(w));
    checkText(v, view(bookshop(), 'containers'), text, language);
    return { verified: v.done(), codes: warnings.map((w) => w.code) };
  };

  it.each([['Mermaid', toMermaid] as const, ['D2', toD2] as const])('%s: every element declared once and one line per arrow, and rendering reported unchecked', (language, render) => {
    const { verified, codes } = run(render(view(bookshop(), 'containers')), language);
    expect(verified.passed).toBe(true);
    expect(verified.checks.map((c) => [c.check, c.status])).toEqual([
      ['text.elements', 'passed'],
      ['text.relationships', 'passed'],
      ['text.renders', 'unchecked'],
    ]);
    expect(codes).toEqual(['UNVERIFIED']);
  });

  it.each([
    ['Mermaid', toMermaid, 'ContainerDb(db,', 'Rel(web, api,'] as const,
    ['D2', toD2, '"db": "', '"bookshop"."web" -> "bookshop"."api"'] as const,
  ])('%s: catches a text that lost an element and an arrow', (language, render, element, arrow) => {
    const broken = render(view(bookshop(), 'containers'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith(element) && !line.startsWith(arrow))
      .join('\n');
    const { verified, codes } = run(broken, language);
    expect(verified.passed).toBe(false);
    expect(verified.checks.filter((c) => c.status === 'failed').map((c) => c.check)).toEqual(['text.elements', 'text.relationships']);
    expect(codes).toEqual(['UNVERIFIED', 'C4_TEXT_CHECK', 'C4_TEXT_CHECK']);
  });
});

describe('bounds', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `System ${i}` }));

  it.each([
    ['elements', { systems: many(1001), views: [{ key: 'v', type: 'systemContext', scope: 's0' }] }, 'has 1001 elements, and a model may have at most 1000'],
    [
      'relationships',
      { systems: many(2), relationships: Array.from({ length: 2001 }, () => ({ source: 's0', destination: 's1' })), views: [{ key: 'v', type: 'systemContext', scope: 's0' }] },
      'has 2001 relationships, and a model may have at most 2000',
    ],
    ['views', { systems: many(1), views: Array.from({ length: 101 }, (_, i) => ({ key: `v${i}`, type: 'systemContext', scope: 's0' })) }, 'has 101 views, and a model may have at most 100'],
  ])('refuses a model with too many %s before checking it', (_what, model, message) => {
    expect(() => loadModel(JSON.stringify(model), 'model.json')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining(message) }));
  });

  /** A view of systems in a chain plus long edges across it, the layout's worst shape: every long edge passes every row. */
  const chain = (boxes: number, arrows: number): C4Model => {
    const systems = many(boxes);
    const relationships = systems.slice(1).map((s, i) => ({ source: `s${i}`, destination: s.id }));
    for (let i = 0; relationships.length < arrows; i++) relationships.push({ source: `s${i % 30}`, destination: `s${boxes - 1 - Math.floor(i / 30)}` });
    return { systems, relationships, views: [{ key: 'v', type: 'systemContext', scope: 's0', include: systems.map((s) => s.id) }] };
  };

  it('render refuses a view past 100 boxes or 250 arrows, and the text renders still write it', async () => {
    const big = JSON.stringify(chain(101, 120));
    const refused = await execute(c4RenderCommand, { text: big }, testContext().context);
    expect(refused.error).toMatchObject({ code: 'INVALID_INPUT', message: 'View "v" has 101 boxes and 120 arrows, and render draws at most 100 boxes and 250 arrows.' });
    expect((await execute(c4RenderCommand, { text: JSON.stringify(chain(60, 251)) }, testContext().context)).error?.code).toBe('INVALID_INPUT');
    expect((await execute(c4MermaidCommand, { text: big }, testContext().context)).ok).toBe(true);
  });

  it('draws the worst view the limits allow in the bounded worker, and every check holds', async () => {
    const model = chain(100, 250);
    // About 0.9 s under a loaded full run, against the 2 s deadline: what this asserts is the drawing, so its deadline has generous room, well under this test's 30 s.
    const drawing = await draw(computeView(model, model.views[0]!), undefined, BOUNDED_TIMEOUT_MS + 8_000);
    expect(drawing.runs.filter((r) => r.failed)).toEqual([]);
    expect(drawing.svg.startsWith('<svg')).toBe(true);
  }, 30_000);

  it('stops a layout that passes its deadline with TIMEOUT, and a cancelled one with CANCELLED', async () => {
    const model = chain(100, 250);
    const computed = computeView(model, model.views[0]!);
    await expect(draw(computed, undefined, 1)).rejects.toMatchObject({ code: 'TIMEOUT', message: 'Laying out view "v" took longer than the 0.001 s it may run, so it was stopped.' });
    const controller = new AbortController();
    controller.abort();
    await expect(draw(computed, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('util c4 commands', () => {
  it('render returns the SVG, laid out by toil, with what it drew and what it checked', async () => {
    const envelope = await execute(c4RenderCommand, { inputFile: 'bookshop.c4.json', view: 'context' }, testContext({ files }).context);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as { svg: string; verified: Verified };
    expect(data).toMatchObject({ view: 'context', type: 'systemContext', title: 'System context: Online Bookshop', format: 'svg', relationships: 6 });
    expect(data.verified.passed).toBe(true);
    expect(data.verified.checks.map((c) => [c.check, c.status])).toEqual([
      ['input.complete', 'passed'],
      ['boxes.apart', 'passed'],
      ['edges.touchBoxes', 'passed'],
      ['edges.clearOfBoxes', 'passed'],
      ['labels.clearOfBoxes', 'passed'],
      ['svg.wellFormed', 'passed'],
      ['text.width', 'approximated'],
    ]);
    expect(envelope.meta.warnings).toEqual([{ code: 'APPROXIMATED', message: expect.stringContaining("text.width is approximate: text is measured with Helvetica's character widths") }]);
    expect(data.svg).toContain('<svg');
    expect(data.svg).toContain('Online Bookshop');
    expect(data.svg).toContain('[Software System]');
  });

  it('render checks the boundary too in a container view', async () => {
    const envelope = await execute(c4RenderCommand, { inputFile: 'bookshop.c4.json', view: 'containers' }, testContext({ files }).context);
    const checks = (envelope.data as { verified: Verified }).verified.checks;
    expect(checks.find((c) => c.check === 'children.inBoundary')).toMatchObject({ status: 'passed', checked: 10 });
  });

  it('render --out writes a new file in the workspace and returns its path and size instead of the SVG', async () => {
    const { context, files: written } = testContext({ files });
    const envelope = await execute(c4RenderCommand, { inputFile: 'bookshop.c4.json', view: 'containers', out: 'out/containers.svg' }, context);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as { file: string; bytes: number; svg?: string };
    expect(data.svg).toBeUndefined();
    expect(data.file).toMatch(/out\/containers\.svg$/);
    const saved = Object.values(written.written)[0]!;
    expect(data.bytes).toBe(saved.length);
    expect(Buffer.from(saved).toString('utf8')).toContain('<svg');
  });

  it('reads the model from stdin on the CLI', async () => {
    const run = await runCli(['util', 'c4', 'mermaid', '-', '--view', 'components'], { commands, context: testContext({ stdin: BOOKSHOP_C4 }).context });
    expect(run.envelope?.ok).toBe(true);
    expect((run.envelope?.data as { text: string }).text.startsWith('C4Component\n')).toBe(true);
  });

  it('takes the model as JSON on the CLI with --text', async () => {
    const run = await runCli(['util', 'c4', 'd2', '--text', JSON.stringify(EXAMPLE_MODEL)], { commands, context: testContext().context });
    expect(run.envelope?.data).toMatchObject({ view: 'context', format: 'd2', elements: ['reader', 'status'], relationships: 1, verified: { passed: true } });
  });

  it.each([
    [{ text: JSON.stringify(EXAMPLE_MODEL), inputFile: 'bookshop.c4.json' }, 'both'],
    [{ inputFile: 'bookshop.c4.json' }, 'The model has 3 views, and no --view said which to draw.'],
    [{ inputFile: 'bookshop.c4.json', view: 'deployment' }, 'The model has no view "deployment".'],
  ])('refuses %j with INVALID_INPUT', async (input, message) => {
    const envelope = await execute(c4MermaidCommand, input, testContext({ files }).context);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining(message) });
    if (message.startsWith('The model has')) expect(envelope.error?.fix).toBe('Pass --view <key>, one of: context, containers, components.');
  });

  it('refuses a bad model with the path that is wrong', async () => {
    const envelope = await execute(c4D2Command, { text: JSON.stringify({ ...EXAMPLE_MODEL, views: [{ key: 'v', type: 'deployment', scope: 'status' }] }) }, testContext().context);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.error?.message).toContain('views[0].type');
  });
});

describe('how each thing is known', () => {
  const marked = (): C4Model => {
    const model = bookshop();
    const web = model.systems[0]!.containers![0]!;
    web.how = 'observed';
    web.source = 'docker-compose.yml:4';
    const db = model.systems[0]!.containers!.find((c) => c.database)!;
    db.how = 'inferred';
    db.reason = 'the ORM config names one';
    model.relationships!.push({ source: web.id, destination: db.id, description: 'Guessed at', how: 'inferred', reason: 'same network' });
    model.relationships!.push({ source: web.id, destination: 'payments', description: 'Seen', how: 'observed', evidence: 'web/src/pay.ts:9' });
    return model;
  };

  it('accepts how, source and reason on every kind of element and on relationships, and refuses a value that is neither', () => {
    expect(checkModel(loadModel(JSON.stringify(marked()), 'm'))).toEqual([]);
    const bad = marked();
    (bad.systems[0] as { how?: string }).how = 'guessed';
    expect(() => loadModel(JSON.stringify(bad), 'm')).toThrow(/systems\[0\]\.how/);
  });

  it('carries them onto elements and onto the arrows drawn for a relationship, implied ones included', () => {
    const model = marked();
    const containers = view(model, 'containers');
    const db = containers.inside.find((e) => e.database)!;
    expect(db).toMatchObject({ how: 'inferred', reason: 'the ORM config names one' });
    expect(containers.inside.find((e) => e.how === 'observed')?.source).toBe('docker-compose.yml:4');
    expect(containers.edges.filter((e) => e.how === 'inferred').map((e) => e.reason)).toEqual(['same network']);
    expect(containers.edges.find((e) => e.how === 'observed')?.source).toBe('web/src/pay.ts:9');
    const implied = computeView(
      { ...model, relationships: [{ source: 'web', destination: 'payments', description: 'Calls', how: 'inferred' }] },
      model.views.find((v) => v.key === 'context')!,
    );
    expect(implied.edges.find((e) => e.to === 'payments')?.how).toBe('inferred');
  });

  it('does not fold an inferred relationship into an observed one that reads the same', () => {
    const model = bookshop();
    const rel = model.relationships![0]!;
    model.relationships!.push({ ...rel, how: 'inferred' });
    const v = view(model, 'context');
    expect(v.edges.filter((e) => e.from === rel.source || e.to === rel.destination).length).toBeGreaterThan(1);
    expect(v.edges.some((e) => e.how === 'inferred')).toBe(true);
  });

  it('draws an inferred box dashed and an inferred arrow dotted, and nothing else differently', () => {
    const plain = toSvg(layoutView(view(bookshop(), 'containers')));
    expect(plain).not.toContain('stroke-dasharray="5 3"');
    expect(plain).not.toContain('1.5 4');
    const svg = toSvg(layoutView(view(marked(), 'containers')));
    expect(svg).toMatch(/<g id="db"[^>]*><path [^>]*stroke-dasharray="5 3"/);
    expect(svg).toContain('stroke-dasharray="1.5 4"');
    expect(svg.match(/stroke-dasharray="6 4"/g)!.length).toBeGreaterThan(0);
  });

  it('prefixes an inferred description with (inferred) in Mermaid and D2, once', () => {
    const model = marked();
    const db = model.systems[0]!.containers!.find((c) => c.database)!;
    db.description = '(inferred) Already said';
    const computed = view(model, 'containers');
    for (const text of [toMermaid(computed), toD2(computed)]) {
      expect(text).toContain('(inferred) Already said');
      expect(text).not.toContain('(inferred) (inferred)');
      expect(text).toContain('(inferred) Guessed at');
    }
    expect(toMermaid(view(bookshop(), 'containers'))).not.toContain('(inferred)');
  });
});

describe('a model piped from another toil command', () => {
  it('is read from the data of the envelope, so projects diagram show --select model feeds render, mermaid and d2', async () => {
    const piped = JSON.stringify({ ok: true, data: EXAMPLE_MODEL, error: null, meta: { command: 'projects diagram show' } });
    const envelope = await execute(c4MermaidCommand, { text: piped }, testContext().context);
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect((envelope.data as { text: string }).text).toContain('C4Context');
  });

  it('says so when the piped command failed, instead of listing the model fields it lacks', async () => {
    const piped = JSON.stringify({ ok: false, data: null, error: { code: 'NOT_FOUND', message: 'x' }, meta: { command: 'projects diagram show' } });
    const envelope = await execute(c4D2Command, { text: piped }, testContext().context);
    expect(envelope.error?.message).toContain('a toil command that failed');
  });
});

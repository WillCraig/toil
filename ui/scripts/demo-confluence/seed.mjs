// Seeds the Overdraft Federal Engineering knowledge base (Confluence space OD, 23 pages)
// for the demo recordings (.claude/skills/sandboxes/demo-story.md) through toil's own commands, so the
// write gate decides: the confluence connection needs writes on. Each step looks
// first: an existing space is kept; a page this seed made (labelled toil-seed) is
// updated only when its source changed, which a seed-<hash> label records; a page
// anyone else made under the same title is left alone (CLAUDE.md, Test Projects).
// Running it twice changes nothing. The pages are pages/*.html, in the order and tree
// manifest.json gives; edit them there. Creating the space needs a toil with
// `confluence space create`; once the space exists, any toil will do.
//
//   node ui/scripts/demo-confluence/seed.mjs [--toil <path to toil.js>] [--connection confluence]
//
// There is deliberately no "Black Friday readiness" page: the agent writes it in
// video 5. Repo tooling only: nothing here ships. A wiki that is complete and up
// to date, which is how you can tell it is demo data.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const toilJs = arg('--toil', join(here, '..', '..', '..', 'dist', 'toil.js'));
const connection = arg('--connection', 'confluence');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const KEY = manifest.space.key;

function toil(...argv) {
  const r = spawnSync(process.execPath, [toilJs, '--workspace', here, 'confluence', ...argv, '--connection', connection], { encoding: 'utf8' });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`toil ${argv.join(' ')} printed no envelope: ${r.stderr || r.stdout}`);
  }
}
function must(env, what) {
  if (!env.ok) throw new Error(`${what}: ${env.error.code} ${env.error.message}${env.error.fix ? `\n  fix: ${env.error.fix}` : ''}`);
  return env.data;
}

let space = toil('space', 'get', KEY);
let createdSpace = false;
if (!space.ok && space.error.code === 'NOT_FOUND') {
  createdSpace = true;
  must(toil('space', 'create', KEY, '--name', manifest.space.name, '--description', manifest.space.description, '--allow-write'), 'space create');
  console.log(`created space ${KEY}`);
  space = toil('space', 'get', KEY);
}
const found = must(space, 'space get');
const homepageId = String(found.homepageId ?? found.homepage?.id ?? '');
if (!homepageId) throw new Error(`space ${KEY} has no homepage id in its answer`);

const ids = new Map([[null, homepageId]]);
const labelsOf = (id) => must(toil('page', 'labels', id), `labels of ${id}`).map((l) => l.name ?? l.label);
/** A label naming this page's source (title, body, labels), so an unchanged page is never written again. */
const markOf = (p, body) => `seed-${createHash('sha256').update(JSON.stringify([p.title, body, p.labels])).digest('hex').slice(0, 12)}`;
/** Writes the page's body only when its seed-<hash> label says the source changed, then swaps the label. */
function refresh(id, p, body, labels, extra = []) {
  const mark = markOf(p, body);
  if (labels.includes(mark)) return 'unchanged';
  must(toil('page', 'update', id, ...extra, '--body-file', p.file, '--allow-write'), `update ${p.title}`);
  must(toil('page', 'label', id, '--labels', ['toil-seed', ...p.labels, mark].join(','), '--allow-write'), `label ${p.title}`);
  for (const old of labels.filter((l) => l.startsWith('seed-') && l !== mark)) must(toil('page', 'unlabel', id, '--label', old, '--allow-write'), `unlabel ${p.title}`);
  return 'updated';
}

for (const p of manifest.pages) {
  const body = readFileSync(join(here, p.file), 'utf8');
  let id;
  let outcome;
  if (p.parent === null && p.title === manifest.space.name) {
    // The space homepage: Confluence made it, so it carries no seed mark at first.
    // It's ours to fill only in a space this seed created, or in OD, the demo's own.
    id = homepageId;
    outcome = createdSpace || KEY === 'OD' ? refresh(id, p, body, labelsOf(id), ['--title', p.title]) : 'left alone (not this seed\'s space)';
  } else {
    const parentId = ids.get(p.parent);
    if (!parentId) throw new Error(`"${p.title}" comes before its parent "${p.parent}" in manifest.json`);
    const existing = toil('page', 'find', '--space', KEY, '--title', p.title);
    if (existing.ok) {
      id = String(existing.data.id);
      const labels = labelsOf(id);
      outcome = labels.includes('toil-seed') ? refresh(id, p, body, labels) : 'left alone (no toil-seed label: someone else made it)';
    } else if (existing.error.code === 'NOT_FOUND') {
      id = String(must(toil('page', 'create', '--space', KEY, '--title', p.title, '--body-file', p.file, '--parent-id', parentId, '--allow-write'), `create ${p.title}`).id);
      // toil-seed marks what a seed made, as the other sandboxes' seeds do.
      must(toil('page', 'label', id, '--labels', ['toil-seed', ...p.labels, markOf(p, body)].join(','), '--allow-write'), `label ${p.title}`);
      outcome = 'created';
    } else {
      must(existing, `find ${p.title}`);
    }
  }
  ids.set(p.title, id);
  console.log(`${outcome.padEnd(9)} ${p.title}`);
}
console.log(`${manifest.pages.length} pages in space ${KEY}`);

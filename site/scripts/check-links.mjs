// After `astro build`: every internal link on every page this build made must
// land on a page it made, and a link with a hash on an element with that id
// there. A link to an old address (src/lib/redirects.mjs) fails too, though
// the address still forwards: the site's own pages link to where things are
// now. Each old address is checked to forward to a page that exists. Links
// to other sites aren't fetched; this checks only what the build controls.
// toil's own feedback form link (src/feedback/consent.ts, #435) is held to
// the build the same way: a page it made, never an old address.
// A dead link found here costs one build; found by a reader, it costs a reader.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REDIRECTS, MOVED_PREFIX, isRedirect } from '../src/lib/redirects.mjs';
import { FEEDBACK_FORM } from '../../src/feedback/consent.ts';

const BASE = '/toil';
const dist = join(import.meta.dirname, '..', 'dist');

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

/** The site path a built file is served at: dist/docs/core/index.html → /docs/core/. */
const pathOf = (file) => `/${relative(dist, file).replace(/\\/g, '/')}`.replace(/index\.html$/, '');

/** The built file for a site path, or undefined when the build made none. */
function fileFor(path) {
  const candidates = path.endsWith('/') ? [join(dist, path, 'index.html')] : [join(dist, path), join(dist, path, 'index.html')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return ids.get(file);
};

const problems = [];
const pages = htmlFiles(dist);
let links = 0;
for (const file of pages) {
  const from = pathOf(file);
  // The Toil UI app is its own bundle, framed by /ui/; its links are hash routes inside it.
  if (from.startsWith('/ui/app/')) continue;
  if (isRedirect(from)) continue;
  const html = readFileSync(file, 'utf8');
  for (const [, raw] of html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)) {
    // Astro writes an attribute's & as &#38; (or &amp;); either is an ampersand, not an anchor.
    const href = raw.replace(/&amp;|&#38;/g, '&');
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
    links++;
    const [pathPart, hash] = href.split('#');
    let target;
    if (pathPart === '') target = from;
    else if (pathPart.startsWith(`${BASE}/`) || pathPart === BASE) target = pathPart.slice(BASE.length).split('?')[0] || '/';
    else {
      problems.push(`${from}: "${href}" is a site path without the ${BASE} base (use url())`);
      continue;
    }
    if (isRedirect(target)) {
      problems.push(`${from}: links to the old address ${target}, which now lives at ${REDIRECTS[target] ?? target.replace(MOVED_PREFIX.from, MOVED_PREFIX.to)}`);
      continue;
    }
    const to = fileFor(target);
    if (!to) {
      problems.push(`${from}: "${href}" is no page this build made`);
      continue;
    }
    // A hash that starts with a slash is a route in the Toil UI app (`/ui/?theme=crate#/dossier/x`), not an id.
    if (hash && !hash.startsWith('/') && to.endsWith('.html') && !idsOf(to).has(decodeURIComponent(hash))) problems.push(`${from}: "${href}" has no element with id "${hash}" on ${target}`);
  }
}

// Each old address forwards to a page that exists.
const forwards = pages.filter((f) => isRedirect(pathOf(f)));
for (const file of forwards) {
  // The meta refresh names the same address the script does, and works without script.
  const to = /http-equiv="refresh" content="0; url=([^"]+)"/.exec(readFileSync(file, 'utf8'))?.[1];
  const target = to?.startsWith(`${BASE}/`) ? to.slice(BASE.length) : undefined;
  if (!target || !fileFor(target) || isRedirect(target)) problems.push(`${pathOf(file)}: forwards to ${to ?? 'nothing'}, which isn't a page`);
}
for (const old of Object.keys(REDIRECTS)) if (!fileFor(old)) problems.push(`${old}: listed in REDIRECTS, but the build made no page there`);

// The toil map (#432) reaches everything /connect/ lists: every page under
// /connect/ is a node on /map/, so an area with a page and no node fails here.
// A reference page that lives under /connect/ but isn't a service toil reaches has no node: the credential scopes page.
const NOT_A_SERVICE = new Set(['/connect/connections/']);
const mapFile = fileFor('/map/');
if (!mapFile) problems.push('/map/: the build made no map page');
else {
  const onMap = new Set([...readFileSync(mapFile, 'utf8').matchAll(/<a\b[^>]*?\shref="([^"#]*)/g)].map((m) => m[1]));
  for (const file of pages) {
    const path = pathOf(file);
    if (path.startsWith('/connect/') && path !== '/connect/' && !NOT_A_SERVICE.has(path) && !isRedirect(path) && !onMap.has(`${BASE}${path}`)) problems.push(`/map/: no node links to ${path}`);
  }
}

// The address toil and Toil UI print for the feedback form, from src/feedback/consent.ts.
const feedbackUrl = new URL(FEEDBACK_FORM);
const feedbackPath = feedbackUrl.pathname.slice(BASE.length);
if (feedbackUrl.origin !== 'https://imagile-dev.github.io' || !feedbackUrl.pathname.startsWith(`${BASE}/`)) problems.push(`src/feedback/consent.ts: FEEDBACK_FORM is ${FEEDBACK_FORM}, which isn't on this site`);
else if (isRedirect(feedbackPath)) problems.push(`src/feedback/consent.ts: FEEDBACK_FORM is the old address ${feedbackPath}, which now lives at ${REDIRECTS[feedbackPath] ?? feedbackPath.replace(MOVED_PREFIX.from, MOVED_PREFIX.to)}`);
else if (!fileFor(feedbackPath)) problems.push(`src/feedback/consent.ts: FEEDBACK_FORM is ${FEEDBACK_FORM}, which isn't a page this build made`);

// Every result the site search can offer (dist/search.json, scripts/search-index.mjs) lands too.
const index = join(dist, 'search.json');
const results = existsSync(index) ? JSON.parse(readFileSync(index, 'utf8')) : [];
if (!existsSync(index)) problems.push('/search.json: the build made no search index (scripts/search-index.mjs runs before this)');
for (const r of results) {
  const [path, hash] = r.u.split('#');
  const to = isRedirect(path) ? undefined : fileFor(path);
  if (!to) problems.push(`/search.json: "${r.t}" links to ${r.u}, which is no page this build made`);
  else if (hash && !idsOf(to).has(hash)) problems.push(`/search.json: "${r.t}" links to ${r.u}, and ${path} has no element with id "${hash}"`);
}

if (problems.length) {
  console.error(`Internal links that don't resolve:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`links: all ${links} internal links on ${pages.length - forwards.length} pages resolve, ${forwards.length} old addresses forward, and all ${results.length} search results land`);

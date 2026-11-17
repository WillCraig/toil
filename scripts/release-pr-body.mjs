#!/usr/bin/env node
// Makes a release PR's body safe for release-please to read back (#536).
// release-please finds each package's version in the merged release PR's body:
// it parses the notes between the `---` lines as HTML and looks for
// `<details><summary>VERSION</summary>` blocks. A breaking-change note that says
// `TOIL_CONN_<NAME>_*` or `--creator <id>` reads as an unclosed tag there, the
// second `<details>` is swallowed, and release-please skips both packages with
// a warning, no tag and no publish, in a run that still ends green.
//
//   node scripts/release-pr-body.mjs < body.md > escaped.md
//   node scripts/release-pr-body.mjs --packages < body.md
//
// With --packages it prints, one per line, each package the body lists a release
// for: `toil` for the summary with no component, else the component's name.
// release-please marks the PR released once any one package is, so the workflow
// holds the run's releases to this list to catch a package it skipped.
//
// It reads the body on stdin, writes it to stdout with every `<` that is not
// one of `<details>`, `</details>`, `<summary>` or `</summary>` written as
// `&amp;lt;`, and so is every `&lt;`: release-please writes a commit title's
// `<flag>` into the body as `&lt;flag&gt;` itself, which its first parse decodes
// back into a tag for the second (#619 skipped beta.6 that way). It says on
// stderr how many it escaped. Nothing else changes,
// line endings included, and running it twice changes nothing more.
//
// Why `&amp;lt;` and not `&lt;`: release-please parses the body, writes it back
// out from each block's decoded text, and each package's strategy parses it a
// second time. `&lt;` decodes to `<` after the first parse and is a tag again
// in the second; `&amp;lt;` decodes to `&lt;`, survives the second parse as
// text, and ends up as `<` in the notes. The GitHub release notes and CHANGELOG
// read `<NAME>`. The merged PR's own description shows `&lt;` literally on
// GitHub, which is cosmetic. It takes stdin and stdout rather than calling `gh`
// so this script never spawns anything. Escaping the angle brackets by hand in
// every future note would need a change request per bracket; a regex has no
// such backlog.
import { pathToFileURL } from 'node:url';

// A `<` that isn't a details or summary tag, or one already encoded as `&lt;`.
// `&amp;lt;` doesn't match, so a second run changes nothing.
const TAG_LIKE = /<(?!\/?(?:details|summary)>)|&lt;/g;

/** The body with every tag-like `<`, and every `&lt;`, written as `&amp;lt;`. */
export const escapeTagLike = (body) => body.replace(TAG_LIKE, '&amp;lt;');

/**
 * The packages a release PR's body lists a release for: `toil` for a summary
 * with no component (`0.1.0-beta.3`), the component for one with
 * (`toil-ui: 0.1.0-beta.3`).
 */
export const listedPackages = (body) =>
  [...body.matchAll(/<summary>([^<]*)<\/summary>/g)].map(([, summary]) => {
    const component = summary.trim().match(/^(.+?):? \d+\.\d+\.\d+/);
    return component ? component[1] : 'toil';
  });

/** How many `<` `escapeTagLike` would escape in the body. */
export const countTagLike = (body) => (body.match(TAG_LIKE) ?? []).length;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const body = await readStdin();
  if (process.argv[2] === '--packages') {
    for (const name of listedPackages(body)) console.log(name);
    process.exit(0);
  }
  const count = countTagLike(body);
  process.stdout.write(escapeTagLike(body));
  console.error(count ? `Escaped ${count} tag-like "<" in the release PR body.` : 'Nothing to escape in the release PR body.');
}

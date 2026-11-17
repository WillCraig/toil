# Demo reset: fixes from the first recording run (#651)

- **`--launch` runs this checkout's Toil UI on toil built from this checkout**
  (`.scratch/toil`, through `real-home.mjs`'s `buildToil` and the resolve hook), the
  pair `dev-real.mjs` runs, instead of `npm exec @imagile-dev/toil-ui` on the published
  toil. The demo home itself is built with that same toil under `--launch`, so the toil
  project Toil UI reads is the one that toil wrote. The published toil can lack a field the checkout's UI already sends (Jira's
  `moreFields`) and then nothing syncs; a matching pair can't drift. It needs
  `npm run build -w ui` first, which the reset doc lists. Where:
  `ui/scripts/demo-home.mjs`.
- **`npmCli()` also finds npm on PATH, through its symlink**, after npm_execpath and
  the copy beside node: Homebrew's node runs from its Cellar while npm lives under
  `/opt/homebrew/lib`. Only absolute PATH entries count, as git.ts does, so the working
  directory can't pick npm. Where: `ui/scripts/package-rules.mjs`.
- **ADO's sprints carry GitHub's and Jira's numbers.** #623 kept ado-seed's names
  (Sprint 1) so `apply.mjs` could find them, but Toil UI's sprint badge then read
  "Sprint 1" beside "Sprint 44" on camera. `demo-week-ado.mjs` now renames Sprint 1
  to 6 to `--sprint` and the five after it (highest first, so names never collide),
  only while ado-seed's Sprint 1 is still on the board, so a renamed board is never
  renumbered and a rename that stopped halfway carries on; it dates each by its
  number, and work items move with their sprint. `apply.mjs` follows the
  renumbering (with no Sprint 1 left, the file's Sprint n is the board's lowest
  sprint plus n - 1), so ADO can still be seeded in place: the principle review asked
  whether to accept seeding only from nothing, and the maintainer chose a scripted way
  back (2026-11-17). Where: `ui/scripts/demo-week-ado.mjs`,
  `ui/scripts/ado-seed/apply.mjs`.
- **The demo toil project names the ADO repository and Jira's points and sprint
  fields**: `repo=settlement-service` on the `ado` section, or Toil UI has no ADO
  repository to read code reviews from; `estimate=customfield_10016` and
  `iteration=customfield_10020` on Jira (the sandbox site's ids for Story point
  estimate and Sprint, Jira Cloud's usual ones; committed because they name a Jira
  field, not a site: the maintainer's call, 2026-11-17), or Toil UI reads no points for the critical chain. Jira numbers
  custom fields per site, so `demo-home.mjs` reads both back from SCRUM-14 and warns,
  with the command that finds the right ids, when either reads nothing.
  Where: `ui/scripts/demo-home.mjs`.
- **The replica has two dollar views**, `merchant_totals` and `upcoming_payouts`,
  rounded to cents as numeric(12,2): cents divided by 100 print sixteen decimals on
  screen. The reset doc lists ready queries. Where: `ui/scripts/demo-db.sql`.
- **Left out, filed apart:** Toil UI counting a story with no estimate as 0 points
  (principle 12, #652), the local data path that shows the account name on What
  happened (#653), and `--output-format toon` printing its table as an escaped string
  (#654); each is a product change with its own issue.

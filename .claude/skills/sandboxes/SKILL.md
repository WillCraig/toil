---
name: sandboxes
description: The live sandboxes (the Jira, Azure DevOps, GitHub and Confluence test projects) and the demo prep built on them. Use when a run writes to a real service (a `live` verification level, a suspected bug's live check, `npm run verify:ui`, LLM-based testing against real data), when seeding or resetting a sandbox, or when preparing demonstration or marketing material (the demo week, the demo home, the demo database, the story behind it). Not needed for deterministic tests, which never touch the network.
---

# Sandboxes and demo prep

Deterministic tests never need any of this: they run offline against fakes
(CLAUDE.md, **Testing**). This skill is for the runs that need a real service, and
for preparing demonstrations.

## Demo and local-development prep

*The maintainer's call, 2026-11-16 (#623).* Tooling that prepares a demonstration or
the maintainer's local development (the demo seeds in `ui/scripts/`, a demo home, the
demo database) is held to what keeps people and sandboxes safe, not to the product
rules written for a customer's machine:

- **Principle 2 still holds in full.** Every toil write goes through the connection's
  `writes` and `--allow-write`; a person types every secret and turns every `writes`
  on; a script never prints, stores or moves a token (handing `gh auth token` to a
  process the person starts, as `demo-home.mjs --launch` does, is the person's act).
- **Principle 8 still holds**, since every contributor runs it: Windows, macOS and
  Linux, never through a shell.
- **Principle 12 reaches it** for anything it writes: a read that fails stops the run
  and is never taken for "nothing there", which is how a seed posts a comment twice.
- **It needs nothing beyond npm and running a local web app.** A local service runs in
  Node (the demo database is PGlite, Postgres in WebAssembly); Docker may be offered
  as an option (`--docker`), never required.
- **It writes only to the test projects below**, and takes the exceptions listed
  there.

How to reset the demo before a recording is [demo-reset.md](demo-reset.md); the story
the demo data tells, and which video uses what, is [demo-story.md](demo-story.md).

## The test projects

*Principles 2 and 4.* Four sandboxes hold made-up work for runs against real
services: a `live` verification level, a suspected bug's live check, `npm run
verify:ui`, and the demo data in [demo-reset.md](demo-reset.md). They are the only places a live
run may write.

| Tracker | Test project | toil connection | Seeded by |
|---|---|---|---|
| Jira Cloud | project `SCRUM` | `jira` | `ui/scripts/jira-seed.mjs` and `demo-week.mjs`, through toil: labels `toil-seed` and `seed:<key>` |
| Azure DevOps Services | project `Toil Sandbox` | `ado` | `ui/scripts/ado-seed/` and `demo-week.mjs`: tag `toil-seed` and a `seed:<key>` tag |
| GitHub | repository `imagile-dev/toil-sandbox` | `github` | `ui/scripts/seed-sandbox.mjs` and `demo-week.mjs`, through `gh`. The repository is seeded as a whole: `seed-sandbox.mjs` made every item in it, so any item may be changed. What `demo-week.mjs` creates carries the label `toil-seed` |
| Confluence Cloud | space `OD` | `confluence` | `ui/scripts/demo-confluence/seed.mjs`, through toil: label `toil-seed` |

- **Reads may go to any of the four.** A write goes only to a test project, and only
  to items that carry its seed mark or that the run created itself. Demo prep may also
  change a test project's own structure (its sprints, iterations and milestones, and a
  repository or space for the demo), and give a fresh site's placeholder items (Jira's
  "Task 1") real titles while they still carry the placeholder title, marking them as
  it goes. The connection's
  `writes` and `--allow-write` still decide (**Writes**); an agent never turns `writes`
  on, so a sandbox whose connection has it off is read-only until a person changes it.
- **Name the project on every call** (`--project SCRUM`, `--project "Toil Sandbox"`,
  `--owner imagile-dev --repo toil-sandbox`). A default connection can reach other
  projects in the same site or organization, and nothing but the argument keeps a
  live run out of them.
- **Nothing a live run returns is committed.** Hosts, organization names, account
  names and ids stay out of code, tests, fixtures, docs, issues and PRs
  (**Placeholders**). A PR quotes a live envelope only after it is sanitized. The
  project and repository names in the table are the exception, since a contributor
  needs them to find the sandbox, and so are the issue, pull request and work item
  numbers inside a test project, which the demo docs cite.
- **Seed with the scripts, never by hand,** so a sandbox can be rebuilt and so its
  items stay recognisable. A feature that needs data the seeds lack (a fix version,
  a component, a category field) extends the seed in the same PR and says so. The one
  thing made by hand is a design in Figma, whose API can't write a file: the demo docs
  say so, and toil only reads it back.
- **A field or a project is an admin's to create.** toil never creates either. `SCRUM`
  has one category field, the dropdown `Work category` (KTLO, Feature) on its Story and
  Task work types; the other three test projects have none. Where a
  live check needs one that doesn't exist, the PR says what is missing under what
  wasn't verified, and the check waits.
- **The sample team is not a sandbox.** `toil sample team` and `toil-ui --sample` run
  with no connection and are what tests and screenshots use; a test project is for
  what only a real service can show.


# Demo reset

How to bring the demo data back to "a real team's week" before a recording. All of
it is made-up work: **Deliverables Unlimited**, a consultancy, on an engagement at
**Overdraft Federal**, a large US bank. Neither exists. The story, the cast and which
video uses what are in [demo-story.md](demo-story.md). The data lives in the four
test projects ([SKILL.md](SKILL.md): Jira, Azure DevOps, GitHub and the Confluence
space `OD`), a local Postgres (PGlite, or Docker if you choose), a SQLite file and one
Figma draft, and nothing else.

## Before each recording

Run from the repository root. Nothing is needed beyond Node and `npm install`. First
start the demo database in a terminal of its own and leave it running while you
record; it rebuilds the replica in memory with PGlite (Postgres in WebAssembly, a dev
dependency) and serves it on `127.0.0.1:55432` until Ctrl+C:

```bash
node ui/scripts/demo-db.mjs
```

Add `--docker` to run it in the `postgres:17` image instead, if you have Docker.
Then, in another terminal, each step below is safe to run twice: the seeds skip what's
already done (and put back an agent-ready item a recording closed), and the demo home
is rebuilt. To roll the week forward, change `--sprint` and `--ends`.

```bash
node ui/scripts/demo-week.mjs --sprint "Sprint 44" --ends 2026-11-27
```
```bash
node ui/scripts/demo-confluence/seed.mjs
```
```bash
npm run build -w ui
```
```bash
node ui/scripts/demo-home.mjs --fresh --launch
```

The last one rebuilds the demo home and starts Toil UI in it: this checkout's Toil UI
(`ui/dist`, which the build before it makes) on toil built from this checkout into
`.scratch/toil`, the pair `dev-real.mjs` runs. The two always match; the published
toil can lack a field the checkout's Toil UI already sends (Jira's `moreFields`, for
one) and then nothing syncs. It sets `HOME` and `USERPROFILE` to the demo home, so it
works the same on Windows, macOS and Linux, and reads the GitHub token from
`gh auth token` into Toil UI's process only. Run it yourself, since it hands a token
over; nothing is printed or written. Leave out `--launch` to rebuild only.

The rebuild also maps payments-team's people: Sam Rivera, the one person the story
names, takes the Jira, GitHub and Azure DevOps accounts the seeded items are assigned
to, read with toil at run time (GitHub through `gh auth token`, for that one read), so
the stand-up and Team show one person, not three unmapped accounts. No account id is
written in the repository. To map them in a home built before, without resetting its
config (writes included), run the step alone:

```bash
node ui/scripts/demo-home.mjs --people-only
```

For CLI and MCP shots, run toil with the demo home as its home. In bash or zsh:

```bash
HOME=~/toil-demo-home node dist/toil.js connections list
```

In PowerShell:

```powershell
$env:USERPROFILE = "$HOME\toil-demo-home"; node dist/toil.js connections list
```

Every connection in the demo home has writes off, whatever your own config says (your
own `confluence` connection has writes on for the seed), and toil runs there with no
`TOIL_*` variable from your shell, so none can turn writes back on. Video 5's agent is
stopped by the write gate until you turn writes on in the demo home, on camera
(`toil connections writes confluence on`, which asks you to type the name). In a
shell of your own, unset any `TOIL_*_WRITES` variable first.

On macOS, `demo-home.mjs` links `~/Library/Keychains` into the demo home, because
`security` finds the login keychain under `$HOME/Library`; without the link, every
`keychain:` reference reads as missing (#617 fixes this in toil). Windows and Linux
credential stores don't go by `HOME`.

## Queries for the recording

The replica keeps money in cents. Dividing by 100 gives a numeric with sixteen
decimals on screen (`471.1200000000000000`), so use the two dollar views, which round
to cents, or cast yourself with `round(x / 100.0, 2)::numeric(12, 2)`:

```bash
node dist/toil.js db query --connection payments-db "select merchant, captured_usd, refunded_usd from payments.merchant_totals order by captured_usd desc"
```
```bash
node dist/toil.js db query --connection payments-db "select merchant, scheduled_for, period_start, amount_usd, status from payments.upcoming_payouts where merchant = 'Lumen Games' order by scheduled_for"
```
```bash
node dist/toil.js db query --connection payments-db "select merchant, short_refunds, short_by_cents from payments.refund_shortfalls order by short_refunds desc"
```
```bash
node dist/toil.js db query --connection payments-db "select started_at, error from payments.job_runs where status = 'failed' order by started_at desc limit 3"
```

## First-time setup (once per machine)

1. Connections in your own config, settings only (an agent may add these):
   `jira`, `confluence` (Cloud, the Atlassian site), `ado` (Cloud,
   `https://dev.azure.com/<org>`), `figma` (`https://api.figma.com`) and
   `payments-db` (Postgres on `127.0.0.1:55432`, database `payments`, user
   `postgres`, no password). `demo-db.mjs` serves it with PGlite, or with Docker when
   you pass `--docker`.
2. Tokens, typed by a person in their own terminal:
   ```bash
   node dist/toil.js connections login jira
   ```
   ```bash
   node dist/toil.js connections login confluence
   ```
   ```bash
   node dist/toil.js connections login ado
   ```
   ```bash
   node dist/toil.js connections login figma
   ```
   Jira and Confluence take the same Atlassian API token. The ADO token is scoped to
   the one organization with Work Items (Read & write) and Code (Read, write &
   manage), which creating the repository needs. The Figma token is a personal access
   token with read access to files.
3. Writes on the three connections the seeds write to (each asks you to type the
   name):
   ```bash
   node dist/toil.js connections writes jira on
   ```
   ```bash
   node dist/toil.js connections writes ado on
   ```
   ```bash
   node dist/toil.js connections writes confluence on
   ```
4. The first seeds, if a sandbox is empty: `node ui/scripts/seed-sandbox.mjs`
   (GitHub), `node ui/scripts/jira-seed.mjs --project SCRUM`, and
   `node ui/scripts/ado-seed/apply.mjs --project "Toil Sandbox"` (with
   `TOIL_ADO_BASE_URL` and `TOIL_ADO_PAT` set in your own shell). `demo-week.mjs`
   renames the board's Sprint 1 to 6 to match GitHub and Jira (Sprint 44 and on), and
   `apply.mjs` follows the renumbering: with no Sprint 1 on the board, the file's
   Sprint 1 is the board's lowest-numbered sprint.
5. The Confluence space `OD` exists already. To create it from nothing, either create
   it in Confluence first, or pass the seed `--toil <path to toil.js>` from a build
   that has `confluence space create` (branch `kolatts/21-confluence-space-create`,
   not merged yet).

## What's seeded where

| Where | What |
|---|---|
| GitHub [`imagile-dev/toil-sandbox`](https://github.com/imagile-dev/toil-sandbox) | Milestone [Sprint 44](https://github.com/imagile-dev/toil-sandbox/milestone/4) (due 27 Nov), with 15 open issues carried over. Done today: PR #27 merged, which closed #9. In progress: #7 and #11, each with a comment from today. Code reviews: #37 waits on review, #29 waits on checks (it fails on purpose), #28 is a draft. Blocker chain: #11 → #12 → #17 → #18, with #18 relabelled `points: 3` (16 points, behind the Jira vault chain). Agent-ready: [#38](https://github.com/imagile-dev/toil-sandbox/issues/38), written to pass every ticket rule (story form, Given/When/Then, steps, expected and actual). The issues have no GitHub issue type, so toil reads them as neither story nor bug and no ticket rule applies to them. Code: `src/money.js`, `src/logger.js`, `src/refunds.js` and tests (`npm test`); `package.json` pins `express` 4.19.2 and `jsonwebtoken` 8.5.1, which have real advisories. What demo-week creates there carries the label `toil-seed` |
| Jira `SCRUM` (`https://<your-site>.atlassian.net`) | Active sprint renamed **Sprint 44**, 16 to 27 Nov, goal "Stored cards end to end: vault, tokenised charges and saved-card checkout". The placeholders SCRUM-1 to 3 renamed to real payments tasks. Done today: SCRUM-31. In progress: SCRUM-20 (picked up today), SCRUM-14 and SCRUM-16, each with a comment from today. Critical chain: the earlier seeding has SCRUM-14 blocking SCRUM-17 and SCRUM-24, and SCRUM-17 blocking SCRUM-18, SCRUM-21 and SCRUM-30; demo-week adds SCRUM-14 blocks SCRUM-15, SCRUM-18 blocks SCRUM-21 and SCRUM-21 blocks SCRUM-30, so the critical chain is SCRUM-14 → 17 → 18 → 21 → 30 (18 points). Due dates, by working day of the sprint (the keys follow `--project`, as the blocks links do; a due date lasts its whole day, so an item due today isn't overdue): SCRUM-15 17 Nov (still blocked, so past due), SCRUM-14 and SCRUM-43 19 Nov, SCRUM-24 20 Nov, SCRUM-17 and SCRUM-23 23 Nov, SCRUM-18 24 Nov, SCRUM-21 and SCRUM-33 25 Nov, SCRUM-25 26 Nov, SCRUM-30 27 Nov. Agent-ready: **SCRUM-55**, `maskPan()` in `src/mask.js` of the GitHub sandbox. Ticket rules: every seeded story's description has a user story and Given/When/Then under "Acceptance criteria", except SCRUM-15, SCRUM-17 and SCRUM-32 (plain bullets, no scenarios) and SCRUM-2 and SCRUM-23 (no user-story form). The bugs are Tasks, so the bug rules don't apply |
| Azure DevOps `Toil Sandbox` (`https://dev.azure.com/<org>`) | The 45 ado-seed items. Its sprints carry the same numbers as GitHub's and Jira's: Sprint 44 is current, 16 to 27 Nov, and Sprints 45 to 49 follow in two-week steps (`demo-week.mjs` renamed ado-seed's Sprint 1 to 6, once). Done today: #157. In progress: #172 (picked up today). Comments from today on #152 and #176. Repository `settlement-service` with the demo code; PR 1, "cut settlement batches at the merchant's midnight", waits on review and is linked to bug #176. Of the seed's dependency links only #152 → #169 is kept: demo-week takes off the seven that copy a Jira chain, so the blocker timeline draws each chain once, and tries a Target Date on #152 (20 Nov) and #169 (24 Nov), saying so if Scrum's form refuses it. Agent-ready: **#194**, refund reason validation in `src/refunds.js`. Ticket rules: every seeded Product Backlog Item has a user story in its description and Given/When/Then in Acceptance Criteria; every Bug has Steps to reproduce, Expected and Actual in Repro Steps, except **#193**, whose Repro Steps is one unreproduced line |
| Postgres `payments-db` (`demo-db.mjs`: PGlite, or Docker `toil-demo-pg`) | Schema `payments`, dated relative to the day it's loaded: 4,000+ payments (some duplicate captures on one idempotency key), refunds (about one in twenty $0.01 short, because fees are worked out per transaction and rounded down; see view `refund_shortfalls`), six US merchants, all in USD, disputes waiting on a response, payouts (Lumen Games' split payout after its schedule change, the second due the coming Friday), and `job_runs` (nightly reconciliation failing on a lock the statement export holds, including last night) |
| Confluence space `OD`, "Overdraft Federal Engineering" | 23 pages, each labelled `toil-seed` and `kb`: teams and ownership, working with Deliverables Unlimited (consultant access, and what consultants may change, with writes off by default), how money moves, runbooks (the reconciliation lock, #22; double charges, #11, PR #37 and SCRUM-20; Lumen Games' schedule change, #15), ADR-007, 009 and 011, standards (money, #38; logging, SCRUM-55; refund reasons, ADO #194), releases (the checklist template, the Black Friday freeze), two incident reviews (one tied to ADO #176) and a glossary. There's no "Black Friday readiness" page on purpose: the agent writes it in video 5. The source is `ui/scripts/demo-confluence/pages/*.html` and `manifest.json`. The older space `KW` from the first draft stays until it's deleted in Confluence's own UI (toil has no space delete) |
| Figma draft "Overdraft Federal: Payout preview" | One frame, "Payout preview / Lumen Games" (50 editable text layers, built from the replica's numbers), and two comments from Ana: the split payout question (GitHub #15) and the reserve link (#18). GitHub #17 links to it. It was made once in the browser and isn't reseeded, since Figma's API can't write a file; `toil figma file get <key> --document` and `toil figma file comments <key>` read it |
| SQLite `~/toil-demo-home/ledger.db` | 6 merchants, 60 settlements, 12 chargebacks |
| Toil project `payments-team` (demo home) | Ties GitHub, Jira, ADO (with the `settlement-service` repository, so its code reviews show), `payments-db`, Confluence (space `OD`) and Figma together. Its Jira section names the story points and sprint fields (`estimate` and `iteration`), so Toil UI reads both. Ticket rules `gherkin`, `user-story` and `bug-repro` (`toil projects standards set`); a toil without that command gets a warning and a toil project without them |

The agent-ready items are GitHub #38, SCRUM-55 and ADO #194. Each is 20 to 30 minutes
of work, names its files, and lists acceptance criteria that `npm test` checks.
`ui/test/demo-week.test.ts` checks offline that the demo code passes its own tests and
starts in the state each item describes, and runs toil's ticket-rule checks over the
seeded text: the agent-ready items pass, and only the named items miss. Which beat each item serves, and the other
stories, are in [demo-story.md](demo-story.md), **Video map**.

## Names on screen

The seeds can only assign the token's own identity. Before recording, set the
Atlassian, Azure DevOps and GitHub profile display names to a demo name (for example
"Sam Rivera (demo)"), and keep the Jira site address out of shot.

## Stop and clean up

```bash
node ui/scripts/demo-db.mjs --stop   # only if you used --docker
```

`node ui/scripts/ado-seed/cleanup.mjs --project "Toil Sandbox"` lists the seeded ADO
work items, including the agent-ready one; run it again with the `--confirm <code>` it
prints to send exactly that list to the recycle bin. The GitHub and Jira seeds have no
cleanup: they're sandboxes, and the seeds pick up from whatever state they find.

## Stopgaps

On Azure DevOps Services, `demo-week-ado.mjs` uses `toil ado api` for things toil has
no command for yet: creating a repository, setting sprint dates, pushing files, and
linking a work item to a PR. Assigning goes through `work-item update`. #621 adds
these as `ado` commands; switch the script over once it lands.

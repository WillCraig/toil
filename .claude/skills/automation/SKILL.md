---
name: automation
description: Rules for the repository's agent automation under .github/ (the PR review agent, the fix agent that pushes to PR branches, Discord notifications, issue triage and redaction). Use when editing or reviewing any GitHub Actions workflow, especially one that runs an agent or holds a token: its labels (`no-auto-fix`, `needs-human`), reviewer and bot allowlists, token permissions, action SHA pins, the Imagile Bot App token, Discord webhook posts, or the `REDACT_TERMS` redaction of externally filed issues.
---

# Automation

An agent reviews every PR and submits a formal review. `CHANGES_REQUESTED` dispatches
a fix agent that pushes to the PR branch. No agent merges, or approves its own work
into `main`. A human merges triage's PRs, any PR for an issue filed from outside
(`from-website` or `from-terminal`), and the release PR. On a PR the maintainer
drives through Claude Code, the `ship` skill turns on auto-merge (squash), at the
maintainer's standing instruction (2026-10-19, principle 2). The PR then lands when
the Imagile Bot approves the head commit and `CI ok` passes. Nothing in a workflow
ever turns auto-merge on, and the fix agent never does either. Auto-merge relies on `main`'s ruleset counting only an approval of the head commit: `dismiss_stale_reviews_on_push` and `require_last_push_approval` both on (`docs/repo-settings-proposal.md`, item 4). Check with `gh api repos/imagile-dev/toil/rulesets/<id>` before turning it on; while either is off, leave auto-merge off and say why, because GitHub would merge a later push on an earlier approval.

- **The review** is `.github/workflows/claude-review.yml`. It runs on same-repo,
  non-draft PRs from humans and `claude[bot]`, authenticated by the
  `CLAUDE_CODE_OAUTH_TOKEN` secret.
  - It acts as the **Imagile Bot GitHub App** (`imagile-bot[bot]`), with a token
    minted per run from the `IMAGILE_BOT_APP_ID` variable and the
    `IMAGILE_BOT_PRIVATE_KEY` secret. The token gets read-only contents plus
    pull-request and issue writes. The workflow's own `GITHUB_TOKEN` stays
    read-only. Formal APPROVE needs no extra repo setting, because that setting
    only gates `GITHUB_TOKEN`. The App can't approve its own PRs, so those are
    skipped.
  - **Only release-please's token asks for `workflows`.** The App's installation
    holds Workflows: write since 2026-11-17 (the maintainer's call), because
    tagging a release PR's merge commit after `main` has changed a workflow needs
    it (#619). That token goes to the release-please step alone; the job's
    checkout, build and push mint a second one without it. Every bot token names
    its permissions, since one with none inherits the installation's, and
    `test/release-workflow.test.ts` fails on either.
  - It reviews against CLAUDE.md and the skills and can run the gate (`npm test`, `typecheck`,
    `lint`, `build`, `check:pure`), so findings are backed by inputs it ran.
  - **A merge of `main` alone is re-approved without the agent.** On `synchronize`,
    a step before the agent runs `scripts/review/merge-only.mjs`, taken from the base
    branch's copy so a PR can't change its own check. It approves the new head, with
    the App token, only when the bot's last formal review approved a commit A and that
    approval stands or GitHub dismissed it as stale on the push; no review thread is
    open; every first-parent commit from the head back to A is a merge whose other
    parent is on the base branch; and the PR's own diff (`git diff
    <merge-base(main, X)> X`) is the same for A and the head, ignoring only hunk line
    numbers and whole-file blob ids. GitHub sometimes keeps an approval on the head
    after such a merge and reports it at the head's sha; then A is taken as the
    newest commit that isn't a merge of the base, and nothing is posted, since the
    approval already counts. Anything else, an error included, runs the full
    review. The job summary lists each check, and the approval links its run.
    `test/merge-only.test.ts` holds the cases. The ruleset still dismisses approvals
    on every push; this only gives a merge its approval back.
  - A last step fails the job if no formal review by the bot landed on the head
    commit, so a silent agent can't read as green.
  - Subagents are disallowed, because in headless mode they get killed when the turn
    ends. Bash allow-rules with a mid-pattern `*` use the trailing-space form.
- **Every action is pinned to a full commit SHA**, with its version as a trailing
  comment (`uses: actions/checkout@<sha> # v4.4.0`), in every workflow. Tags can be
  moved after review; SHAs can't, and these jobs hold tokens. A new or bumped pin must
  be a release at least 14 days old, so a compromised release has time to be caught
  before it runs here with those tokens.
- **The fix agent** (`claude-pr-feedback.yml`) isn't wired yet. App-authored reviews
  raise `pull_request_review` events, so when it lands it triggers on a
  `CHANGES_REQUESTED` review from `imagile-bot[bot]` directly. That bot must be named
  in its reviewer allowlist and in `allowed_bots`, never `*`.

- `no-auto-fix` label: the fix agent leaves the PR alone. So does the `ship` skill's
  local watch.
- `needs-human` label: set after 3 pushed rounds; the loop stops. Rounds are counted
  from `<!-- toil-feedback-round -->` marker comments on the PR, which `ship` posts
  too. When the fix agent is wired, it counts and posts the same marker, so a PR has
  one limit across both loops. `ship` also sets `needs-human` when a PR stalls for an
  hour.
- Only `OWNER`/`MEMBER`/`COLLABORATOR` reviews and explicitly named bots trigger it.
  Never use `allowed_bots: "*"`.
- The fix agent never edits: `on:` triggers, actor allowlists, `permissions:`, token
  minting inputs, secrets, `uses:` pins, agent prompts and tool allowlists, or new
  `run:` steps in agent workflows. Agents do not edit the rules that constrain them.
- Externally filed issues are redacted (secrets, internal hosts, private IPs, org names
  from the `REDACT_TERMS` secret) before the issue is even created: the feedback
  function runs `scripts/triage/redact.mjs` on the title and body before
  `createIssue`, and triage runs it again before any agent reads them. The denylist
  lives only in that secret and its one copy, the `FEEDBACK-REDACT-TERMS` Key Vault
  secret the function reads (the secret can't be read back, so the maintainer sets
  both from one file; `infra/bootstrap.sh` prints how). The token shapes come from
  `src/core/token-shapes.mjs`, the same list toil's own `src/core/secret-shapes.ts`
  reads, so the two redactors can't drift.

## Triage of issues filed from outside

Principle 2's one exception: issues filed from outside may be triaged by an agent,
but only after redaction, within the daily cap, under the safeguards below, and only
through PRs that a human merges. `.github/workflows/triage.yml` is that agent. It
starts on the `from-website` or `from-terminal` label (set by the feedback backend,
`functions/feedback/`, as the Imagile Bot), on `claude-triage` added by a
maintainer, on `workflow_dispatch` with an issue number, on a comment from the
maintainer (below), and on a daily schedule for the queue. Only `imagile-bot` is accepted as a bot actor, in the job's `if` and
in `allowed_bots`, and its `claude-triage` counts only on an issue it filed from
outside, so nothing can pull in an issue nobody chose.

**The maintainer steers by commenting** (the maintainer's call, 2026-11-19, #671). A
comment from `kolatts`, and from nobody else (the job's `if` and `MAINTAINER` in
`scripts/triage/steps.mjs` name the login, and `test/workflow-wiring.test.ts` holds
them equal), on an open issue triage takes or on a `from-triage` PR, re-runs triage
for that issue outside the cap, like a dispatch. A comment carrying an agent's mark
(`ship`'s round marker or reply footer, a Claude Code PR footer) is an agent posting
under that login, and starts nothing. A comment on a PR maps back to its issue only
when its head is `claude/issue-<n>` in this repository. The re-run force-pushes that
branch from `main`, so once its PR is marked ready or labelled `no-auto-fix` or
`needs-human`, a comment on the PR or on the issue starts nothing. The maintainer's
comments that pass the job's label test share one concurrency group, since a PR
comment can't name its issue in the expression; every other comment gets a group of
its own, so it can't displace a re-run that is waiting. `prepare` splits the conversation on the issue
and its open PR: the maintainer's own comments, redacted, are the `direction` output,
which the prompt puts outside the untrusted fence, where they settle a design choice
and answer triage's question but never override a principle or widen what triage may
touch; the project bot's comments (triage's earlier runs, the PR review) are agent
output that read untrusted text, so they go inside the fence as context. A line in any
body that could pass for an author header is indented. Nobody else's comment starts a
run or reaches the agent. A re-triage that reaches any decision but `maintainer`
takes `needs-maintainer` off, and `open-pr` force-pushes the branch and updates the
same PR.

**Being unsure is a reason to fix, not to wait** (same call). An unconfirmed API
detail or an open design choice is a `fix`: the agent builds on the best API knowledge
it can confirm, picks the option that relies on nothing unconfirmed, opens the draft,
says in it what's assumed and what live check would settle it, and asks the one
question that would change direction. The maintainer answers on the issue or the PR.
It never changes behavior the command contract records (a suspected bug there stays
`maintainer`, with the write-up in the comment), labels a canned response written from
the docs as such, and leaves the area's verification level alone.

**The boundary is the job, not the prompt.** Code the agent writes must never run
in this workflow at all, and the credential that writes must never sit where the
agent works. So the work is split across jobs, each on its own fresh runner:

| Job | Runs | Holds |
|---|---|---|
| `select` | main's scripts only: claim within the cap, redact each issue in place | an `issues: write` App token |
| `triage` | one per issue: the agent, with `Read`, `Glob`, `Grep`, `Edit` and `Write` only (no Bash, no `gh`, no `npm`, no web). Afterwards, shell utilities only (no `git`, no `node`), to hand its files over as a ustar archive | `contents: read` / `issues: read` workflow token; the OAuth token only inside its own step, with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set as well. The scrub isolates subprocesses with bubblewrap and won't start without it, so the job (pinned to `ubuntu-24.04`) installs it, lifts that image's AppArmor block on unprivileged user namespaces for the throwaway runner, and runs `bwrap` once to prove it works before the agent |
| `finish` | one per issue: main's scripts only. Checks the decision and every path, applies labels and comment, closes a denial or a duplicate (a `maintainer` decision stays open), and for a fix pushes `claude/issue-<n>` and opens a **draft** PR. Never runs the fix's code | an App token with contents, pull-request and issue writes and no `workflows` |

The fix's code first runs in `ci.yml` on that draft PR, under `pull_request`: the
full gate on all three OSes, in the PR's own cache scope, with no secrets. A human
marks it ready and merges it. There is no in-workflow test job, so nothing agent-written
ever runs in `main`'s cache scope.

The agent never writes to GitHub itself: it leaves `decision.json`, a comment and the
PR text in `.triage-out/`, and `finish` applies them (`scripts/triage/decision.mjs`
refuses an unknown area or decision and defuses every closing reference GitHub honours
in the PR text).

- **Nothing secret-shaped is posted.** The agent can read files, so an injection could
  have it quote one. Its `Read`, `Edit` and `Write` are allowed under the checkout only
  (`Read(./**)`), and denied outright on `/proc`, `/sys`, `/etc`, the runner's temp
  folder (`GITHUB_ENV`, `GITHUB_OUTPUT`), downloaded actions and dot-folders in the
  runner's home. Its step holds one secret, the OAuth token. The handover compares
  the agent's output byte for byte with that job's OAuth and workflow tokens (masked,
  passed to grep without argv) and empties it on a match. Then `decision.mjs` checks
  the comment, the PR title and body, and every line the fix adds (against main) for
  token shapes alone (`tokenShaped`: prefixed formats, JWTs, private keys), never the
  key-name rules, which would flag ordinary code like `token: z.string()`; those stay
  for redacting incoming issue text. A hit is `leak`: nothing is posted, the issue
  gets `needs-human`, and the run fails.
- **A failed agent run is not a decision** (`agent-ok` or `decision.json` missing):
  nothing is said on the issue and the run fails. The first time, the issue gets
  `triage-failed` and goes back in the queue; the second time it gets `needs-human`
  and stays out, so no issue can spend a slot every day. A failed manual re-triage is
  never queued. `needs-human` keeps an issue out of the cap's claims and the queue
  until a maintainer re-triages it by hand. A `needs-maintainer` issue also carries
  `triaged`, so it stays out of the cap and the queue until a maintainer re-triages it by hand. Changing this
layout means re-checking that no job holding a write credential runs agent-written
code, and that nothing in this workflow runs it at all.

**The YAML only wires.** Every step that does more than pass inputs to outputs is a
function in `scripts/triage/steps.mjs` (`node scripts/triage/steps.mjs <step>`), with
inputs as env vars, never `${{ }}` inside a script, and outputs written to
`$GITHUB_OUTPUT`. A value one step hands the next goes through
`steps.<id>.outputs.<name>`; a step never reads `$GITHUB_OUTPUT` back, because each
step gets its own empty file. `test/triage-steps.test.ts` runs the steps in order
through real `GITHUB_OUTPUT` files against a stateful fake GitHub (claim, redact,
prepare, decide, apply, open-pr, requeue; the empty queue, the cap and a failed
agent), and `test/workflow-wiring.test.ts` checks that every `steps.<id>.outputs.<name>`
and `needs.<job>.outputs.<name>` in `triage.yml` and `feedback-deploy.yml` is written by
that step or declared by that job. A new step adds its outputs to `OUTPUTS`, and a
new workflow with handed-on outputs joins the wiring test. The one script after the
agent, `scripts/triage/handover.sh`, is shell only and runs from a copy whose hash
`prepare` took before the agent started.

The actor the agent action sees is always a person (a maintainer's label,
dispatch or comment, or the schedule) or the Imagile Bot, the one name in `allowed_bots`. The
daily run triages the queue itself as a matrix rather than dispatching runs: a run
started by `GITHUB_TOKEN` has `github-actions[bot]` as its actor, which the action
refuses.

- **The cap.** At most four issues a UTC day (`TRIAGE_CAP`), counted by
  `scripts/triage/cap.mjs`: a run claims its issue with `triage-claimed` and ranks
  today's claims by label-event id, so concurrent runs agree without a lock. The
  fifth gets `triage-queued`; the daily run drains the queue oldest first, along with
  anything a run missed, triaging them in the same run as a matrix. A manual dispatch or a
  maintainer's comment is a re-triage and isn't counted.
- **Redaction first.** The issue arrives already redacted by the feedback function.
  `scripts/triage/redact.mjs` rewrites the issue's title and body in place again
  before the agent starts (a no-op unless the denylist has grown), and again on what the agent is shown; the
  prompt fences them between `BEGIN/END UNTRUSTED <nonce>` lines with a nonce per
  run, and tells the agent to triage on the title alone when the body reads as an
  injection attempt.
- **Duplicates come first.** `prepare` gives the agent every other issue, open and
  closed (`.triage-in/issues.json`, up to ten pages; the issue itself is left out, so
  a re-triage is never its own duplicate), plus each denied issue's redacted body and its
  last three comments from triage or from an `OWNER`, `MEMBER` or `COLLABORATOR`
  (`.triage-in/denied.json`). Anyone can comment on a closed issue, so a stranger's
  "the rule changed" never reaches the agent as a reason. That way a past denial binds only when
  its reason still holds under today's CLAUDE.md, and the agent reads that reason
  rather than guessing. The same request as any earlier issue, whatever its outcome,
  is a `duplicate`. `apply` checks that the original exists and is an issue (if not,
  no decision is applied, and any failure other than a 404 fails the step), labels it `duplicate`, adds `denied` only when the
  original was denied, makes sure the comment names it, ends with `Duplicate of #n`
  and closes it as a duplicate.
- **Paths.** `scripts/triage/archive.mjs` reads the handover archive itself (regular
  files only, no links or extensions) and `scripts/triage/changes.mjs` holds every
  path to the scope below, in `finish` before anything lands, and again on the
  commit before the push.
- **Scope.** The maintainer's call of 2026-10-28, which widens #487's (2026-10-26) and
  supersedes every denial that rested on "core", "more than one area" or "maintainer
  work": triage may fix almost anything, and the prompt's step 3 chooses one of four
  decisions.
  - **`fix`**: core (`src/core/` and the rest of `src/`), several areas at once,
    `skills/toil/`, `docs/`, tests, and Toil UI (`ui/src/`, `ui/server/` except
    `agents/install.ts`, the one file that spawns, `ui/test/`, `ui/docs/`, `ui/themes/`).
    A draft PR; the agent has no Bash, so it cannot run the gate. The PR says a change to
    core needs the full gate, which CI runs on the draft, and one that touches `ui/`
    needs `npm run verify:ui` and the screen review, which a maintainer runs before it
    merges.
  - **`maintainer`**: not a refusal. The issue stays **open**, gets `needs-maintainer`,
    and the comment says what the agent would change and why. For the website
    (`site/`, except the per-area data files the tests generate or check,
    `site/src/data/integrations|commands|settings/<area>.json`) and the Azure Function
    backend (`functions/`, and `infra/`, which provisions it): a person reviews those
    first, and triage edits none of it. Also for a bug the agent cannot confirm and has no
    plausible fix for (the comment says what it needs), and for what it cannot do without running anything:
    `package.json`, a lockfile, a new dependency (no npm, so no resolve and no 14-day check).
  - **`deny`** (closed, `denied`): only what directly violates CLAUDE.md's principles
    (telemetry, a native binary, loosening the write gate or the secrets rules), with the
    principle quoted. Size and "it touches core" are no longer reasons.
  - **`duplicate`**: as above.
  - **Always refused**, by `changes.mjs` and by the prompt, because they are the rules
    that constrain triage (principle 2): `.github/`, `scripts/`, `CLAUDE.md`, `.claude/`,
    `AGENT_DECISIONS.md`, `docs/decisions/` (the draft's description carries the agent's
    reasoning, so it writes no decisions file), `dist/`, any file at the repository root but
    `README.md`, every `package.json` and lockfile, Toil UI's build and lint configuration
    and `ui/scripts/`. The areas a fix touched are reported for the `area:` labels; there
    is no limit on how many.
- **Safety-layer edits are flagged, not forbidden.** `isSafetyLayer` in
  `scripts/triage/changes.mjs` is the authoritative list; read it, not a copy here. In
  short: every bound's enforcer in toil (the `src/core/` files for the write gate, call
  and area resolution, secrets, files, git, the network, limits, audit and config, with
  their tests; whole folders such as `src/os/`, `src/mcp/`, `src/connections/` and
  `src/skills/`; `docs/bounds.md`), the shipped skill (all of `skills/toil/`, which users'
  agents read as instructions), the command contract and the suites that guard it
  and triage's own rules, and Toil UI's (every file under `ui/server/`, `ui/src/config.ts`,
  each theme's `theme.json`, and the suites that check Toil UI's own rules). Paths are
  compared without regard to case. When a fix edits one, `open-pr` puts a "Safety-layer edits"
  section listing the files at the top of the draft, computed from the checked paths so
  the agent can't leave it out, and the agent's own section ("What the safety-layer edits
  change") says what each edit loosened or widened. `claude-review.yml` asks its reviewer
  to open with the same paragraph (it skips triage PRs today, because the App can't
  approve its own PR, so the draft's description is what the maintainer reads).
- **Model and turns are fixed:** `--model sonnet --max-turns 100`. Transient GitHub
  failures (5xx, 429, network) are retried. The outcome goes to the job summary.
  No triage job uses `cache: npm`.
- The PRs triage opens are authored by `imagile-bot[bot]`, so `claude-review.yml`
  skips them (the App can't approve its own PR); a maintainer reviews them.

## The feedback backend's deploy

`.github/workflows/feedback-deploy.yml` builds and tests `functions/feedback/` on
PRs with no Azure access. On `main` it logs in to Azure over OIDC (repository
variables, no stored secret), refuses to deploy when Azure's forecast for the month
is over the subscription's $60 budget (`MONTHLY_CAP_USD`; the identity, its roles,
the Key Vault identity and the secrets it uses come from `infra/bootstrap.sh`, run once
by a maintainer and safe to re-run), runs `what-if`, deploys `infra/main.bicep` and
the function, and ends with `functions/feedback/scripts/smoke.mjs`, which drives both
endpoints with the smoke-test key and waits for the runs on the one persistent
`smoke-test` issue, one of them with a private address in its title that must arrive
redacted. It also runs when `scripts/triage/redact.mjs` or `src/core/token-shapes.mjs`
changes, because the function's build copies both in. The smoke-test key is read from Key Vault at run time and masked.
Nothing it deploys may be always on; any change to `infra/` states its monthly cost
(CLAUDE.md, Cloud Cost).

## Discord

A Discord channel follows the project through one webhook, the `DISCORD_WEBHOOK`
repository secret. Without the secret, every notify step logs a skip and exits 0, so
forks and fresh clones never fail on it.

- `.github/workflows/discord-notify.yml` posts every issue as it opens and closes.
  An issue filed from outside (`from-website`, `from-terminal`) is posted with its
  title (the maintainer's call, 2026-10-28), but only after `node
  scripts/triage/redact.mjs --title` (title in `TITLE`, the denylist in `REDACT_TERMS`,
  neither on argv) has run on it, so a term redaction would remove from the issue never
  reaches a channel that keeps whatever it's sent. The job checks out `main` (no
  persisted credentials), sets up Node with the same pinned actions triage uses, and
  holds `contents: read` only. If the redactor fails or leaves nothing, the post says
  "title withheld" rather than the original. An insider's issue keeps its title as is.
  Each post sets `username: toil` and its avatar from
  `https://imagile-dev.github.io/toil/brand/toil-avatar-512.png`, so moving or
  renaming that file breaks the bot's avatar.
- `.github/workflows/release.yml` posts each npm publish (version, release
  notes, npm link). It **also posts loudly when a publish fails, or when the
  `release-guard` job fails**: a merged release PR that was skipped and is still
  `autorelease: pending`, a release that left out a package its PR listed, or a
  release PR body it couldn't escape (#536), because a
  silent release failure is the one that goes unnoticed. Every notify step is
  non-fatal: `|| echo "Discord notify failed (non-fatal)"`.
- `release-guard` also rewrites the release PR's body whenever release-please opened
  or updated it, escaping tag-like `<` as `&amp;lt;` (`scripts/release-pr-body.mjs`),
  so the merged PR's description shows `&lt;` literally. That's cosmetic: the release
  notes and CHANGELOG read `<`. No publish job needs `release-guard`, so nothing in it
  can hold back a release that was tagged.
- Event text such as issue titles reaches the script through `env:` and goes into the
  payload with `jq --arg`, never by interpolating `${{ }}` into `run:`. An issue
  title is attacker-controlled.

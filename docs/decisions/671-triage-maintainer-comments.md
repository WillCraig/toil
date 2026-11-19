# Triage takes the maintainer's comments as direction, and fixes when unsure (#671)

- **Every comment from `kolatts` on a triaged issue re-runs triage**, with no keyword
  or slash command. The maintainer asked for "any comment from only kolatts"; a
  keyword would be one more thing to remember. The cost is a run for a comment that
  only says thanks, which spends no slot of the daily cap (a comment is a re-triage,
  like a dispatch). Where: `.github/workflows/triage.yml`, `select` in
  `scripts/triage/steps.mjs`.
- **The login is matched, not the author association.** `OWNER` would let any future
  owner steer triage without a decision to add them. The login is in `MAINTAINER` and
  twice in `triage.yml`, and `test/workflow-wiring.test.ts` holds the three equal.
- **An agent posting under the maintainer's login isn't the maintainer.** Claude Code
  sessions run `gh` as `kolatts`, so a comment carrying an agent's mark (`ship`'s
  `<!-- toil-feedback-round -->` marker, its "Addressed by [Claude Code]" reply footer,
  a "Generated with [Claude Code]" footer) starts no run and isn't direction. A session
  that comments without one of those marks still counts; the marks are what the
  repository's own agents already write.
- **A comment on triage's draft PR re-triages its issue**, so direction can be changed
  on the PR, as the maintainer asked. Only a PR whose head is `claude/issue-<n>` in
  this repository and that carries `from-triage` counts. While that PR is marked ready
  or labelled `no-auto-fix` or `needs-human`, a comment on the PR or on the issue
  starts nothing. The re-run starts from `main` and force-pushes
  the branch, as `open-pr` always has, so the earlier fix is replaced rather than
  amended; once a person marks it ready or labels it, a comment leaves it alone.
  Inline review comments on the PR aren't read; conversation comments are. There is no
  round limit on these re-runs, because each one is the maintainer's own comment.
- **The maintainer's comments share one concurrency group** (`triage-maintainer`), but
  only those that pass the job's label test. The expression can't map a PR comment to
  its issue, and two re-runs of one issue would push the same branch; comments on
  different issues queue behind each other instead. Every other comment gets a group
  of its own, so it can't cancel a re-run that is waiting.
- **Only the maintainer's comments are trusted direction.** The project bot's comments
  (triage's earlier runs, the review agent on the PR) are given too, so the agent sees
  the question being answered, but inside the untrusted fence: they are agent output
  that read the stranger's text. A body line that could pass for an author header is
  indented. Nobody else's comment is included, even a member's. Both are redacted like
  the issue and cut to the last 20 comments of 4,000 characters each. Direction never
  overrides a principle or widens what triage may touch.
- **Unsure is a `fix`.** An unconfirmed API detail or an open design choice now opens a
  draft PR built on what can be confirmed, choosing the option that relies on nothing
  unconfirmed, with the assumption and the live check stated. The prompt's example is
  reading every page and filtering in toil while saying how much was read, not
  filtering one page, which would report a false zero (principle 12). It never changes
  behavior the command contract records, and leaves verification levels alone. `maintainer` stays for the
  site, the Azure Function backend, dependencies, a new area, and a bug with no plausible
  fix.
- **A re-triage that reaches any decision but `maintainer` removes `needs-maintainer`**, so the label says what is true
  now rather than what an earlier run decided.

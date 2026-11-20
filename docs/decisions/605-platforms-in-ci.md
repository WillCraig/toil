# Windows, macOS and Node 26 in CI on every PR (#605)

The maintainer chose the option (2026-11-17): both gates on every OS on every PR,
with Toil UI's layout check left to Linux. These are the decisions made in carrying
it out.

- **One job per OS and Node line, not split like Linux.** Five jobs (Windows and
  macOS on 24.22.1 and 26.12.1, Linux on 26.12.1) bring a run to 19 jobs with a peak
  of about 18 at once (`CI ok` runs last), inside GitHub Free's 20, with 4 of
  macOS's 5. Splitting each into a toil job and a Toil UI job would have meant 23 at
  once, so a run would queue on its own. The limit is per account, so a merge's push
  run and the release PR's new run share it and queue, as they already did. From the
  daily run's step times, the Windows job comes to about 12 minutes, a few longer
  than the Linux layout shards' 5 to 9, which makes it a run's longest job.
- **One `--include-tests` flag on the UI smoke, the maintainer's call (2026-11-17)**,
  replacing #640's `--shard k/N` rather than adding a second flag for the same idea:
  `layout` (the default), `layout:k/N` or `none`. The values name the part included,
  so `none` can't read as "no tests": the smoke still installs both tarballs offline,
  checks the server's Host, Origin, cookie and Fetch Metadata gates, and runs the live
  SQLite store and the wipe. The parser moved beside the shard logic in
  `layout-check.mjs` so it is unit-tested.
- **Toil UI's layout check per PR on Linux only** is a trade of cost for a day's
  delay, not a claim that every OS renders alike: fonts, text metrics and scrollbars
  differ, and the daily run checks every OS.
- **Lint and `check:lockfile` stay on Linux only.** They read the same files on every
  OS. Typecheck runs everywhere, since it's 20 seconds and a path or case problem
  shows there first.
- **Toil UI's steps follow the scope check** (a docs-and-config PR skips them, as it
  skips the Linux UI jobs), and toil's steps run whenever the scope check passed.
  `CI ok` takes only `success` from these jobs, since they skip only when the scope
  check failed, and says when Toil UI's steps were skipped on a docs-and-config PR.
- **`platforms.yml` stays as the daily backstop**: the whole smoke with the layout on
  every OS, and the skill install. It no longer runs on pull requests, so the release
  PR runs only `ci.yml`, which now covers every OS and `check:dist` on each.
- **Time limits on every job**: 5 minutes for the small ones, 20 for the gates, 25 for
  a layout shard, 30 for the database job and the new jobs, 150 for a daily job
  (the longest passing one took 99 minutes), 15 for a skill install. A hang on Nov 16
  ran for GitHub's six hours, and the failure was never filed: a job past its limit
  ends as cancelled, which `failure()` doesn't see. The daily report now runs on a
  failed or a cancelled job.
- **The release waits on the daily run, through its issue, the maintainer's call
  (2026-11-17).** A `release-platforms` job, on release PRs only and required through
  `CI ok`, fails while a `platforms-failure` issue is open. A passing platforms run on
  `main`, scheduled or started by hand, closes the issue, so nobody has to remember
  to. Only a scheduled run files one, as before. The issue rather than the last run's
  result, because the issue survives a cancelled or unfinished run and says why. The
  job needs `issues: read` only, with the workflow's own token.
- **Principle 8 now says so**: a check too costly to run on every OS per PR runs per
  PR on one and daily on all, and a release waits while the daily run fails.
- **Platforms runs queue instead of cancelling each other** (from review): with the
  report counting a cancelled job, a run started by hand on `main` that cancelled the
  scheduled one would have filed a false failure and held the release.

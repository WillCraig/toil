# check:lockfile tolerates the lockfile a release leaves (#299)

- **Decided:** `check:lockfile` passes, with a warning, in the one state a release
  leaves on `main`: Toil UI's dependency and the lockfile entry's version are the
  new pin, the entry's tarball and integrity are the previous toil's, and that toil
  is what `npm ci` installed. It runs on every PR, the release PR included, so the
  skip on `release-please--` branches in `ci.yml` and `platforms.yml` is gone.
  Every other disagreement (wrong dependency, wrong entry version, no integrity, a
  tarball outside the registry, an installed copy that isn't the tarball's version)
  still fails. The maintainer chose this (2026-11-05).
- **Why:** the release PR can't carry the right entry. Its integrity is the hash of
  a tarball that doesn't exist until `publish-toil` runs. `npm pack` is
  reproducible (packed twice, after touching mtimes, from a fresh copy and with npm
  11.19.1 against 11.5.1, byte for byte on Windows), so the hash could be computed
  early. But an entry naming a tarball npm doesn't serve yet makes every `npm ci`
  fail until it does, `publish-toil`'s own included (it installs at the tag before
  it publishes), and so would need a restore step in six places and a red `main`
  until npm propagates. Warning instead of failing keeps the lockfile PR, which
  stays the fix, off every other PR's critical path.
- **Where:** `lockfileLag` and `lockfileProblems` in `ui/scripts/package-rules.mjs`,
  the warning in `ui/scripts/check-lockfile.mjs` (an Actions `::warning::` there),
  `ui/test/package.test.ts`, `test/release-workflow.test.ts`.
- **Tightened after review:** the tolerated tarball must be an older toil than the
  pin (a hand-edited lockfile naming a newer or unrelated toil still fails), and the
  `lockfile` job fails unless `check:lockfile` says `ok`, so the fix it makes can't
  pass on the warning.
- **Overturns** the merge order in `478-beta.md`: the lockfile PR no longer has to
  merge before the `release-as` removal.
- **Gaps, for the maintainer (no principle covers them):** the warning has no end
  point, so if `publish-toil` fails and the `lockfile` job never runs, every PR
  warns about a PR that doesn't exist (release failures already post to Discord,
  #536). And the release PR now shows a green `check:lockfile` carrying a warning
  about its own leftovers, which a skimmed tick could read as "verified".
- **Not changed:** the `lockfile` job still opens its PR, and a human still merges
  it. `release-as`'s exemption for the lockfile PR stays; the lockfile PR no longer
  has to merge first for other PRs to pass, only for the lockfile to be right.

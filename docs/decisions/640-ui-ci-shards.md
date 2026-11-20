# Toil UI's layout check in eight CI shards (#640)

- **Eight shards, the maintainer's choice** from a plan that measured the gate: the
  smoke took 43 to 50 minutes of a roughly 50-minute job, 36.5 of them the
  reduced-motion layout check (16 theme schemes in four rounds of about nine minutes
  on a 4-core runner) and 5.3 the motion-on pass. Four shards was the alternative,
  with fewer jobs competing for the account's concurrent-job limit.
- **A unit is one theme scheme on one view,** claimed by count modulo N, like the
  root parity suite's shards, so a new theme or view lands in a shard by existing
  and the shards stay within one unit of each other. Splitting by theme would have
  given 16 coarse pieces of nine minutes each; splitting by width doesn't help, since
  each view still loads once per width. The motion-on pass is split the same way.
- **Every shard builds its own tarballs and runs the smoke's install, security, live
  and wipe checks.** The two builds take seconds from the same commit, less than a
  build job and an artifact hop would add before any shard starts, and needs no new
  action. The non-layout checks take about 30 seconds, so repeating them is simpler
  than deciding which shard owns them.
- **`fail-fast` is off,** so one round shows every shard's layout problems rather than
  cancelling the rest at the first.
- **`--shard` is CI's only;** with no shard the smoke checks everything, so local runs,
  `verify:ui` and `platforms.yml` (Windows and macOS, daily) are unchanged.
- **The Toil UI job is renamed "Toil UI checks",** and the shards are "Toil UI layout
  (k/8)". The ruleset requires only `CI ok`, which now needs both jobs and accepts a
  skip of either only on the scope check's explicit `full=false`.

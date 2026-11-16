# The fork-and-PR path for people running toil from a clone (#628)

- **The agent-facing steps live in the shipped skill, `skills/toil/install.md`,
  "Sending a fix back",** because the agents that need them are the ones driving a
  user's clone, which read the shipped skill and may never open `.claude/skills/`.
  README's Contributing section gets a short "From your clone" paragraph pointing
  there, and the `ship` skill a "From a fork" section for an agent that takes the PR
  to review.
- **The agent asks before every outward step** (issue, fork, push, PR) and shows the
  exact text first, mirroring the feedback steps in `skills/toil/core.md`, because a
  fork and a PR are public and made under the person's own account.
- **`.github/CONTRIBUTING.md` and CLAUDE.md are not edited.** The task that started
  this work asked for CLAUDE.md wording to be proposed, not committed, and kept
  `.github/` out of scope; both proposals are in the PR description for the
  maintainer. CONTRIBUTING.md already says fork branches can take any name and that a
  maintainer reviews and merges fork PRs. Its "from a fork, any branch name works" is
  wrong for a PR that writes a decisions file, whose name the gate checks for an issue
  number; the PR description proposes the fix.
- **A fork PR stops being watched once its checks pass,** and skips `needs-human` on
  `stalled` or `round-limit`, because a contributor can't add labels and the
  maintainer's review may take longer than the watcher's hour.
- **The shipped skill's index, `skills/toil/SKILL.md`, is unchanged.** It sits one byte
  under its 4 KB cap, so the fork path is named in `install.md`'s frontmatter
  description instead, which is what an agent reads to pick the page.
- **Skipped review finding: offering `toil feedback bug` to someone who won't fork.**
  `skills/toil/core.md`, **Feedback**, says an agent never offers a report on its own
  initiative, so the fork steps don't suggest it either.
- **Not fixed here: `.github/CONTRIBUTING.md` says PR CI runs on three OSes and two
  Node versions,** while CLAUDE.md says PR CI is Linux on Node 24.22.1 and the rest is
  in `platforms.yml`. `.github/` was out of scope for this change; the PR description
  proposes the fix.

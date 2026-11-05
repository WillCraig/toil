---
job: ship
description: Take your own branch to a pull request as the author, running the gate, updating the docs the change made stale, checking your own diff against the repository's principles, opening the PR, answering its review and fixing a failing build in one loop of at most three rounds. Use for "ship this branch" or "answer the review on #12".
role: author
needs: {"any": ["github", "bitbucket", "ado"], "optional": ["jira", "confluence", "sonar"]}
inputs: [{"name": "branch", "toilProject": false}, {"name": "ticket", "toilProject": false}, {"name": "repository", "toilProject": true}, {"name": "connection", "toilProject": true}]
writes: ["github pr create", "github pr update", "github pr reply", "github pr resolve", "github pr comment", "github pr enable-auto-merge", "github issue label", "bitbucket pr create", "bitbucket pr update", "bitbucket pr reply", "bitbucket pr resolve", "bitbucket pr comment", "ado pr create", "ado pr update", "ado pr reply", "ado pr resolve", "ado pr comment", "confluence page update"]
loop: 3
verification: unit
---

# Ship a branch

You are the author: the branch is yours, so you may push to it, and you never review
it as if it were someone else's. Rules every page shares: `workflows/README.md`. One
loop, three flows, one round counter and one stop. Asked for a single flow ("just
answer the review on #12"), do that flow and its round bookkeeping, nothing else.
`<host>` is `github`, `bitbucket` or `ado`; `<id>` is the PR's number or id.

## Flow 1: open

1. **Run the repository's gate** as its CLAUDE.md or AGENTS.md lists it, and fix what
   fails. Then `toil util secrets scan --diff staged` on what you are about to commit.
2. **Update the docs the change made stale,** in the same branch. List what changed
   (`toil git diff --staged`), then find the README, `docs/`, skill and wiki pages that
   mention it: `toil util size docs --depth 2` shows where the documents are, and for
   a wiki `toil confluence page search --cql "text ~ \"<name>\"" --limit 10`. Edit
   the files in the branch. A wiki page changes only on the person's yes:
   `toil confluence page update <id> --body-file <file> --markdown --allow-write`.
3. **Check your own diff against the principles.** Do the reviewer's steps 4 and 5
   (`workflows/review.md`) on it: the repository's rules, as on the base branch,
   each principle and what your diff does to it. A break or a gap goes to the person
   **before the PR opens**, with the options (change the diff, or ask the maintainer);
   never fix it silently and never open past it. A principle is the maintainer's to change.
4. **Open the PR** on the person's yes (or when the request said "open it"):

   | Host | Command |
   |------|---------|
   | GitHub | `toil github pr create --title "<title>" --head <branch> --base <base> --body-file <file> --allow-write` |
   | Bitbucket | `toil bitbucket pr create --title "<title>" --source <branch> --target <base> --description "<text>" --allow-write` |
   | Azure DevOps | `toil ado pr create --title "<title>" --source <branch> --target <base> --description "<text>" --allow-write` |

   The description says what changed, links the ticket (`core.md`, **Ticket the
   work**, if there is none), and says what was verified: the gate's result lines, real
   runs, what was not verified and why. Commit and push with your own git first.

## Flow 2: answer the review

1. **Read the unresolved threads.**

   | Host | Threads |
   |------|---------|
   | GitHub | `toil github pr threads <id>` (`isResolved`, thread ids for `pr resolve`) |
   | Bitbucket | `toil bitbucket pr comments <id>` |
   | Azure DevOps | Services: `toil ado pr threads <id>`. Server: `toil ado pr comments <id>` |

2. **For each, decide.** Fix what is asked. A request that goes against the
   repository's own rules gets a reply saying so and stays open for a person. A
   principle finding (a break or a gap) is never fixed on your own: take it to the person
   with the options.
3. **Run the gate and the secrets scan again, then commit and push.**
4. **Reply in each thread** with what changed, and resolve only the threads you fixed:

   ```bash
   toil <host> pr reply <id> <comment-id> --body "<what changed>" --allow-write
   toil <host> pr resolve <id> <comment-id> --allow-write
   ```

   GitHub's `pr resolve` takes the thread id alone (`pr resolve <thread-id>`), and Azure
   DevOps's reply and resolve take the thread id where Bitbucket and GitHub take a comment id.

## Flow 3: fix CI

1. **Read the failing run.**

   | Host | Failing run | Its log |
   |------|-------------|---------|
   | GitHub | `toil github commit checks <head-sha>` | none through toil: take the log from the person, or reproduce with the gate |
   | Bitbucket | `toil bitbucket pr builds <id>` | Cloud: `toil bitbucket pipeline logs <pipeline> <step>` |
   | Azure DevOps | Server: `toil ado pr builds <id>`, then `toil ado run get <id>` | Server: `toil ado run logs <id> --log-id <n>` |

2. **Condense the log** (save its text to a file in the workspace first):
   `toil util log <file> --level error --context 3`.
3. **Fix the cause, or say why it can't be fixed** (flaky test, infrastructure,
   a permission): never weaken a test or the gate to turn a check green.

## The loop

After each push, one round is over. **Count rounds on the PR itself:** end each
round with one comment starting `Round <n> of 3`, saying what changed, and take `n` as
one more than the comments already starting `Round `. On GitHub that count is
`toil github pr comments <id> --select "length([?starts_with(body, 'Round ')])"`; on
the others read `pr comments` and count the same way over its text field.

Then wait on the checks and the reviewers with `toil wait`, not by polling:

```bash
toil --select "length(@)" wait --until "length(@) > to_number('0') && length([?status != 'completed']) < to_number('1')" -- github commit checks <head-sha>
toil wait --until "length(@) > to_number('<reviews-seen>')" -- github pr reviews <id>
toil wait --until "<expression over what the read returns>" -- bitbucket pr builds <id>
```

For `bitbucket` and `ado`, read `pr builds` once to see which field holds a build's
state, then wait on it. After three rounds, label the PR `needs-human` and stop, saying
what is left: `toil github issue label <id> --label needs-human --allow-write`. The other
two hosts have no label command: post `needs-human` and what is left with
`toil <host> pr comment <id> --body "<what is left>" --allow-write`.

Turn on auto-merge only where the person's standing instruction says so:
`toil github pr enable-auto-merge <id> --method squash --match-head-commit <head-sha> --allow-write`.

## Done when

The PR is open with every check passing and every thread either fixed and resolved or
left to a person, or the third round is over and the PR is labelled `needs-human`.

## Report

1. The PR, its head commit and the round you are on.
2. Each thread: fixed, replied and left open, or taken to the person.
3. Principles: breaks and gaps raised, and what the person chose.
4. Docs changed, and wiki pages you left alone.
5. What the gate and the checks showed, with every check or log you couldn't read.

## Never

- Approve or merge a PR, or turn `writes` on.
- Open a PR past a principle break or gap, or fix one on your own.
- Resolve a thread you didn't fix, or reply as if you were the reviewer.
- Weaken a test, a rule or the gate to get a check green.
- Run a fourth round, or poll in a loop of your own.
- Push to a branch that isn't yours.

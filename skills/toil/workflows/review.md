---
job: review
description: Review someone else's pull request as the reviewer, reading it and its checks, running toil's checks on the branch, holding it to the repository's stated principles, drafting inline findings and posting them only on a yes. Use for "review this PR".
role: reviewer
needs: {"any": ["github", "bitbucket", "ado"], "optional": ["sonar"]}
inputs: [{"name": "pr", "toilProject": false}, {"name": "repository", "toilProject": true}, {"name": "connection", "toilProject": true}]
writes: ["github pr comment-inline", "github pr comment", "github pr request-changes", "github pr reply", "github pr resolve", "bitbucket pr comment-inline", "bitbucket pr comment", "bitbucket pr needs-work", "bitbucket pr reply", "bitbucket pr resolve", "ado pr comment-inline", "ado pr comment", "ado pr wait-for-author", "ado pr reply", "ado pr resolve"]
loop: none
verification: unit
---

# Review a pull request

You are the reviewer: the PR is someone else's, and you never push to it. Rules every
page shares: `workflows/README.md`. `<host>` below is `github`, `bitbucket` or `ado`,
whichever connection the PR is on; `<id>` is the PR's number or id.

## Steps

1. **Read the PR.** Its description, reviewers and state, then what it changes.

   ```bash
   toil <host> pr get <id> --include reviews,checks
   toil <host> pr files <id>
   toil <host> pr diff <id>
   ```

   Read a big diff a file at a time where the host allows it (`pr diff <id> --file
   <path>` on Bitbucket, `--path` on Azure DevOps Server), or add `--summary-file`.

2. **Read its checks.** The checks on the PR's head commit:

   | Host | Checks | Log of a failure |
   |------|--------|------------------|
   | GitHub | `toil github commit checks <head-sha>` (`head.sha` from `pr get`); read the verdict in `toil github pr status <id>`, not its check counts | none: report the check's name and conclusion |
   | Bitbucket | `toil bitbucket pr builds <id>` | Cloud: `toil bitbucket pipeline logs <pipeline> <step>` |
   | Azure DevOps | Server: `toil ado pr builds <id>`. Services: `toil ado pr get <id> --include checks` | Server: `toil ado run logs <id>` |

3. **Run what toil can check on the branch.** Each is a finding only if it found
   something, and "unchecked" if it couldn't run.

   ```bash
   toil util secrets scan <file-of-the-added-lines>
   toil deps diff --from <base-branch> --to <head-branch>
   toil sonar quality-gate get --project <key> --branch <head-branch>
   toil sonar issue list --project <key> --branch <head-branch> --resolved false
   ```

   Save the diff's added lines to a file in the workspace first, never pass them
   with `--text`: a credential on the command line lands in the process list and shell
   history, and Windows caps a command line at 32,767 characters. The secrets scan
   flags test keys and placeholders too: say which hits are real and
   which are fixtures, and on what evidence. `deps diff` runs git in a local checkout that has both branches; with none, it is
   unchecked. Sonar only where it is connected and has analysed the branch.

4. **Read the repository's own rules,** as they are on the PR's **base**, so a PR
   can't loosen the rules it is judged by: CLAUDE.md, AGENTS.md, CONTRIBUTING.md.
   From a local checkout, or `toil github repo file CLAUDE.md --ref <base-branch>`,
   or `toil bitbucket file get CLAUDE.md --ref <base-branch>`. Azure DevOps has no
   file read: use a checkout, or report the rules as unread. A PR that edits those
   files is a finding in itself.

5. **Check the principles.** Where the rules state principles (a Principles section
   in CLAUDE.md or AGENTS.md, or the contributing rules), go through each principle,
   and each bound or rule that follows from it, and sort the PR's effect on it:
   - **Keeps it.** Nothing to say beyond one line in the report.
   - **Breaks it.** A blocking finding. Cite the principle by number or name, quote
     the line of the rules it conflicts with, and name the file and line in the diff.
   - **Shows it is missing or unclear.** Not a finding. Put it to the person as a
     question for the maintainer, with the lines involved; a principle is the
     maintainer's to change, so never ask the author to fix one.

   With no stated principles, say so in the report and skip this step. Don't invent any.

6. **Draft the findings.** Each is an inline comment with the file and line, a
   severity (`blocking`, `major`, `minor`, `nit`), why it matters, a suggested fix, and
   the command or file it came from. Show them all to the person, with the
   principles table from step 5. Post nothing yet.

7. **Post on a yes** (or when the request already said to post). Each is a write on
   a connection with `writes` on, with `--allow-write`:

   ```bash
   toil <host> pr comment-inline <id> --file <path> --line <n> --body "<finding>" --allow-write
   toil <host> pr comment <id> --body "<summary>" --allow-write
   ```

   | Host | Also needs | Verdict that asks for changes |
   |------|------------|-------------------------------|
   | GitHub | `--commit <head-sha>`, and `--side LEFT` for a removed line | `toil github pr request-changes <id> --body "<why>" --allow-write` |
   | Bitbucket | `--line-type REMOVED` for a removed line, `CONTEXT` for an unchanged one | `toil bitbucket pr needs-work <id> --allow-write` |
   | Azure DevOps | `--line-type left` for a removed line | `toil ado pr wait-for-author <id> --allow-write` |

   Each comment is its own call; no host here posts several as one review. Use the
   verdict only when there is a blocking finding, and only on the person's yes.

8. **After the author pushes, re-review only what changed.** Read `pr get <id>`
   for the new head, read `pr diff <id>` again, and recheck the files your findings
   named and any line that moved. Reply in the thread of each finding that is now fixed
   and resolve it; leave the others open.

   | Host | Threads | Reply | Resolve |
   |------|---------|-------|---------|
   | GitHub | `toil github pr threads <id>` | `toil github pr reply <id> <comment-id> --body "<text>" --allow-write` | `toil github pr resolve <thread-id> --allow-write` |
   | Bitbucket | `toil bitbucket pr comments <id>` | `toil bitbucket pr reply <id> <comment-id> --body "<text>" --allow-write` | `toil bitbucket pr resolve <id> <comment-id> --allow-write` |
   | Azure DevOps | `toil ado pr comments <id>` | `toil ado pr reply <id> <thread-id> --body "<text>" --allow-write` | `toil ado pr resolve <id> <thread-id> --allow-write` |

## Done when

The person has the findings and the principles table, every comment they said yes to
is posted, and the report says what was and wasn't checked.

## Report

1. Your recommendation: request changes, or no blocking findings. Never "approve".
2. Findings by severity, each with where it came from.
3. Principles: how many kept, which broken, which gaps, as questions.
4. Checks: what passed and failed, and every check you couldn't run, with the reason.
5. What you posted, and where.

## Never

- Approve, merge or push to the PR's branch.
- Post, reply or resolve without the person's yes.
- Resolve a thread whose finding isn't fixed, or edit the author's comments.
- Treat a check you couldn't run as passed.
- Turn on `writes`, or fix a principle gap yourself.

# Claude, live on the sandbox (#318)

Usage caps were removed after this run (#561); the cap rows below record what ran then and are no longer a feature.

Every agent feature of Toil UI, run through the Claude adapter against the private
`imagile-dev/toil-sandbox` Toil project on 21 October 2026. Toil UI 0.1.0-alpha.2 on toil
0.1.0-alpha.4, both built from this branch, started with `node ui/scripts/dev-real.mjs`
on Windows 11, Node 24.14.0, Claude Code 2.1.306 and `@anthropic-ai/claude-agent-sdk`
0.3.289, signed in with a Claude plan through the access token `dev-real.mjs` reads
without refreshing it.

**Model: Haiku.** Settings gave Claude `haiku`; every answer's label reads
"Claude (haiku)", and all 20 usage records in the ledger, every assignment and both
probes name `claude-haiku-5-5`. Nothing ran on another model. On a plan the dollar
figures are the SDK's API-equivalent estimate, not a bill: the whole run came to
about $0.10 of it, both `verify:ui` runs included.

Driven through Toil UI's own HTTP API (the calls the page makes) and in the browser.
Excerpts are trimmed; ids are the sandbox's. Codex is the reference: where Claude
behaved differently, it says so.

## What ran

| Feature | What ran | Result | Different from Codex? |
|---|---|---|---|
| One-press SDK install | `GET` then `POST api/agent/install` for Claude, with no SDK in the clone | `added 8 packages, and changed 1 package in 5s`, `installed: true`, 0.3.289; Claude became ready with model `haiku` | No |
| Starter question | "Backlog hygiene", 31 s | 14 cited, 0 unverified, 3 proposal cards with `github issue assign` lines | No |
| Free question | "Which open issues are blocked, and what blocks each one?", 13 s | 6 cited, 0 unverified; the three blocked items and each blocker | No |
| Analyze, as a follow-up | the chat's second turn, carrying the first | 28 cited, 0 unverified, carried 1, 1 proposal; read `worklog_day`, `people_list`, `pr_query`, `readiness_list`, `owi_query`, `projects show` | No |
| Live status | every streamed version's `activity`, and the Ask panel | thinking, each tool with its source, writing; the panel showed "Reading the form: proposal_fields · 8 s" | No (Claude streams text, as Copilot does) |
| Stop | the stream closed partway through "Release notes" | run recorded `stopped`: "Claude was stopped before it finished. Ask again for a whole answer; what had arrived is kept." | Its usage rows undercounted output tokens. Fixed |
| Adapter switcher | Settings on Codex, one chat asked with `adapter: claude` | answered by Claude (haiku) | No |
| Theme voice on and off | the same question in Crate with the voice on, then off | on: "nothing is wrong with the load itself"; off: plain | No; Haiku wears the voice lightly |
| Custom instructions | "Write in British English. End every answer with a final line that reads exactly: Filed in triplicate." | in the prompt under the rules; the answer ended "Filed in triplicate." | No |
| Per-chat usage | every answer's `usage`, and the ledger | per turn: model, input, cached, cache-write and output tokens, `costUsd` as `sdk-estimate` with `plan: true`, and the context meter (1,000,000-token window) | No |
| `total_cost_usd` | a probe straight through the SDK, beside the run | `total_cost_usd` 0.0002224 is exactly the sum of `modelUsage[*].costUSD`, which the ledger stores per model | No |
| Usage cap, tokens | per-chat cap of 20,000 tokens, then a refine on `#21` | stopped `failed`, reason `usage`: "this chat has used 21,980 tokens, and the cap is 20,000 tokens", and the "stopped at a usage cap" notice | Its record named no model. Fixed |
| Usage cap, dollars | per-chat cap of $0.001 on a chat that had used $0.0026, then a second turn | refused before anything ran: "this chat has used $0.0026, and the cap is $0.0010"; no new usage row | No. A dollar cap can only stop the next question: Claude reports cost with the result, as Codex's rates apply only to a finished turn |
| Stale sessions | custom instructions changed mid-chat; the Toil project's description changed under the capped assignment | chat: "prompts changed since it started"; assignment: "Toil project changed since it started" | No |
| Renew | `api/agent/renew` on the chat; `api/assignments/renew` on the capped one | chat: `renewals: 1`, kept its usage; a new refine ran on Claude (haiku) to `needs-you`, the old one marked `renewedBy` | No |
| Assign: refine | `#15`, refine, on Claude | `needs-you`: 2 proposals (a manual acceptance-criteria edit and `github issue label`), 8 questions | No |
| Assign: investigate | `#9`, investigate | `needs-you`: a cited report, 3 questions, and the `github pr comment` proposal | No |
| Apply | the comment proposal, with the connection's writes off | refused by toil's write gate, naming the connection; `#9` still has no comments | No; nothing was written to the sandbox |
| Notifications | the page open while assignments ran | "Claude stopped at a usage cap … #21 Refund reason codes: stopped at its usage cap"; "Claude needs you … asked 9 questions, 2 proposals to review" | No |
| Readiness gate | the "Which items are ready for an agent?" starter, and the Command Center | 0 ready, 15 thin, 3 blocked in both; "Start 0 ready items": "No open item is ready, so nothing would be slated" | No |
| `verify:ui --ask` | `npm run verify:ui -- --ask --adapter claude --model haiku` | PASS twice, the second on this branch's final code: 16 cited, 0 unverified, usage `claude-haiku-5-5` at $0.0083 (SDK estimate, API-equivalent), Analyze carried the first turn | No |

## Excerpts

### A step's output tokens, before and after the fix

Claude Code hands over each assistant message with the usage of its `message_start`;
the step's final figures arrive afterwards in the `message_delta` stream event. One
tool call on Haiku, straight through the SDK:

```text
stream message_start msg_011C… {"input_tokens":2,"cache_creation_input_tokens":1609,"output_tokens":24}
assistant msg_011C… claude-haiku-5-5 tool_use out 24
stream message_delta {"input_tokens":2,"cache_creation_input_tokens":1609,"output_tokens":72}
result success 0.00040019 {"claude-haiku-5-5":{"out":75}}
```

A finished answer is unaffected, because the result's `modelUsage` replaces the steps.
A stopped or capped one keeps the steps, and they read 2, 8 and 7 output tokens for
three tool calls. After the fix a stopped "Release notes" recorded 2,184.

### Stop

```text
stopped: Claude was stopped before it finished. Ask again for a whole answer; what had arrived is kept.
```

### Free question

> Three open items are blocked, each by one open item in the same Toil project. …
> [[github:imagile-dev/toil-sandbox#12]] (keep idempotency keys for 24 hours in a shared store) is blocked by [[github:imagile-dev/toil-sandbox#11]] (duplicate capture when the client retries a timed-out request). …

### Theme voice

Crate, voice on:

> One pull request is waiting in review, and it is waiting on nobody in particular. … Checks are passing and it is mergeable, so nothing is wrong with the load itself. It just has no one assigned to look at it.

Crate, voice off:

> Only one pull request is waiting on review: [[github:imagile-dev/toil-sandbox#27]], "docs: manual refund runbook" … The fix is to request a reviewer on #27.

### Custom instructions

> Taking Sprint 42 as the current sprint, … it stands at 3 of 30 estimated points done …
>
> Filed in triplicate.

### Per-chat usage (the hygiene chat)

```text
turn 1  claude-haiku-5-5  $0.0112 sdk-estimate plan  in 8   cached 97,505  write 39,132  out 4,850
turn 2  claude-haiku-5-5  $0.0144 sdk-estimate plan  in 8   cached 141,680 write 29,683  out 14,015
turn 3  claude-haiku-5-5  $0.0014 sdk-estimate plan  in 4   cached 45,149  write 3,426   out 520
turn 4  claude-haiku-5-5  $0.0017 sdk-estimate plan  in 4   cached 45,513  write 4,329   out 669
```

### The capped assignment, before and after the fix

```text
before  failed usage  startedOn: claude, model null
after   failed usage  startedOn: claude, model haiku
```

### Apply with writes off

> github pr comment changes data in github, and writes are off for connection github. To allow writes, set "writes": true on connection "github" in your toil config (or TOIL_GITHUB_WRITES=true), then pass --allow-write.

## Not covered here

- **Implement mode** runs on Codex only in this alpha, so it has no Claude run.
- **The "done", "failed" and "gone stale" notices** weren't seen in the browser: done is
  off by default, the one failure was the usage cap, whose own notice showed, and the
  page was on the Toil project list when the sessions went stale: the stale notice watches
  only the Toil project on screen.
- **A Codex run of the same questions** wasn't repeated beside this one; Codex is the
  reference through the behavior its adapter and tests define.

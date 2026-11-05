# GitHub Copilot, live on the sandbox (#317)

Every agent feature of Toil UI, run through the Copilot adapter against the private
`imagile-dev/toil-sandbox` Toil project on 21 October 2026. Toil UI 0.1.0-alpha.2 on toil
0.1.0-alpha.4, both built from this branch, started with `node ui/scripts/dev-real.mjs`
on Windows 11, Node 24.14.0, the Copilot CLI 1.0.100 and `@github/copilot-sdk` 1.0.16.

**Model: `mai-code-1.1-flash`**, the cheapest this account lists. No model was at 0×:
`auto`, `claude-sonnet-4.6` (9×), `claude-haiku-4.5` (0.33×), `gpt-5.3-codex` (6×),
`mai-code-1.1-flash` (0.25×). Every answer and every usage record below names it.

Driven through Toil UI's own HTTP API (the calls the page makes) and in the browser.
Excerpts are trimmed; ids are the sandbox's. Codex is the reference: where Copilot
behaved differently, it says so.

## What ran

| Feature | What ran | Result | Different from Codex? |
|---|---|---|---|
| One-press SDK install | `GET` then `POST api/agent/install` for Copilot, with its SDK removed first | npm's line streamed, `installed: true`, 1.0.16 | No |
| Starter question | "Backlog hygiene", 47 s | 12 cited, 0 unverified, 10 proposal cards with `github issue label` / `assign` lines | It wrote 14 proposals and 4 were cut at the page's limit; the prompt didn't say there was one. Fixed |
| Free question | "Which open issues are blocked, and what blocks each one?", 14 s | 6 cited, 0 unverified | No |
| Analyze, as a follow-up | the chat's second turn, carrying the first | 29 cited, 0 unverified, carried 1, read `worklog_day`, `people_list`, `owi_query`, `pr_query`, `readiness_list` | No |
| Live status | every streamed version's `activity` | thinking, then each tool with its source, then writing, then the time taken | No (Copilot streams text; Codex hands it over a message at a time, as the README says) |
| Stop | the stream closed partway through "Release notes" | run recorded `stopped`; no answer text yet | The error read "GitHub Copilot failed: The question was stopped. Check that the Copilot CLI is signed in". Fixed for every adapter |
| Adapter switcher | Settings on Codex, one chat asked with `adapter: copilot` | answered by GitHub Copilot (mai-code-1.1-flash) | No |
| Theme voice on and off | the same question in Crate with the voice on, then off | on: "this is the only lane blocked at the dock"; off: plain | No |
| Custom instructions | "Write in British English. End every answer with a final line that reads exactly: Filed in triplicate." | in the prompt under the rules; the answer said "centred" and ended "Filed in triplicate." | No |
| Per-chat usage | every answer's `usage`, and the ledger | tokens, cached tokens, context window, premium requests and quota per call | Premium requests were counted on every call. Fixed: once per prompt |
| Usage cap | per-chat cap of 0.5 premium requests, then a refine | stopped `failed`, reason `usage`, and the "stopped at a usage cap" notice | It stopped after 2 calls that Copilot billed as 0.25, because of the count above |
| Stale sessions | custom instructions changed mid-chat; Toil project description changed under assignments | chat: "prompts changed since it started"; assignments: "Toil project changed since it started"; Renew on both | No |
| Renew | `api/agent/renew` on the chat; `api/assignments/renew` on the failed one | chat kept its usage; a new refine ran on Copilot, old one marked `renewedBy` | No |
| Assign: refine | `#15`, refine, on Copilot | `needs-you`: 1 proposal, 3 questions | No |
| Assign: investigate | `#12`, then `#9` after the fix | `needs-you`, a cited report | Its "post as a comment" proposal had no command on GitHub. Fixed: `github pr comment` |
| Apply | the comment proposal, with the connection's writes off | refused by toil's write gate, naming the connection | No; nothing was written to the sandbox |
| Notifications | the page open while assignments ran | "GitHub Copilot needs you … 1 proposal to review"; "GitHub Copilot stopped at a usage cap" | No |
| Readiness gate | the "Which items are ready for an agent?" starter, and the Command Center | 0 ready, 15 thin, 3 blocked in both; Start every ready item slates nothing and says why | No |
| Not ticketed yet | "Add exponential backoff to the payout webhook retries" in the Ask bar, then Ticket this | banner matched `#5` at 63% alike; sub-task and new-ticket proposals with `toil github issue create` lines | No (the banner uses no model) |
| `verify:ui --ask` | `npm run verify:ui -- --ask --adapter copilot --model mai-code-1.1-flash` | first run: every Ask check passed but "proposals parsed" (11 written, 1 cut); after the limit went into the prompt, PASS: 10 proposals, 12 cited, 0 unverified, premium requests 0.25 then 0 for each follow-up call, Analyze carried the first turn | No |

## Excerpts

### Premium requests: what Copilot bills

One prompt with two tool calls, straight through the SDK (the probe behind the fix):

```text
usage {"model":"mai-code-1.1-flash","cost":0.25,"initiator":"user","interactionType":"conversation-agent","in":101,"out":17}
usage {"model":"mai-code-1.1-flash","cost":0.25,"initiator":"agent","interactionType":"conversation-agent","in":137,"out":17}
usage {"model":"mai-code-1.1-flash","cost":0.25,"initiator":"agent","interactionType":"conversation-agent","in":173,"out":5}
metrics {"totalPremiumRequestCost":0.25,"totalUserRequests":1, ... "modelMetrics":{"mai-code-1.1-flash":{"requests":{"count":3,"cost":0.25}, ...}}}
```

Before the fix the chat heading said "1 premium request" for a question Copilot billed
at 0.25. After it, the hygiene starter's records read `0.25, 0, 0, 0`.

### Stop, before and after

```text
stopped: GitHub Copilot failed: The question was stopped. Check that the Copilot CLI is signed in (run copilot once on its own), then ask again.
stopped: GitHub Copilot was stopped before it finished. Ask again for a whole answer; what had arrived is kept.
```

### Free question

> According to the cached readiness verdicts, 3 open issues are blocked.
> - [[github:imagile-dev/toil-sandbox#12]] "Keep idempotency keys for 24 hours in a shared store instead of per instance" is blocked because [[github:imagile-dev/toil-sandbox#11]] is still open. …

### Theme voice

Crate, voice on:

> Only one PR is stuck in review right now: [[github:imagile-dev/toil-sandbox#27]] - docs: manual refund runbook. … The cache shows no other open PRs waiting on review, so this is the only lane blocked at the dock.

Crate, voice off:

> The only thing stuck in review right now is [[github:imagile-dev/toil-sandbox#27]] ("docs: manual refund runbook"), which is linked to [[github:imagile-dev/toil-sandbox#9]]. It has been waiting on review for 1.2 working days …

### Stale and renew (chat)

```text
before {"reasons":["prompts changed"],"text":"prompts changed since it started","restart":null}
renew 200 {"startedAt":"2026-10-21T03:51:50.288Z","stale":null,"renewals":1}
```

### Assignment events (refine on #15)

```text
created  queued     Assigned by a person in Toil UI to GitHub Copilot, in refine mode.
state    working    Working.
state    needs-you  Finished: proposals or questions wait on you.   (pending 1, questions 3)
```

### The investigation's comment proposal, after the fix

```json
{ "title": "Post the report as a comment on imagile-dev/toil-sandbox#9", "command": "github pr comment", "input": { "toilProject": "sandbox", "number": 9, "body": "The work item asks for a step-by-step manual refund procedure …" } }
```

Applied with writes off: "github pr comment changes data in github, and writes are off for connection github. …"

## Not covered here

- **Implement mode** runs on Codex only in this alpha, so it has no Copilot run.
- **The "done" and "failed" notices** weren't seen in the browser: done is off by default, and the one failure was the usage cap, whose own notice showed.

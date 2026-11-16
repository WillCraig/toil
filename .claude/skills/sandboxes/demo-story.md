# The demo story: Deliverables Unlimited at Overdraft Federal

Every demo recording tells one story, so a viewer who watches several videos sees
the same people, merchants and problems connect across tools. The data is seeded by
the scripts in [demo-reset.md](demo-reset.md). All of it is made up: Deliverables
Unlimited, Overdraft Federal, their merchants and their people don't exist. The
audience is American, so every amount in the story is in US dollars. A few older
sandbox issues (EU card exemptions, FX rates) are Overdraft Federal serving merchants'
foreign customers, and the replica's dates are relative to the day it's loaded.

## The engagement

**Deliverables Unlimited** is a consultancy. It has a team embedded at **Overdraft
Federal**, a large US financial services company that runs consumer banking and
merchant acquiring: it takes card payments for US small businesses, settles them
into daily or weekly payouts, and handles refunds and disputes. That is the case
toil was built for: the consultants work in the client's Jira, Azure DevOps and
GitHub, through one tool, with nothing installed but Node.

The client's engineering has three teams, and each one works in a different tool,
which is the whole point of the story:

| Team | Owns | Tracks work in | Code in |
|---|---|---|---|
| **Checkout** | the hosted checkout, saved cards, 3-D Secure | Jira `SCRUM` | GitHub `toil-sandbox` (shared with Platform) |
| **Platform** | the payments service: capture, idempotency, the card vault | GitHub `toil-sandbox` issues and milestones | GitHub `toil-sandbox` |
| **Settlement** | batches, payouts, the ledger, reconciliation | Azure DevOps `Toil Sandbox` | ADO `settlement-service` |

Production data is read from a **read replica** (`payments-db`, Postgres) and an
older **finance ledger** (SQLite). Designs live in **Figma**. Everything people
know lives in **Confluence**, in the space **OD, "Overdraft Federal Engineering"**:
how Deliverables Unlimited works there (what consultants may change, with writes off by default),
who owns what, how money moves, a runbook for each thread below, the decisions
(ADR-007, 009 and 011), the standards the agent-ready items follow, the release
checklist and the Black Friday freeze, and two incident reviews.

**The protagonist is Sam Rivera, Deliverables Unlimited's engagement lead**,
embedded at the client across all three teams. That's the identity the seeds act
as, so set the Atlassian, Azure DevOps and GitHub display names to "Sam Rivera
(demo)" before recording. Other people appear only in the story's words (comments,
the Figma file), never as accounts: Priya (Platform, the vault), Diego (Checkout)
and Mei (Settlement) are Overdraft Federal staff; Ana is Deliverables Unlimited's
designer. Real assignees for them would need accounts of their own (machine
accounts on GitHub, or plus-addressed Atlassian and Microsoft accounts); until
then, the seeds assign only the token's identity.

The merchants, all US and all in USD: Northwind Coffee (WA), Trailhead Outdoor
(CO), Paper Crane Stationery (OR), Lumen Games (TX, high risk, weekly payouts since
12 Nov), Harbor Books (MA) and Bayou Street Eats (LA).

## The week

It's Monday 16 November. **Sprint 44 ends Friday 27 November, which is Black
Friday.** The client has promised two things by then: **stored cards end to end**
(save a card at checkout, then charge the token later) and **weekly payouts with a
preview**, so merchants can see what's coming.

Four threads run through the week, and each one crosses tools.

### 1. Stored cards are stuck behind the vault (the critical chain)

Priya's vault work holds everything else up.
- Jira **SCRUM-14** (store tokens in the vault, in progress) blocks **SCRUM-17**
  (tokenise at the edge), and that blocks SCRUM-18, SCRUM-21 and SCRUM-30. It also
  blocks **SCRUM-15** (charge a stored token).
- The same work in ADO: **#152** (vault storage) → **#169**; the code side on
  GitHub: **#7** (tokenise at the edge) → **#8** (rotate vault keys).
- *Demo:* Toil UI's Blocked view shows the chain across Jira, GitHub and ADO, and
  the stand-up says what holds Sprint 44.

### 2. Lumen Games' payout is wrong (the split payout, and the Payout preview)

Lumen Games, a high-risk game studio in Texas, switched from daily to weekly payouts on
12 November.
- The replica shows their pending balance split into two payouts, and the second
  one is labelled with the old daily period (`payments.payouts`, merchant 4). That
  is GitHub **#15**, the long-titled bug.
- Merchants want to see this coming. That is the **Payout preview**, GitHub **#17**,
  designed in Figma by Ana (the file "Overdraft Federal: Payout preview", on Lumen
  Games' real numbers: pending $2,649.00, holds −$346.15, next payout $2,302.85 on
  Fri 20 Nov). Ana's comments in Figma ask how the split should look, which is exactly
  bug #15.
- #17 is blocked by **#12** (a shared idempotency store), which is blocked by
  **#11** (duplicate captures). The rolling reserve, **#18**, waits on #17.
- *Demo:* "Why is Lumen Games' payout wrong?" Ask reads `payments-db`, finds the
  split, links #15 and #17, and the agent reads the Figma frames and comments to
  write #17's acceptance criteria.

### 3. Customers are charged twice (one root cause, three tools)

- The replica holds payments captured twice on one idempotency key, about once a
  day (`payments.payments`).
- Platform's GitHub **#11** has the fix in review: **PR #37** (check the key before
  calling the processor), waiting on review.
- Checkout's Jira **SCRUM-20** ("a double click charges twice") was picked up
  today; its comment names the same root cause.
- *Demo:* the stand-up puts the GitHub PR and the Jira story side by side, and Ask
  ties both to rows in the replica.

### 4. Settlement runs late at night (the 2 a.m. incident)

- Nightly reconciliation failed last night on a lock that the statement export
  holds (`payments.job_runs`). It fails about once a week. That's GitHub **#22**.
- Settlement's ADO **#176** (settlement totals a day early in UTC-5) has its fix,
  `settlement-service` **PR 1**, waiting on review; **#172** (the ledger read
  replica in the pool) was picked up today.
- *Demo:* "Why did reconciliation fail last night?" joins #22 to the job rows and
  the overlapping export, and to the reconciliation runbook in Confluence. The
  incident review of 5 November shows it has happened before; the one of 28 October
  is the UTC-5 bug that ADO #176 now fixes.

## Small things an agent can take (the agent episode)

Three items are small, specified and testable (`npm test`), one per team. Each
grew out of a thread above, and each follows a standards page in Confluence (money,
logging, refund reasons) that the agent can read first:

| Item | Team | Why it exists |
|---|---|---|
| GitHub **#38**: format amounts as US dollars (`-$1,234.50`) in `formatAmount` | Platform | Statements and the payout preview print "-1234.50 USD". The same money code is behind the half-cent rounding that leaves refunds $0.01 short (view `payments.refund_shortfalls`), which is why the money standard exists |
| Jira **SCRUM-55**: `maskPan()` for the logs | Checkout | The debug-log bug (GitHub #25) and the PCI audit evidence (#33) both point at card data in logs, and SCRUM-16 split the helper out |
| ADO **#194**: refuse an unknown refund reason | Settlement | The dispute webhook (GitHub #20) needs clean reason codes |

## Friday: Black Friday readiness

- `toil deps scan` and `toil osv vulns` find real advisories in `express` 4.19.2
  and `jsonwebtoken` 8.5.1. Those are the upgrade issues (GitHub #30) and the JWT
  patch (#31) that are still open.
- The agent drafts the "Black Friday readiness" page in Confluence (the one page
  the space leaves out) from the release checklist template, the freeze page, the
  open blockers, the code reviews and the vulnerabilities. The write gate stops it until
  Sam turns writes on for Confluence.

## Video map

| Video | Story beat | Surfaces |
|---|---|---|
| 1 · Toil UI: Monday stand-up | The whole week in one report, the critical chain | Toil UI Summary, Stand-up, Blocked, Code reviews |
| 2 · Toil UI: Ask | Lumen Games' payout; reconciliation at 2 a.m. | Ask over Jira, GitHub, ADO and `payments-db` |
| 3 · The CLI | One shape across tools: the chain, the PRs, the replica | `toil jira`, `github`, `ado`, `db`, `--select` |
| 4 · Agents | Kick off agents on #38, SCRUM-55 and #194, then watch the PRs land in Code reviews | `toil mcp`, Claude Code / Codex / Copilot |
| 5 · Friday readiness | Vulnerabilities, the release page, the write gate | `toil osv`, `toil confluence`, writes |

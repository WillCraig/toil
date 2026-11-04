# Toil UI for people new to AI: quieter screens, plain words, guided Ask (#552)

## Plain words, themed words, the Agents panel

- **Plain words are the default.** The prototype from the design exploration was a header switch. Here plain words start on, and `?words=standard` or a saved `standard` choice turns them off. The switch lives only in Settings → General and the command palette, not the header, because a button on every screen is what this change removes. **Where:** `ui/src/plain-words.ts`.
- **A dossier is a "Toil project" in plain words, never a "team".** This is the maintainer's call on #552, 2026-11-03: a dossier isn't necessarily a team, and the "Toil" prefix keeps it apart from Jira and Azure DevOps projects and from `--project`. It always has a capital T. Ledes say "On the command line, a Toil project is called a dossier." `toil dossiers …` commands and ids are never swapped. CLI names are unchanged, since renaming them would be a breaking change under principle 7.
- **Themed wording and themed agent voice start off** for anyone who hasn't chosen. A saved choice is kept, and `?wording=` / `?voice=` still win. Realm's people alignments follow wording, so they are off too. **Where:** `ui/src/theme-choice.ts`.
- **The Agents panel is collapsed at every width.** It is behind one "AI helpers" button, whose count is inbox items plus proposals waiting plus open questions. From 1200px the button toggles the side column and remembers the choice; below that it opens the drawer. The palette can open it at either width. **Where:** `ui/src/assign/panel-choice.ts`, `DossierShell.tsx`.
- **Tests that assert toil's own labels pin standard words** per file or per `describe` (`ui/test/words.ts`), not globally, so the suite still exercises the default.
- **Skipped:** the "Create a dossier" form in Settings, and other Settings forms, keep standard wording. They are for whoever sets toil up.

## The Summary tab leads with the answer

- **What:** the tab opens on one sentence ("Behind: 18 of 21 points are left, and 3 working days remain."), a status word with a shape, then one "why" sentence, a "How was this worked out?" fold and at most three "Needs attention" cards. The old headline, the reasons, the numbers and Customize sit under "Show the full briefing", closed until a person opens it, and which way they left it is kept in this browser (`toil-ui.briefing`, `fullOpen`). **Why:** the old headline was in engineers' words with three ticket keys in it. **Where:** `ui/src/views/Overview.tsx`, `ui/src/components/summary.tsx`, `ui/src/model/summary.ts`.
- **What:** one status rule, `ui/src/model/status.ts`, ported from the design lab: On track when the points left fit at the pace so far, At risk from 75% of them landing or when a red reason holds work up, Behind below 75%, No sprint without dates. **Why:** the code's sprint lens says only "at risk or not", and two screens must not call one sprint by two names. The 75% line is invented, so the fold says it, and the word is labelled an estimate. **Where:** `status.ts`, the fold in `answerOf`.
- **What:** `projected` is rounded to a tenth by the code, so a projection within 0.05 of the points left counts as all of them. **Why:** 17.96 of 18 would otherwise be "At risk" for a rounding error.
- **What:** with no pace yet the word is On track (At risk with a red reason), and the sentence under it says it is too early to judge a pace. **Why:** the lab's choice; "No sprint" would be wrong, since there is one.
- **What:** working days left is `daysLeft()` in `ui/src/model/sprint.ts`, which the Toil projects cards now use too, so the two can't differ. It does not count today.
- **What:** the cards are the biggest risk, stories that can't start, then the oldest code review waiting past `PICKUP_DAYS`; when one is empty, "not ready to start" takes the place, once; with nothing at all, one all-clear card. **Why:** the same three for everyone; no role picker, no keep-or-drop card (its rule was invented) and no person to check in with (people are described, never ranked). One story gets one card: the blocked card is dropped when it would repeat the risk card's story.
- **What:** the "why" sentence is built from the briefing on screen, Analyze's when current, otherwise the code's, and names items by title in quotes. A key is small print after a card's title, never in the headline or the why sentence.
- **What:** the "Customize" button and the "Analyze settings from …" note moved inside the fold. **Why:** the brief put Customize under the one disclosure; the source line, sprint line, Go to links and any briefing problem stay outside it (principle 4).
- **What:** the Summary tab no longer repeats the sprint line ("Sprint 42, day 7 of 10"). **Why:** the header's sprint chip already shows it.

## Ask with training wheels

- **The guided start replaces the starter chips, in the UI only.** The nine questions
  live in `ui/src/guided-questions.ts`; the server's `STARTERS` still back
  `api/agent/starters` and the scripted agent's starters, so the server, `verify:ui` and the
  ticket banner's "is this a starter" check are unchanged. Pressing a question sends its
  text, as typing it would; "Who might need help?" relies on the system prompt's rule that
  the agent never ranks people, and its "Good for" line says so.
- **Analyze lost its Ask bar button** and is the first question. The palette entry and the
  Analyses tab buttons stay; there was no keyboard shortcut to keep.
- **"How sure" uses the dossier's items as its base** (`< 3` is Low), not the items an
  answer cites, since an aggregate answer ("3 of 21 points") cites few. Age is `Data.now`
  against the wall clock; the sample sets `viewedAt` two hours after its fixed `now`, so it
  does not read as ten days old.
- **The no-agent notice is two strings:** `NO_AGENT_NOTICE` (plain) and `NO_AGENT_DETAILS`
  (packages). The server's error keeps the packages in its `fix`.
- **The themed empty-state art is not drawn in the chat's start** (it was the only user of
  the skin `EmptyState` there); the themed placeholder stays.
- **The sample agent** answers five of the nine questions from its existing scripts (finish,
  blocking, review, help, boss), the briefing as Analyze, and says it has no script for the
  other three (changed, waiting, ready) rather than answer a question it wasn't asked.
- **The chat's usage footer is one line** ("about $0.04 of usage"), with the model, token breakdown and estimate caveat behind a fold. Cap notices stay unfolded. **On a phone the chat header is one line**, "Answered by … · Change". The Learn button left the guided start, because the Help menu and the (i) already carry it.
- **Out of scope:** a real Approve button (it needs a server route through toil's write gate) and the "What just happened?" walkthrough.

## Review round 1

Made by default:

- **Plain words never reword a fact.** An item's title, a quoted title, a briefing's own sentences and `r.line` are shown as they come. The words this app writes itself pick plain or standard where the sentence is built (`Ctx.plain` in `ui/src/model/summary.ts`); the sample agent, a stand-in for a model, speaks plain words on its own standard answers, never on a themed voice.
- **A sprint with no points is "No estimates"**, not On track, with a sentence naming how many stories lack points.
- **Failures stay outside the closed fold** (principle 4): one compact line per red reason no card tells (the first reason, plus the blocked and waiting lenses when those cards show), and the "Couldn't check" line.
- **A failed assignment counts on the AI helpers button**, as does a failed proposal. A failed assignment keeps counting while it sits under Earlier; renewing it or removing it clears it.
- **The `agent` swap in plain words** has the same guards as the dossier swap, so package names, paths, `AGENTS.md` and `user-agent` are left alone.
- **How sure** counts code reviews as the base for the review question, says "no items" for zero, and calls its all-clear "every saved read".
- **The answer's heading is not drawn** but stays for a screen reader's headings list (`sr-only`); the chat's own "Answered by" line shows only when the answer's agent differs from the header's; "Nothing was changed" is said under the first answer of a conversation only. One answer's usage is the chat's, so the chat total waits for a second answer.
- **Phone:** the AI helpers button is on the Ask row as "AI" plus its count, still named "AI helpers"; the description and sources are behind a "Details" button beside the name; on a phone the beta banner and "Sample data read …" are one line (the "Nothing here connects…" sentence is dropped there).
- **Edit pencils on a Toil project's card** show on hover or focus only where the pointer can hover (`@media (hover: hover)`); on touch they stay.
- **New (i) topics** `plain-words` and `status` (the status word and How sure). `HelpTopic.plainNote` holds a sentence only plain words show, because the word swap would turn "dossier" in it into "Toil project". `Help` takes a `note` for a sentence that depends on the screen (the limits).
- **The raw `agent:refine` label** is in the Start dialog, which is the inbox item's detail.
- **The homepage screenshot** (`site/public/images/ui-dossier-card-payments-*.webp`) is the old screen and was not retaken: the site skill's `shoot.mjs` is for PR screenshots, not for that image. Its alt text now says so.

Decided by the maintainer on #552, 2026-11-03:

- **How sure** caps at Medium for one unverified item, and at Low for more than one or half of those cited; its reason says so ("It names 1 item its tools never returned."). The all-clear claims only the saved reads.
- **The Summary all-clear** is replaced, sentence and card, by one that names the failed reads (`dossier.calls`) when any read failed.
- **Before you ask** is the phone design at every width: one line and the "What AI can see" button. "Who answers" and "What it costs" are dropped, and "See other Toil projects" is replaced by "Read anything your connections can't already read", since the live tools take free queries.
- **The stale reason** stays on the line with plain words on: "Started before an update: {reason}."
- **The usage line** says "(estimate)", or "(not billed on your plan)" on a plan.
- **The status-word fold** says the 75% line is the app's own rule of thumb.

## Principle gaps for the maintainer

- Whether a hover `title` counts as a disclosure a person chooses, since touch and keyboard users can't reach it. This round moved the Test button's explanation and each question's "Good for" into `title`s.
- Citing a design lab readers can't open, now removed from comments.
- Whether every invented threshold (75%, 10%, 3 items, 24h/72h) must be flagged as a choice in the copy.

## Review round 2 (the Imagile Bot)

- **"How sure" says which reads it vouched for.** A guided question is checked only against the reads it depends on (`needs`), so its all-clear now reads "Every read this answer depends on worked". "Every saved read worked" is kept for a typed question, which is checked against every read. **Where:** `scoped` in `ui/src/model/confidence.ts`, set by `AnswerChecks`.
- **Kept: any blocked card counts as covering the red `blocked` reason** (the Imagile Bot's non-blocking note). When the risk card has taken the head of the blocker chain, the blocked card shows another blocker, and the `blocked` reason's own items show only inside the fold. In that case the risk card already says how many stories wait behind its item, so a separate line repeated it: the sample showed "Blocked 2" beside a risk card saying "2 other stories wait behind it". Counting by items instead of by lens would be the precise fix, and it's more machinery than the edge case is worth.

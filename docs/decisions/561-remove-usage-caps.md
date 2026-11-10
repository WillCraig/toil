# #561: usage caps removed from Toil UI

The maintainer's call (2026-11-09): Usage shows what the agents used and nothing more, with no caps. These are the calls an agent made by default while removing them.

- **Old saved usage settings still load.** A file saved with a `caps` key is read, the key is ignored, and the next save writes the file without it (`ui/server/usage.ts`). Why: nobody should have to clear a cache to open Toil UI.
- **Old records still read.** An assignment that stopped with reason `usage` and a worklog run with outcome `capped` keep their types and their wording, marked as from before caps were removed; nothing produces either any more (`ui/src/assign/model.ts`, `ui/src/model/worklog.ts`).
- **Old addresses land on the Codex rates.** `#/settings/agent/caps` and `#/settings/usage/caps` open `#/settings/usage/rates`, the one thing the caps card held that remains (`ui/src/App.tsx`).
- **The `caps` help topic is gone**, with its Context window and Effort glossary entries, which nothing on the screen names any more; this changes the #418 mapping. A `rates` topic explains the Codex rates.
- **The usage-cap notification is gone**, with the 80% warning.
- **Supersedes `561-setup-guide.md` and `561-ui-plain-copy.md` on caps.** There are no caps; the setup guide's usage is still in the ledger under "(setup guide)", and the caps addresses land as above.
- **The live-run records keep their cap rows**, under one line saying caps were removed later (`ui/docs/live-runs/`). They are dated records of what ran.

## What still bounds an agent run

Caps were the one optional stop on spend. With them gone, a run is bounded by: an
assignment's time limit (default 20 minutes) and at most three at once; Claude's 30
turns; Copilot's 10 minutes a turn; and Stop. Codex in the Ask chat has only Stop,
where someone is watching. No principle says how far a run on a person's own
subscription must be bounded. The principle review raised it and it was put to the
maintainer, whose instruction (2026-11-09) stands: show the usage, add no caps. No
principle was added.

## Review fixes

- A problem reading the saved rates shows in the totals card, always on screen, not
  inside More detail (principles 4 and 11); its message keeps the OS's error code.
- The Codex rates card moved inside **More detail** on Settings, Usage; the rates
  address opens it.
- A bell entry saved with kind `cap` reads as a failure, so old history stays.
- The assign dialog's note is one sentence; "nothing leaves this computer until you
  approve it" stays in the assignments help topic.

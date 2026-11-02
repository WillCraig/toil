# A board card draws one chip per insight code, with a count (#541)

- The grouping is in `InsightChips` (via `groupInsights` in `ui/src/model/insights.ts`), not in `insights()`. The item view, the briefing and Command Center read `insights()` and still list every insight separately; only the board's card, the one place that draws chips, collapses them. No other view uses `InsightChips`.
- The count is the number of insights under the code ("Blocking 2"); a single one reads as before. The chip's tooltip lists each insight's text with cited items shown by title ("Blocking 2: Blocks Alpha; Blocks Beta"), falling back to the id when the item isn't in the dossier.
- `max` and "+N more" count chips, so three codes show three chips however many insights they hold. The chip takes the weight of the first insight in its group; one code always carries one weight.

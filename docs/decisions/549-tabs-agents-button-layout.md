# Dossier tabs: the Agents button moves beside the Ask bar (#549)

- **What:** below 1200px, where the Agents sidebar is a drawer, its button sits beside the Ask bar (wrapping under it on a phone) instead of at the end of the tab row.
- **Why:** at 375px it took a third of the tab row, leaving room for about two tabs; the other five were reachable only by scrolling a 229px strip. The tabs now get the whole row and scroll, with their edge cue, only when they must. Beside Ask costs no extra height at tablet widths; the maintainer chose it over an own row above the tabs.
- **Where:** `ui/src/views/DossierShell.tsx`, `ui/src/views/dossier-shell.css`; the layout check gained `tabs-squeezed` / `tabs-covered` for a `data-tabs-row`.
- **What:** the layout check opens a failing command's audit lines on the Usage page on the sample only. **Why:** a real home can genuinely have no failed command, so verify:ui failed for nothing to open; the sample always has failures, so it still must open some. **Where:** `states()` in `ui/scripts/layout-check.mjs`, which takes `headerFits` as its sample flag.

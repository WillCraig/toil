---
description: Toil UI's eight themes, themed wording and the agent's voice, the checkboxes that set how far a theme goes and whether its particles run, theme moments and toil tips, Plain's fonts, and how the agent's prompt is composed.
lead: How far a Toil UI theme goes, and what it never changes.
---

# Themes

Toil UI has eight built-in themes. Each one changes how the app looks, and the seven game themes can go further: they can change the app's microcopy, and the voice the agent answers in. Two checkboxes decide how far a theme goes. Nothing a theme does changes your data, what a button is called, or what the agent is allowed to do.

## The eight themes

Each one is on [the Toil UI page](https://imagile-dev.github.io/toil/ui/), the real app on sample data, with the prompt and the answer each theme gives side by side.

| Theme | Looks like | Wording and voice | Accessibility bar |
|---|---|---|---|
| Plain | Light and quiet: Fredoka on headings and figures, IBM Plex Sans to read | None: always the standard text | WCAG 2.2 AA, strict |
| Crate | The toil site's look, in its blue: the near-black, or warm drafting paper in light, the drafting grid and the blue glow, the accent-to-highlight gradient, the crate in its hard hat | A terse warehouse dockworker | WCAG 2.2 AA, strict |
| Harvest | A 16-bit farm: a pixel font, wooden sign panels, a sky that runs from dawn to dusk across the sprint | A patient farmhand | Decorative |
| Starship | A bridge console: HUD frames, scanlines, a slow starfield, holo panels | A ship's log | Decorative |
| Realm | A grimdark house ledger kept as a tabletop campaign: soot and iron around aged vellum, leather-bound panels with wax-sealed headings, a dungeon map at the foot of every page, a d20 that rolls while a view loads, an item's fields as a character sheet, the dependency graph as an engraved war-table map | A dungeon master | Decorative |
| Sprawl | A terminal in a rain-soaked megacity: monospace type and a block cursor, faint scanlines and a CRT edge glow, neon magenta and cyan on deep blue-black, or the city at dawn in light, the skyline at the foot of the page, the dependency graph as a net map where a blocker is black ICE | A laconic street-level netrunner | Decorative |
| Frontier | Steampunk on the wild west frontier: brass, copper and riveted iron over sun-bleached desert wood, panels framed in riveted brass, pressure gauges on the tallies, the dependency graph as a railroad survey map | A dry telegraph operator | Decorative |
| Overworld | A top-down 16-bit adventure: an overworld map at the page's edges, panels as dungeon rooms walled in stone, a pixel face for headings only, a heart meter for the sprint's days left and a gem counter for its points, chests that open as work is done, the dependency graph as a dungeon map where a blocker is a locked door | An old sage in a cave | Decorative |

Every theme comes in a light and a dark scheme. Appearance, in Settings, General, under the theme, or from the command palette, chooses one, or System (the default), which follows your operating system's light or dark setting. An address can pick one too, for example `?theme=realm&scheme=dark`. Appearance is kept in this browser only, never in toil's config; the welcome menu uses the same two schemes, picked for your terminal's background.

Crate is the default, here and in the welcome menu a bare `toil` opens. The theme picker is in the header (in the Menu on a narrow screen) and in Settings, General. A `?theme=` in the address opens a view in that theme, for example `?theme=realm`, and this browser remembers it like a choice made in the picker.

The theme is also toil's own setting, `"theme"` in `~/.toil/config.json`, which the welcome menu a bare `toil` opens follows too. A pick in Toil UI writes it with `toil theme set`, and Toil UI opens in the theme it names, so `toil theme set realm` in a terminal changes both. `TOIL_THEME` overrides the file for both. A browser that had a theme saved before the setting existed keeps it until you pick one. If toil can't save a pick, the page shows the theme anyway and says why it wasn't saved. With sample data, the theme is this browser's alone.

## Plain's fonts

Plain uses toil's own type, so it looks like toil without leaving the accessibility baseline.

- **Fredoka**, toil's wordmark face, is Plain's display face: page and panel headings, and the big figures (the sprint's numbers, the team's counts, an item's rank and its days in progress). It's used at 600 only, the weight the wordmark already loads, so no figure is drawn in a faked bold. Plain adds Fredoka's Latin Extended file at that weight, which the browser fetches only when a heading needs it, so a dossier named Łódź keeps one face.
- **IBM Plex Sans** is the body, at 400 and 600. Its open shapes and tall lowercase stay clear at the small sizes the notes and tables use (13 to 14px), it tells `I`, `l` and `1` apart, and its soft curves sit well beside Fredoka's rounded ones. It's already bundled for Crate, so it costs Plain nothing new. Nunito Sans and Inter were the alternatives: Nunito Sans is rounder still but lighter and narrower at small sizes, and Inter reads well but is sharper beside Fredoka; either would be a new font to bundle.
- **Mono** stays the system's monospace, for commands and ids, where the platform's own face is the one people read code in.

Fonts don't change contrast: Plain keeps its colours, and its pages pass the axe and layout checks at 375, 768 and 1440 pixels.

## Visuals, wording and voice

A theme has up to three layers.

- **Visuals** are what every theme has: colours, fonts, borders, art, and motion. They never change a word.
- **Wording** is the theme's own microcopy, from the `lexicon` in its `theme.json`: the lede on the dossier list, the small eyebrow above a page's title, the notes under the dashboard's panels, the empty states, the loading lines, the Ask pane's notes, and the chat's placeholder, welcome and status words (#343). Crate's empty board column reads "Bay empty." and Realm's reads "None stand here." A theme's word for a sprint, a board or an epic is always shown beside the real one, as in Realm's "Campaign (Epic)" or "Ledger (Sprint 42: day 7 of 10)". A theme may also rename the People and Analyses headings, an item's priority, the Builds panel, how a build ended, and the sprint's points done and left: Realm reads them as "Party (People)", "Quest log (Analyses)", "Initiative (Priority)" on an item's fields, "Saving throws (Builds)", "Natural 20 (passed)" or "Critical fail (failed)" beside the build's own state, "Experience points (Done)" on the sprint's tally and "Hit points (Points left)", which takes the place of the sprint's meter. The Settings pages and the Sync panel keep the standard text. With plain words on (the default), the lede, eyebrow, placeholder, welcome and status words read in plain words instead; turn plain words off under Settings, General to see the theme's.
- **Voice** is the register the agent answers in, from the `voice` in the theme's `theme.json`. Crate answers like a terse dockworker, Harvest like a patient farmhand, Starship like a ship's log, Realm like a dungeon master narrating a grim campaign to the party, dramatic but brief with every figure and citation as the data gives it, Frontier like a dry telegraph operator who also keeps the engine running, Sprawl like a netrunner on a job: work items are gigs, the sprint is the run, a pull request is a payload waiting on the fixer, a build is an ICE check, a deployment is jacking in to prod, and a blocker is black ICE, and Overworld like an old sage in a cave: brief, warm and a little cryptic, with the facts kept plain.

Wording never touches these, in any theme:

- the name of a button, a link or a form field, so what you, a script or voice control looks for is always there, and every control's accessible name matches its visible words (WCAG 2.5.3);
- a heading a screen reader or a test finds a section by, apart from the renamed words shown beside the real ones;
- a command such as `toil dossiers init`, an item's id, a number, a date, an error or its fix, or a not-found notice such as an item the dossier doesn't have.

## Rolled alignments

Realm's one playful label on a person. With themed wording on, each card on the People tab carries a "Rolled alignment", such as "Neutral good", picked from the card's name alone, so the same name always rolls the same and nothing from anyone's work goes into it: it can't score or rank anyone. Only good and neutral alignments are on the list, and the (i) beside the cards says what they are. Switch themed wording off and they're gone. A theme lists its own in `theme.json`'s `alignments`, and the theme test refuses one that judges a person.

## Rest days

In Realm, a past day on the worklog's calendar with nothing on its page, or no page at all, is a rest and carries a camp fire in its corner: a small one for a short rest on a weekday, a larger one for a long rest at the weekend. The fires and the line that names them show only while themed wording is on.

## The checkboxes

Settings, General has the theme picker and, under it, these checkboxes:

| Checkbox | Default | Off means |
|---|---|---|
| Themed wording | Off | The standard text in every theme, and no renamed words |
| Themed agent voice | Off | The agent answers in plain wording, whatever the theme |
| Particles and ambient effects | On | The theme's particles are gone: nothing is drawn and nothing runs behind the page |

**Particles and ambient effects** shows only for a theme that has particles, and it's kept for each theme on its own, so particles can be off in Starship and on in Harvest. Under the theme's description, the picker says which particles the theme has and whether they're on.

Plain has no wording or voice of its own, so while Plain is chosen both boxes are off and can't be changed, and the page says why. Both are kept in this browser with the theme, like the motion settings, and never in toil's config. `?wording=off` or `?voice=off` in the address switches one off, and `=on` switches it back on; either is then remembered in this browser like a click on the box.

## How the agent's prompt is put together

Every adapter (Claude, GitHub Copilot and Codex) gets the same system prompt, built in one order:

1. **The rules.** The same in every theme: use only Toil UI's read tools, cite every item as `[[id]]`, write any change as a fenced proposal block for you to apply, keep to plain text, and say plainly when the data doesn't show something.
2. **Style.** The theme's voice, or your custom voice, but only while Themed agent voice is on and the theme has a voice. It ends by saying the rules win: the style changes phrasing only.
3. **Your instructions.** Your general instructions from Settings, Agent, if you wrote any. They end by saying the rules win, and that they can't give the agent a tool or let it change anything.

The page sends the server only the theme's name and whether the voice is on. The voice text comes from the server's own copy of the theme, so a page can choose a voice but can't write one into the prompt. Claude gets the prompt as its system prompt, Copilot as a replacement system message, and Codex, which has no separate system prompt, at the start of the turn. The server's citation check doesn't change: it still flags any id the agent's tools never returned.

This is the whole prompt for a question about card-payments in Crate, with the voice on and one general instruction, "Answer in British English. Lead with risks.":

````text
You are the analyst inside Toil UI, answering a question about the dossier "card-payments": one body of work, its tracker items, pull requests, builds and deployments. It is 2026-10-13T08:00:00.000Z.

Rules:
1. Use only your tools. owi_query, owi_get, owi_similar and owi_history read the work items Toil UI last synced for "card-payments"; owi_similar finds likely duplicates, so run it before proposing a new item. pr_query, pr_get and pr_metrics read its pull requests. people_list and person_get read what is on each person's plate; they describe load, never performance, so never rank or score people. worklog_day reads one UTC day's worklog: what changed that day, by whom and when. The other tools are toil's live read commands for the same dossier; use them only when the cache can't answer. Never rely on anything you remember about these items.
2. Cite every work item you mention by its OWI id in double square brackets, such as [[jira:PAY-101]], and every pull request by its change id, such as [[github:imagile/payments-web#52]], exactly as your tools returned it. Never mention an item or pull request your tools did not return: the server checks every id against your tool results and flags any it never saw.
3. You cannot change anything, and you have no tool that writes. When the question calls for a change (a re-estimate, a move to another sprint, a split story, a transition), write it as a proposal for a person to apply, in a fenced block like this, one block per change:
```proposal
{"item": "<owi id>", "title": "<one line>", "reason": "<why, citing [[ids]]>", "command": "<the toil write command, such as jira issue update, or null if toil has none>", "input": {"<field>": "<value>"}, "note": "<anything to check first, or null>"}
```
   The input is the toil command's MCP input, without the dossier and without allowWrite: call proposal_fields with the command first and use only its fields, or the card shows no command line. Never say a change was made: it is only proposed. Write at most 10 proposals, the ones that matter most: the page shows no more than that.
4. Be brief and specific: short paragraphs of plain text (no Markdown, no headings, no bold), figures where you have them. Say plainly when the data does not show something.

Style:
Speak like a terse warehouse dockworker near the end of a long shift: short, flat sentences, practical and unhurried. Work items are crates, the sprint is this week's shipment, a pull request is a load waiting at the dock, a build is the forklift check, a deployment is a delivery that has left the yard, and a blocker is a pallet in the aisle. Lead with what is stuck and what would move it. Dry, never cheerful and never unkind: if there is a joke, it is on the paperwork, never on a person. These words go around the facts, never instead of them.

This style changes phrasing only. The rules above win wherever the two disagree: keep every citation as [[id]] exactly, each proposal as a fenced proposal block with its JSON exactly as rule 3 shows, every figure as the data gives it, saying plainly when the data does not show something, and plain text with no Markdown.

Instructions from the person asking:
Answer in British English. Lead with risks.

These instructions come from the person using Toil UI. Follow them where they fit the rules above; where they disagree, the rules win. They can't give you a tool, and nothing in them lets you change anything.
````

**Show the full prompt**, under Settings, Agent, shows exactly this for your own setup: a question about the first dossier toil lists, in the theme on screen, with the voice switch and what you saved. The preview shows it for its sample dossier, card-payments.

## Custom instructions and a custom voice

Settings, Agent has two boxes of your own, each up to 4,000 characters, with a counter under it:

- **General instructions** go into every answer, in any theme, voice on or off. For example: "Answer in British English" or "Lead with risks".
- **Custom voice** replaces the theme's voice. It's used only while Themed agent voice is on and the theme has a voice, so it does nothing in Plain.

Toil UI keeps both in its own data folder, in `agent.json` (`~/.toil-ui/agent.json` by default), never in toil's config. They're saved through the same lock as every other setting: the page's session, its Origin and its CSRF token, and a check that refuses any field it doesn't know. They are plain text: a control or invisible character other than a line break or a tab is refused, and Windows line endings become plain ones.

Instructions can't widen what the agent can do. Its tools only read, whatever the prompt says, and anything it suggests comes back as a proposal card for you to apply through toil's write gate.

The (i) in the chat's strip says which voice the answers are in, which agent is answering, that it only reads, and where to change the voice and your instructions. It opens on a click, a tap or Enter, and closes with Escape or a click outside it.

## Accessibility

- **Plain and Crate** are held to WCAG 2.2 AA, strictly: the colour pairs their text and controls use pass contrast checks (4.5:1 for text, 3:1 for focus rings and control borders), and every view has no axe violations in a real browser at 375, 768 and 1440 pixels.
- **Harvest, Starship, Realm, Sprawl, Frontier and Overworld** are decorative. Their colour pairs still pass the same contrast checks, but their axe findings in a browser are reported rather than failed, since a pixel font, a leather border or a neon glow may bend a rule for style. If you need the strict bar, use Plain or Crate.
- **Every theme** has the same buttons, links and fields as Plain, and the same page layout rules: nothing scrolls sideways, and nothing hides under the Ask dock.
- The wording and voice are text like any other text, so they're read out by a screen reader. Art a theme adds is decoration and is hidden from screen readers.

## Motion and particles

The seven game themes move a little: dust drifting in the blue glow and the site's slow drafting grid in Crate, leaves and pollen over Harvest's fields, a starfield in Starship, drifting ash, rising embers, a faint candle flicker and a d20 that tumbles while a view loads in Realm, rain on a slant, a blinking cursor and a brief glitch as a page opens in Sprawl, desert dust on the wind with steam rising from the foot of the page in Frontier, and fairies wandering as motes of light in Overworld, where a chest hops open as a card reaches Done and a key is lifted as one gets under way. Plain doesn't move. No theme plays sound.

Three settings decide what moves, in this order:

1. **Your operating system's reduced-motion setting.** When it asks for less, nothing moves, whatever Toil UI is set to.
2. **Reduce motion and effects**, under Settings, General. Ticked, nothing moves: no animations and no particles.
3. **Particles and ambient effects**, under the theme picker, for each theme that has particles. Off takes that theme's particles away entirely. Everything else, such as transitions and Crate's drifting grid, keeps following the motion setting.

Each theme says which particles it has in its `theme.json`, as `"ambient": { "particles": "dust" }`, so the switch knows what it controls. The two Toil UI choices are kept in this browser only, never in toil's config.

A theme's splash, loading screens and moments follow a fourth setting, **Theme motion** (Theme moments, below), which reads off whenever either of the first two asks for less.

## Theme moments

A theme can also have **moments**: a launch splash, its own loading screens, an entrance when a dossier opens, a transition between a dossier's tabs, and a short moment when something worth marking happens. Crate, Harvest, Starship, Realm, Sprawl, Frontier and Overworld have all of them. Plain has none.

| Moment | When it plays | How long |
|---|---|---|
| Launch splash | Once per launch, while the first read runs, if that read takes longer than 300 ms | Ends as soon as the data is ready, on any key or click, or after 1.8 seconds, when the view's own loading screen carries on. It never adds a wait |
| Loading screen | Every real wait that lasts longer than 300 ms: opening a dossier, reading the dossiers, a running sync, a graph, a worklog page, a stand-up, a settings page, and the chat while Analyze or a question is thinking | As long as the wait |
| Dossier entrance | When a dossier opens | About 0.4 seconds |
| Tab transition | When you move between a dossier's tabs | About 0.25 seconds |
| Event moment | Once, when a sync records one of these for the first time: an item done, a build passed or failed, a blocker cleared, a pull request merged, or a sprint's end | Under a second each, at most three a sync. The sprint's end is a recap card with its figures, which stays five seconds so you can read them |

The splash can't wait for the sprint it's opening, so the browser remembers the sprint each dossier was in the last time its page loaded here. When Toil UI opens on that dossier's page while the sprint is still running, the splash knows the sprint's day, how many of its items were done, and the dossier's name, and a theme can show them: Realm's d20 lands on the sprint's day ("day 7 of 10" is a 7), capped at 20. Opened anywhere else, on sample data, after the sprint has ended, or in a browser that keeps nothing, the splash is as it always is, and the die shows its 20.

A loading screen shows the theme's art, its progress motif, and the real progress in words: what toil is reading and how many of its calls have been answered, or a sync's dossiers, requests and pages. In a game theme, a line of the theme's own flavour text changes every few seconds under it, while **Themed wording** is on. Waits shorter than 300 ms show nothing at all, so a quick read never flashes a loading screen.

An event moment comes from the facts the worklog keeps (**Worklog** in [Toil UI](https://imagile-dev.github.io/toil/docs/ui/)): each sync records what it sees, and a moment plays only for a fact that sync recorded for the first time. A dossier's first sync plays nothing, since everything in its history would be new, and neither does a fact from before the last good sync. The moment says the plain word ("Done", "Build failed") and, while **Themed wording** is on, the theme's word beside it, as in "Signed off (Done)".

You can see every moment of the theme you're in from **Preview the theme's moments**, a menu under **Settings, General**, Theme: the launch splash, a loading screen, and each event moment. With Theme motion off, the splash and the moments are greyed out in it. A preview's progress text is a sample, and says so, and the splash's preview is handed a sample sprint's day, so Realm's die shows a 7.

### Theme motion

**Theme motion**, under Settings, General, Motion and effects, says how much the moments move:

| Setting | What it does |
|---|---|
| Full (the default) | Every moment plays as the theme draws it |
| Subtle | The same moments, shorter and smaller, with the loading screens' art held still and only their progress motif moving |
| Off | Every moment is an instant change: no splash, no entrance, no transition, no event moment. Loading screens are the theme's still art and the progress text |

Theme motion is **off whenever reduced motion is asked for**: your operating system's reduced-motion setting, or **Reduce motion and effects** ticked. That makes off the default for anyone who has reduced motion set, and the page says so beside the setting. It's kept in this browser only, with the other motion settings.

Every moment moves only by `transform` and `opacity`, which the browser composites without repainting the page, and nothing moves while the tab is hidden. A glitch or flicker, such as Sprawl's cold boot tearing into the skyline, flashes no more than three times a second (WCAG 2.3.1), and only on a dark picture.

### Toil tips

Every loading screen carries a **toil tip** under its progress, the way a game's loading screen does: one line about toil or Toil UI, such as pressing M on a board card or what `toil dossiers onboard` sets up, with a **Read more** link to the docs section that says the rest. A tip changes about every six seconds while the wait lasts, and a tip you've seen this session doesn't come round again until you've seen them all.

The theme frames a tip, never words it: Crate's are a "Foreman's note", Harvest's come "From the almanac", Realm's "From the rulebook", Sprawl's are "Word on the street", Frontier's come "Off the wire", Overworld's are "The sage's counsel", and Plain's are a "Tip". The tip itself reads the same in every theme, in plain words, as a notification does. **Toil tips on loading screens**, under Settings, General, turns them off, in this browser.

### Moments and screen readers

- A loading screen keeps its progress in a `role="status"` message, so a screen reader hears what is being read. In the chat, the status line under the answer is the one announced, so its loading line isn't read twice. Flavour lines and art are decoration, hidden from screen readers. A tip is text with a link, and is never announced on its own.
- Event moments are decoration too, hidden from screen readers and from the pointer: no notification announces these changes (notifications are for agents' state changes), so neither does a moment. The facts are in the worklog.
- Crate's moments are held to the same strict WCAG 2.2 AA bar as the rest of Crate: the layout check opens every preview in Crate with axe, and fails on a violation.

### Declaring moments in theme.json

A theme declares its moments under `"moments"` in its `theme.json`, and the one engine in Toil UI plays them: no theme writes a player of its own. **A theme without the block still works**: it gets the plain defaults, a loading screen with the progress text and a tip, and nothing else moves. Each part of the block is optional on its own, so a theme can start with a loader and add the rest later.

Pictures are named by their key in the theme's `assets`, never by a path, so the asset list stays the one record of what the theme ships. Every word is plain text of up to 160 characters, with no markup. The test on `theme.json` refuses anything else.

```json
"assets": {
  "momentSplash": "assets/moments/splash.webp",
  "momentSprout": "assets/moments/sprout-sheet.svg",
  "momentBale": "assets/moments/bale.svg",
  "momentBasket": "assets/moments/basket.svg"
},
"moments": {
  "splash": { "art": { "art": "momentSplash", "width": 480, "height": 320 }, "motif": "fade", "loop": "bob", "line": "Morning on the farm." },
  "loader": {
    "art": { "art": "momentSprout", "width": 64, "height": 64, "frames": 4 },
    "loop": "frames",
    "track": { "art": "momentBale", "size": 20, "count": 5, "motif": "grow" },
    "flavour": ["Watering the rows.", "Counting the hay bales."]
  },
  "tips": { "label": "From the almanac" },
  "entrance": "drop",
  "tabs": "slide",
  "events": {
    "item-done": { "art": "momentBasket", "width": 64, "height": 64, "motif": "pop", "label": "Harvested" }
  },
  "recap": { "label": "Harvest festival" }
}
```

| Key | What it holds | Absent means |
|---|---|---|
| `splash` | `art` (a picture or a sprite sheet, below), `motif` (how it arrives), an optional `loop` (how it moves while the wait lasts, at full only), `line`, the theme's greeting under the name, and an optional `face` (below) | No splash |
| `loader` | `art` and its `loop`; `track`, the progress motif: `count` copies of the asset `art` at `size` pixels, moved by `motif`; and `flavour`, up to 12 lines that change while the wait lasts | The theme's Loading skin, with the progress text and a tip |
| `tips` | `label`, the frame on a tip: "Foreman's note" | "Tip" |
| `entrance` | The motif a dossier arrives with | It simply appears |
| `tabs` | The motif a tab arrives with | It simply appears |
| `events` | One entry per kind: `item-done`, `build-passed`, `build-failed`, `blocker-cleared`, `pr-merged`, `sprint-ended`. Each has `art`, `width`, `height`, `motif`, and `label`, the theme's word, shown beside the plain one | A kind left out plays nothing |
| `recap` | `label`, the heading of the sprint-end recap card | The `sprint-ended` event's label |

A **picture** is `{ "art": "<asset key>", "width": <px>, "height": <px> }`, the size it's drawn at in CSS pixels, from 8 to 640. A **sprite sheet** adds `"frames": <n>`: that many frames side by side in one image, each `width` wide, which the `frames` loop steps through by moving the strip, never by repainting it.

A splash's **face** is a number written on its art, which arrives with it: `{ "value": "sprint-day" | "items-done", "max": <n> }`, the value capped at `max`. The engine puts it in a `.m-face` span over the art, centred, and the theme's `theme.css` places it on its picture's own face. It shows only when the splash has the value; without it the art shows as drawn, so draw the art with the face it should show when there's no data. Whatever the splash knows, it also carries as data attributes on `.splash`, for a theme's stylesheet: `data-sprint-day`, `data-sprint-days`, `data-items-done` and `data-dossier`. They're plain numbers and a name, and a theme can't ask for anything else.

The motifs are the engine's, so every theme moves the same few ways and each one moves only by `transform` and `opacity`:

| Kind | Motifs |
|---|---|
| How something arrives (`splash.motif`, `entrance`, `tabs`, each event's `motif`) | `fade`, `rise`, `drop`, `pop`, `slide`, `stamp`, `sweep`, `grow` |
| A loop while the wait lasts (`splash.loop`, `loader.loop`) | `bob`, `sway`, `roll`, `pulse`, `tumble` (a full turn that settles, as a die rolls), `frames` (a sprite sheet) |
| A loader's progress track (`loader.track.motif`) | `march`, `grow`, `blink` |

A theme's `theme.css` may colour and frame the engine's parts (`.splash`, `.loader`, `.loader__art`, `.loader-tip`, `.moment`), scoped to the theme like the rest of its stylesheet, but adds no animation of its own outside `@media (prefers-reduced-motion: no-preference)`. One element carries one animation: the engine plays an arrival on `.splash__art`, `.moment`, `.moment__art`, the dossier and its tab, and a looping picture loops on the `img` inside its art, so a theme's own animation never goes on any of those, and the tests fail if it does. Moment art lives in the theme's `assets/moments/` folder and counts toward the theme's budget: 64 KB a file and 320 KB for the whole theme. Art is CSS, SVG, sprite sheets and still images only, never video, and nothing is fetched from anywhere but the app itself.

A pull request that adds or changes a theme's moments measures them before it opens: `npm run moments:measure -w ui -- --theme <name>` times the splash, loading screen and recap, and fails on any frame over 20 ms, and `npm run screens:sheet -w ui -- --theme <name>` makes the contact sheets to attach, at 375 and 1440px with Theme motion full, subtle and off. Both are run by hand on a quiet machine, never in CI; [Measuring theme moments](https://imagile-dev.github.io/toil/docs/ui/#measuring-theme-moments) in Toil UI's docs says how.

## Asking for a new theme

Toil UI ships its themes and doesn't install themes from anywhere else. To ask for a new one, send a feature request: from the **Feedback** button in Toil UI's header, from [the feedback page](https://imagile-dev.github.io/toil/about/feedback/), or on the command line with `toil feedback feature`. Say what it should look like, and how it should talk.

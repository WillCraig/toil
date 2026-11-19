# Ticket rules and the flow scheme (#657)

## Flow scheme

- **Risk is tried before defect, so a security bug is Risk.** The built-in `flow`
  scheme's rules run in file order, and the first that matches decides. Its order is
  risk (a `security` or `compliance` label), defect (type Bug), debt by title, then
  debt by the `tech-debt` label. Why: a bug labelled `security` is the work a security
  or compliance review asks about, and filing it under Defect would hide it from the
  Risk share of the work mix. A team that wants it the other way copies the scheme with
  `toil classify scheme init --from flow` and swaps the two rules
  (`src/core/classify/builtin.ts`).
- **The debt title rule is classify's existing substring match.** `{ "title":
  ["Bump", "Upgrade"] }` matches any title containing either word, case-insensitive, so
  "Upgraded the dashboard copy" is Debt too. Why: it uses the vocabulary a team's own
  scheme already has, and a whole-word or start-of-title match would be a new matcher
  for one rule. Dependabot's titles start with "Bump"; Renovate's "Update …" titles
  aren't matched and stay unsure, since "Update" is too common a word in feature titles.
  The rare false hit is one keystroke to overrule in the Classify view.
- **Flow has `signals` off.** toil's built-in signals all mean keep the lights on, and
  flow has no KTLO category, so only its four rules decide and everything else is
  unsure, for a person or an AI agent.

## Ticket rules (standards)

- **A place a record doesn't carry is `skipped`, "not read", and a rule is skipped only
  when none of its places was read.** A rule reads the places in its `in` that the record
  carries and joins them; when it misses with some places unread, its reason names them
  and its `source` says `not read: …`. Why: `bug-repro` reads Azure DevOps' repro steps
  field and the description, and a Jira bug never carries that field, so skipping on any
  unread place would skip every Jira bug. Principle 12 still holds: a miss is only ever
  claimed on text that was read (`src/core/standards/check.ts`).
- **A record with no `body` key never had its description read; `"body": null` is a
  description read and found empty.** OWI writes `body: null` when the tracker sent no
  description, and a hand-made record may leave the key out. Why: that is the one
  difference OWI records already carry. `standards check` keeps the record's `body` as it
  came rather than defaulting it, as `classify`'s `complete()` does
  (`src/standards/commands.ts`).
- **A field is read when its key is in a native record, whatever its value.**
  `fields[<id>]` (Jira, Azure DevOps) or a top-level key (GitHub's `body`), compared
  without regard to case; a key with `null` is read and empty, a key that isn't there is
  not read. The cost, documented in `skills/toil/standards.md`: Azure DevOps leaves an
  empty field out of a work item, so there an empty field reads as not read.
- **`criteria` takes the first source that holds any words.** The toil project's
  `<area>.fields.acceptanceCriteria`, then (Azure DevOps only)
  `Microsoft.VSTS.Common.AcceptanceCriteria`, then the description's section under
  "Acceptance criteria", "Acceptance criterion", "Definition of done" or "Done when", then
  the whole description. When none holds words it is the empty text of the ones read, and
  not read only when none was. Why: a field named but left empty shouldn't hide criteria
  written in the description.
- **An item's `verdict` is the worst of the rules that could be checked, and `null` when
  none could.** A `skipped` result never counts as a pass or a miss; an item whose every
  applicable rule was skipped has a `null` verdict, the same as one no rule applies to, and
  `summary.checked` counts only items with a verdict.
- **`judge` reads `description` unless `in` says otherwise, and is always `skipped`.** The
  plan reserved it without a shape; `in` is its only key so a later AI step can say where
  to look without a format change.
- **A `field` check counts placeholder text as empty.** "TBD", "N/A" and the other lines
  readiness's `realText` drops leave a field empty, with the reason "holds only
  placeholder text". Why: the same reading as Toil UI's description check.
- **`summary.byRule[].types` is the OWI types of the items the rule applied to, sorted.**
  Not the rule's `when.type`: a rule with no `when` still gets a noun for "9 of 23
  stories", and the list is what was there, not what was asked for.
- **`results[].source` is where the text came from (`description, under "Acceptance
  criteria"`, `field customfield_10300 (acceptanceCriteria)`); the standard's name is
  its own field.** Toil UI composes "standard gherkin" from `standard`.
- **Regex safety is a refusal list, not an engine.** A pattern may not hold a
  backreference or repeat (`*`, `+`, `{n,}`, `{n,m}` with m above 1) a group that holds a
  quantifier or an alternation; flags are only `i`, `m`, `s`; at most ten patterns of 200
  characters a rule; a text is cut to 20,000 characters before any pattern runs
  (`BODY_SCAN_LIMIT`). The check errs on refusing: `(ab)+` with no inner quantifier is
  allowed, `(a|b)+` is not (`patternProblem` in `src/core/standards/read.ts`).
- **The other caps.** At most 50 rules a standard; a rule's `name` 120 characters and
  `text` 500, one line each, no credential shape; `description` 300; 1 to 5 places a rule;
  1 to 10 headings of 100 characters; `minWords` 1 to 1,000; `words.min` 1 to 10,000; a
  file 256 KiB. A field place is `field:` then 1 to 100 letters, digits, spaces, `.`,
  `_`, `:`, `/` or `-`.
- **A section ends at the next heading-shaped line.** A Markdown heading, a line that is
  only bold text, or a short "Label:" line with nothing after it. A heading matches with
  `#`, `**` or a trailing colon, and only on a trimmed line of at most 300 characters, so a
  run of spaces can't slow the match. "Expected results are elsewhere" is not a heading.
- **The ADF walk is a loop, and the text port otherwise verbatim.**
  `src/core/standards/text.ts` is Toil UI's `textOf`, `realText`, `wordCount`,
  `normalise` and `acceptanceInBody`, with the ADF reader rewritten over a stack (at most
  50,000 nodes), heading levels clamped to 1 to 6 (the UI's copy throws on a negative
  level), and a raw value cut to 100,000 characters before conversion. Package C can import
  these and delete its copies.
- **A broken or unknown standard stops the check.** `--standard nope` is `NOT_FOUND`, and
  so is a toil project's `standards.use` naming one that can't be read; nothing is checked
  against a partial list. Why: as `classify` does with a scheme, a typo must not quietly
  check against fewer rules.
- **`STANDARDS_NONE` and no fallback.** No toil project and no `--standard`, or a toil
  project with no `standards` key, checks nothing, with a warning naming the command that
  fixes it. The built-ins apply only when named.
- **A standard given twice is checked once**, from the first, with `STANDARDS_DUPLICATE`;
  a repeated item id, likewise, with `STANDARDS_DUPLICATE_ITEM`.
- **`projects standards set --use` replaces the list; it doesn't append.** A different list
  already set is refused without `--replace`; the same list again changes nothing.
  `--clear` (a boolean, unlike classify's per-part `--clear`, since the key has one part)
  removes the key and is refused over MCP by `offMcpWhen`; `--clear --use x` sets just
  `x`. A standard that can't be read yet is still set, with `STANDARD_UNRESOLVED`. It lives
  in its own file, `src/projects/standards-set.ts`, and gets the retired
  `dossiers standards set` path as every `projects` command does.
- **The toil project key reuses classify's text cap and refused keys.** Each ref is at most
  200 characters (`MAX_CLASSIFY_TEXT`), and `standards` refuses `connection`, `host`,
  `fields`, `transitions` and `writes`, with the same message shape as `classify`.
- **One generic catalog.** `src/core/file-catalog.ts` holds what the scheme catalog did,
  parameterised by folder, noun, reader, built-ins, name form, size cap, warning prefix
  and the words of a fix; `createSchemeCatalog` and `createStandardCatalog` wrap it, and
  every scheme message is word for word what it was. The standards catalog exposes no
  `save`: toil never writes a standard. `classify.write` and `classify.replace` now list
  `src/core/file-catalog.ts` too, and a new exception, `standards.read`, records reading
  `~/.toil/standards/` and `.toil/standards/` outside the workspace (`docs/bounds.md`).
- **`standards` is a top-level command group beside `classify`.** `standards.md` joins
  the general skill pages (`GENERAL` in `test/skills.test.ts`), and the pure half is
  exported from `src/core/standards/index.ts` for Toil UI: the types
  (`StandardsCheckResult`, `ItemStandards`, `RuleResult`), `checkStandards`, the presets
  and the text helpers.
- **The `when` matcher moved to `src/core/classify/when.ts`.** `matchWhen` is the
  engine's old `ruleMatch` over a `when` rather than a rule; `readWhen` is the scheme
  reader's `when` block with the file's own text check passed in, so each error still says
  "a scheme never holds one" or "a standard never holds one".

- **Flow also calls an item labelled `bug` or `defect` a Defect.** Why: Jira team-managed projects and GitHub repositories without issue types file bugs as a task or issue with a label, so a type rule alone left the demo's bugs unsure. Where: `src/core/classify/builtin.ts`, rule `defect-label`, after `risk` so a security bug is still Risk.
- **`standards.md` shares the `classify.md` row in `SKILL.md`.** The index had one byte
  left under its 4 KB cap (`test/skill-bundled.test.ts`), so the row became "`classify.md`,
  `standards.md` | Work categories; ticket rules", "Open only the file the task needs"
  became "Open only what you need", and `core.md`'s "certificates and proxies" became
  "certificates, proxies".
- **A bare site page now, for the docs check.** `test/site-docs.test.ts` fails while a
  skill file has no page, so `site/src/pages/docs/standards.astro` renders `standards.md`
  with the `standards` command index, listed in `skill-pages.mjs` and under Use in
  `docs-path.mjs` as "Ticket rules". Package D owns the page's content beyond that.
- **`src/core/standards/`, `src/standards/` and `src/core/file-catalog.ts` are on triage's
  safety-layer list** (`scripts/triage/changes.mjs`), as `src/core/classify/` is: they hold
  a bound's reads and the caps on patterns a checked-in file runs, and
  `test/triage.test.ts` requires every path `docs/bounds.md` names to be flagged.

## Toil UI

- **The page reads ticket rules through one server route, `GET api/standards?toilProject=`.**
  The server runs toil's own `standards check` in-process (read-only, `caller: toil-ui`) over
  the items the cache synced, with the items as `text`, so there is no request body limit
  and no staged file. The answer is kept per Toil project until its `syncedAt` changes; a
  failure is not kept. A Toil project that never synced answers `{ result: null }`, which the
  page shows as "not read yet", never as an empty check. Where: `ui/server/standards.ts`.
- **The sample checks in the page or the sample server with the built-in rules only.**
  `ui/src/fixtures/standards.ts` runs `checkStandards` over the sample's items with the
  presets a sample Toil project names; any other name is a warning, never a guess. Only
  card-payments names rules (`gherkin`, `bug-repro`): sample-team's 84 stories have no
  bodies, so every one would miss and the card would say nothing useful. PAY-101 and PAY-102's
  acceptance criteria (`customfield_10500`) are now written as Given/When/Then, and the other
  Jira items carry the field as `null`, as Jira sends an empty field it was asked for, so
  "read and empty" is what the check sees.
- **A rule row counts toward the verdict like any other row.** A thin rule makes the item
  thin, a failed one blocked, so the Command Center no longer slates an item that misses a
  rule. `skipped` (not read, or needs an AI agent) is a new row state, a dash worded "Not
  checked", which never counts either way and stays out of "why not ready". Until the check
  has been read, a Toil project that names rules shows one "Ticket rules: Not read yet" row.
  A Toil project that names none shows no rule rows at all, so older Toil projects look as
  they did.
- **Rule rows sit under their own "Ticket rules" heading with one (i)**, below the five
  checks, rather than interleaved, so the five fixed checks read as before and the rules are
  one step further in. The row's source reads "<toil's source> (ticket rules: <standard>)":
  the word "standard" stays in toil's names, not in the copy.
- **"Fix with AI agent" is a small button on a thin or failed rule's row only,** on the
  item page, not in the Command Center list, so it is where the fix is decided and never on
  every row. It opens its own short dialog (rule, what toil found, which AI when more than one
  is ready) rather than the general Assign dialog, since the mode is fixed. With no AI agent
  ready, the dialog shows the same "Set up an AI agent" notice and link Ask shows, with the
  adapters' problems folded under "Details for whoever sets it up", and no Fix button.
- **The queue re-checks the rule before it queues.** `AssignRequest.standard` is
  `{ standard, rule }` only; the queue resolves it with `ruleFor` (the server's last check, or
  the sample's) and refuses with 409 when the rule passes, doesn't apply, or was skipped, and
  with 404 where there is no `ruleFor`. A fix must be `refine`. The assignment keeps the rule's
  name, text, toil's reason and toil's source (`Assignment.standard`), so a renewal carries it.
- **The refine-to-rule prompt names where toil read the text.** Besides the rule's name, text
  and toil's reason, it passes toil's source ("criteria (field customfield_10500
  (acceptanceCriteria), description)"), so the one proposal rewrites that field, else the
  description. It asks for exactly one proposal, no estimate or split, invents nothing and
  turns gaps into QUESTION: lines. `modePromptText('refine')` now appends the rule task with
  placeholders (`<rule name>`, `<rule text>`), so refine's prompt fingerprint (#305) moved
  once: refine assignments made before this change will read as stale and can be renewed.
- **The agent's readiness tools carry the same rule rows.** `AgentData.rules()` reads the
  server's check, and `readiness_list`'s settings add `ticketRules` and `ticketRulesRead`
  (`unread`, `read`, `failed`, or null when the Toil project names none).
- **readiness.ts uses toil's body reader.** `textOf`, `realText`, `wordCount`,
  `acceptanceInBody`, `lines`, `normalise` and `ADO_ACCEPTANCE_FIELD` come from
  `src/core/standards/`, and readiness.ts re-exports the ones its tests and callers used. The
  one behaviour change is toil's 20,000-character cap on what is read of a body.
  `NOT_SECTIONS` now matches toil's `TOP_LEVEL` (archived, analyze, classify, standards,
  dimensions, views), so none of those is ever taken for a source.
- **`standards check` joined `INPUT_FILE_COMMANDS`** (`ui/src/proposal.ts`), since
  `ui/test/registry.test.ts` holds that list to every command whose input takes `inputFile`.
- **The flow lens is on the Work mix itself: a "Sort by" menu.** The mix is the pure classify
  engine run on the items in the page (`insights-input.ts`), so another built-in scheme's mix
  is one more run with that scheme, writing nothing. `?lens=<scheme>` in the address picks it;
  `useWorkInsights` reads it from the address, so the drawer behind a segment counts the same
  way. The menu lists the saved scheme first when it is a team's own file, then the three
  built-ins by their category names ("Feature / Defect / Risk / Debt"), the saved one marked
  "(saved)". Under a lens, a person's ledger answers are left out (they name the saved
  scheme's categories), and a note says it is for this view only and the saved categories are
  unchanged. Settings, Classification stays where the saved choice is made.
- **The Command Center's card counts open items, as the tally does,** and lists only rules
  some open item misses or couldn't be checked against; the rest fold into "Every open item
  meets the other N rules." Each line links to `?rule=<standard>/<rule>`, which narrows the
  list (on top of its own filters) and shows "Missing: <rule>" with Show every item.
- **A rule's reason is plain words, and a pattern may carry `labels`.** A `pattern` check takes
  an optional `labels` list, one plain name per `match` ("a Given line"), held to the same
  one-line, length and credential checks as other short text; the presets use them. Reasons
  read "No Given, When or Then line in the acceptance criteria or description.", "Missing a
  Then line in the acceptance criteria.", "Has Given, When and Then lines.", and for a section
  "No "Steps to reproduce" section in the description."; a team's unlabelled pattern still
  quotes its regular expression. Places are named as a person would (the acceptance criteria,
  the description, the title, a field by its alias, else its id). A place not read is left out
  of the sentence when another was read, and stays in `source`. `source` leads with the same
  plain name but keeps the field id in brackets (`acceptance criteria (field
  customfield_10500)`), because the Fix with AI agent flow and its prompt read the field to
  rewrite from it. Why: the regexes and field ids were on screen four times in the demo flow,
  and a product owner reads neither (UX review).
- **The UX review's round (Toil UI).** What changed, and why each:
  - *An assignment's proposal leads with the change.* `ProposalCard` gained an apply form
    (`lead`): the field table, then Apply, then the reason, with the command, the shell toggle
    and the MCP JSON in a closed "Show the command". The "can't be passed safely … --input-file"
    advice is a note inside it, not red, in the apply and tidy forms alike, since a person
    pressing Apply never types the command. It applies to every assignment proposal; Apply
    still runs the stored proposal through the write gate, unchanged.
  - *Field names are plain.* `fieldName` (model/readiness.ts) names the Toil project's
    acceptance criteria field "Acceptance criteria" and a few fields every tracker shares; an
    unknown id still shows as code, with the id on hover where a name is shown.
  - *The fix's head.* "To meet the ticket rule <name>." with no reason (the dialog and the rows
    carry it), led by "Nothing has changed yet. Review the proposal below and apply it." while
    a proposal waits and none was applied, for every mode; times and usage moved under "Run
    details".
  - *"Fix all N" for one standard.* `AssignRequest.standard` takes `rule` or `rules` (one
    standard, up to 12, unique, each held to the name form); the queue keeps the rules the
    item still misses and refuses with 409 only when none is left. `Assignment.standard`
    became `Assignment.rules` (a non-empty list): the field had not shipped. The prompt lists
    each rule's name, text, reason and source; the fingerprint's placeholders cover one rule
    and two, so refine's prompt hash moved once more.
  - *The Command Center groups a standard.* One line a standard, figure in bold; "and" when
    every missing item misses every rule, else "or". `?rule=<standard>` filters to any rule of
    it; `missing`, `ruleName` and `matchesRef` (src/rules.ts) take either form.
  - *The doubled "AI AI agent" in help.* `plainify` swapped "agent" inside "AI agent"; it now
    leaves an agent already preceded by "AI" alone, so it is idempotent and copy can say "AI
    agent" outright. The setup and classify-ask topics had the same doubling.
  - *Work mix "Sort by" became "Categories",* first and set apart from Split by and Measured
    in, options named for their set ("Flow: …", "Balance: …", "KTLO: Keep the lights on /
    Feature": the review's "KTLO / Feature" is kept as the set's short name with its plain
    categories after it), "(your team's)" for the saved one, and a "Back to saved" link.
  - *Rule rows* are a set-in group under "Ticket rules", one block a standard, the source one
    press in under each row's disclosure (principle 4: reachable, never removed), Fix at the
    row's end at desktop widths and full width under it on a phone, one button style.
  - *The ticket-rules help* is the review's wording in two sentences, because help topics are
    held to two (`ui/test/help.test.tsx`), and names the button "Fix with AI agent".
- **The second UX review's findings** (Toil UI):
  - *Proposals first on a refine or a fix.* The Proposals section renders above "Questions for
    you" and "What the agent said" when the mode is refine or the assignment carries rules, so
    the field table and Apply are on the first screen at 1440×900; investigate and implement
    keep the report first, since their proposal follows from it.
  - *Now column.* The diff's "now" was always unknown for a tracker field: `current()`
    (`ui/src/assign/model.ts`) read `item.native.fields`, but `native` is keyed by the command
    that read the item. It now reads each record's `fields`, as the readiness gate does, so a
    field the read returned as null is "empty" and one no read returned is a dash, "not read
    yet". Fixed there rather than in the sample's `ruleFix`, since the diff is built by the
    queue from every runner's proposals; a real run gets the same answer.
  - *One Unsure.* The Work mix's "How it was decided" counted every item the pivot held
    (`total.items` lists every item in the pool, finished or not), while the headline counts
    items finished in the period. `mixDecided` (`model/work-insights.ts`) counts only the items
    the pivot's own throughput measure counts, with the same verdicts, so the two agree under
    any lens and on real data; for Estimate and Days in progress it still counts every item
    the measure holds, since those shares are of points and days.
  - *Plain field name in the acceptance check's reason*; the raw key stays in Source.
  - *A fix's card leaves the proposal's reason out* (`ProposalCard`'s `hideReason`), since the
    agent's paragraph above says it; other assignments keep it.
  - *The proposals lede* names the item's tracker from its synced source, "the tracker" when the
    item isn't in the sync, and the write gate moved into the proposal (i) as its note.
  - *Bar labels* draw only where the 13px text and the thickest edge (a double outline, 4.5 in)
    fit on both sides, so no figure is struck through; the figure stays in the table and drill.
  - *"Missing" on a rule row* is display only (`RULE_WORD`); the row's state stays `thin`.
  - *The notice names the item "Jira PAY-103".* Assignment events carry `itemName`, worked out
    by the queue from the last sync; the notice falls back to the id where the sync doesn't
    hold the item.
  - *"Keep the lights on / Feature (your team's)"*: the "KTLO:" title is dropped, overturning
    the first round's choice to keep it.
  - *The picked AI carries a check mark*, as a menu's chosen item does, on every agent radio
    list (the fix dialog and Assign).
  - *Ticket rules card lines* are "**3 of 27** stories: no Given/When/Then criteria": each
    rule's `missing` phrase, joined with "or" and a repeated leading "no" folded, or "missing"
    and the rule's name where it gives none. The colon removes the verb, so `RuleLine.missAll`
    went. The drill's "Missing: <rule names>" already reads well and is unchanged.
- **The live run's findings** (Toil UI, a real agent on Jira Cloud):
  - *Readable Now and Proposed.* A diff showed Jira Cloud's description as its ADF JSON, since
    `current()` turned any object into JSON. `richText()` (`ui/src/assign/model.ts`) reads ADF,
    Azure DevOps HTML and wiki markup through toil's own `textOf`, with the body's recorded
    format where the record has one, and the page reads a diff stored before the fix (ADF as
    JSON text) the same way, so the live run's saved assignment reads too.
  - *Diff columns.* Field is a fixed 9rem, Now and Proposed share the rest equally, with a fixed
    table layout; at 375 the table stacks as every `DataTable` does.
  - *No "Applied" for a refused write.* The page's status line said "Applied: …" whenever the
    Apply call returned, but a write toil refuses comes back as an assignment whose proposal
    failed, not as an error. The line now comes from the returned proposal (`applyResultText`):
    "Applied" only when it is applied, otherwise "Not applied: … toil refused it; the card below
    says why." The queue's events already said "Apply failed", the Work log's audit match
    counts only `outcome: ok` writes, and the bell never notices a proposal event, so nothing
    else claimed it.
  - *Lists in answers.* An Ask answer's list under a heading line is one part, and drawn as one
    `<p>` its items ran together as " - one - two". `AnswerText` (`ui/src/components/items.tsx`,
    from `blocksOf` in `ui/src/agent.ts`) draws `- ` and `* ` runs as a real list and keeps
    other line breaks, with citations linked in each; used for Ask, the Analyze fallback and an
    assignment's report.
- **Product review, round 3** (Toil UI, for the launch video; principles 4, 11 and 12):
  - *A writes-off refusal in plain words.* The card said toil's raw CLI error in red. A refusal
    whose toil error says writes are off on the connection now reads "Not applied. Writes to
    Jira are off on this computer, so nothing changed. Turn writes on for the jira connection,
    then press Apply again." (the item's tracker and the connection named), still in the
    failure style and in view, with toil's exact words under a closed **Details**
    (`writesOffText`, `ui/src/assign/model.ts`). It is read from the message, not only the
    code, because WRITE_DISABLED also covers a binding the person hasn't adopted, where that
    sentence would be wrong; any other refusal keeps toil's words in view as before. The queue
    now records the error's code on a failed outcome (optional, so older records read). The
    card's status word is "Not applied" rather than "Not applied: toil refused it".
  - *The running page has one live line*, from the run's own transcript (`liveLine`): the last
    tool call and the item it read, "and its parent" only when the cache says so, and the count
    of tool calls. Before the first call it says only that the run started; a tool it doesn't
    know is named as it is. An empty transcript is not shown. The record of what the run
    started on stays a closed disclosure, since it is the run's evidence.
  - *Possible duplicates* are one line each with a **Why?** disclosure, written by Toil UI from
    the scorer's fields (`duplicateWhy`, `ui/src/model/duplicates.ts`), since `src/` is out of
    scope here and the CLI's `summary` is right for the CLI. Seed marks (`toil-seed`, `seed:…`)
    never appear as a reason; the score itself is the scorer's, unchanged.
  - *Cost lines.* With no dollar figure there is no cost line: the answer footer's fold says the
    tokens instead, the "What it looked at" line leaves cost out, and the chat total says
    tokens. A Claude plan's figure reads "Covered by your Claude plan (about $0.12 of usage)",
    the adapter named from the record.
  - *A rule fix cites its own item.* The fix prompt asks the agent to cite `[[id]]` in its
    paragraph, and tells it the proposal's note is plain words for the person applying it,
    nothing about formats or how the text is sent. The citation check is unchanged, so an
    answer that still cites nothing is still flagged. The #305 fingerprint's prompts part
    is built from the prompt text with placeholders, so it moves with these words by itself.
  - *Applied tables* read Before and After, with nothing struck through.
  - *Copy.* The questions end "Answer these in Jira, then ask for a new rewrite." on a refine or a
    fix ("then assign it again" elsewhere); **Mark reviewed** moves below the proposals there;
    the Proposals lede drops "Nothing changes in Jira until you press Apply." while the head
    says "Nothing has changed yet". High confidence reads "All the data this answer needs was
    read, 13 minutes ago, across 134 items." ("All the saved data was read, …" unscoped); the
    lower levels' clauses were already in this form and are unchanged. "(the first one ready)"
    beside **Answered by** is dropped, keeping "your default can't run".
  - *Ready to start?* The plan id moved from the slate's sentence into its hover. The Board
    tab's badge counts the board's items with an insight of weight 2 or more (blocked, blocking,
    a failing build, aging, carried over, a PR with no build, stale, deployed and still open);
    it already had "44 items need attention" for a screen reader and as a hover, and the hover
    now adds which reasons, most first ("16 blocked, 9 stale").
  - *The readiness panel's footer* ("Worked out from the cached record, with no model call."
    and what Check the workflow live reads) moved into the panel's (i); the button stays, and
    after a live read the line beside it still says when and with which command, as the
    result's source.
- **Product review, round 4** (Toil UI, for the launch video: the fix-and-apply loop visibly
  closes; principles 2, 4, 11 and 12):
  - *An applied fix settles the assignment, questions and all.* `settledState`
    (`ui/src/assign/model.ts`) now ends at done once nothing waits and at least one proposal was
    applied, even with questions left: the questions say "Answer these in Jira", so once the
    change is in they are the tracker's conversation, not a step on this page. A run with only
    questions, or whose proposals were all dismissed, still needs you. The queue settles a record
    an older Toil UI saved as needs you on start, so the demo's applied SCRUM-17 reads as done.
    The chip says **Applied** (the done colour) when every proposal was applied, **Done**
    otherwise (`allApplied`). Mark reviewed goes with needs you, since there is nothing left to mark.
  - *The notice and the bell stop counting it.* An assignment event whose state isn't needs you
    removes that assignment's needs-you line from the notices and marks its bell entries
    `settled`, which never count as unread and stay in the list (`ui/src/history.ts`,
    `ui/src/components/notify.tsx`); an older saved history still reads.
  - *The applied card is a record.* Solid border (`proposal--applied`), the agent's pre-apply note
    hidden, and "Applied to Jira SCRUM-17 at 22:39 UTC." (the date too on another day) with
    **Open in Jira** from the item's own `url` when it has one. The server's outcome message is
    unchanged; the page words it from the item.
  - *Sync and check again, not "Check again".* Toil UI has no read of one item that refreshes the
    cache (the agent's `owi_get` reads the cache; the sync is incremental per Toil project), so the
    button syncs the Toil project and says so on itself. The press is remembered outside React
    (`ui/src/assign/recheck.ts`), since the App remounts after a sync, and the rule's result is
    shown only from a reading newer than the press: "now passes", "still missing: <toil's reason>",
    "not checked" or "no longer applies". Where nothing can sync (the preview), it isn't offered,
    since the sample's data never changes and any answer would predate the Apply.
  - *The lede was the wrong way round.* "Nothing changes in Jira until you press Apply." showed
    only when nothing waited. It now shows only part-way (something applied, something still
    waiting); before any Apply the head's "Nothing has changed yet" is the reminder, and once all
    are applied the lede reads "The applied change is in Jira."
  - *A line-level diff.* `lineDiff` (`ui/src/assign/line-diff.ts`), an LCS over lines that ignores
    trailing spaces and CRLF, with no dependency. Kept lines are plain in both columns; removed
    lines are struck in Now (muted, not struck, once applied, keeping round 3's "nothing struck
    through" for the record); added lines are bold with a bar. Each marked line says Removed, Was
    or Added to a screen reader. A field with no earlier text shows the proposal whole, as before.
  - *The header after an Apply.* A tally of changes Toil UI applied (`ui/src/applied.ts`), kept
    outside React and seeded from the assignments the server holds, so a reload still knows; Board
    moves and category changes add to it too. While any is newer than the data, the line reads
    "Data read 22:38 UTC. 1 change applied since." (the date too when the read was on another day)
    with **Sync now** where the app can sync. The audit log wasn't used: the page doesn't read it.
  - *Agent failures say their cause.* Codex threw "Codex failed: …" and the host added "Codex
    failed: " again; the adapter now throws the CLI's own words and the host says the prefix once,
    with one full stop. `agentFailure` (`ui/server/agents/failure.ts`) reads the message for every
    adapter: a usage, rate or quota limit says the plan's limit was reached, when it resets where
    the message says ("at 7:50 PM"), and to try then or pick another AI agent; a sign-in failure
    keeps the sign-in advice; anything else says to ask again and how to see the CLI's own error.
    The notice cuts a long line at a sentence end that keeps at least half, else at a word, with
    an ellipsis (`clip`, `ui/src/notify.ts`).
  - *Polish.* "2 steps so far". While a run works, the record of what it started on and the
    transcript are out of sight (the live line is the focus); they are disclosures once it ends.
    Possible duplicates fold to one line, "4 possible duplicates · Show" (Hide once open), the
    count as the panel's heading. The Blocked card's lede reads "Waiting on another item, done
    already, outside the Toil project, or failing a ticket rule.": a failed ticket rule also
    makes an item blocked, so leaving it out would undercount what the card counts.
  - *A test flake fixed on the way.* The assignment routes test read the next event after
    `since=latest`, which could be the end of the investigate run it had just made; it now waits
    for that run to end first. It failed on the unchanged code too.
- **Product review, round 5** (Toil UI, the last on-camera issues from a live Claude run on
  Jira SCRUM-32; principles 4, 11 and 12):
  - *No false citation alarm on the run's own item.* The assignment's item is handed to the agent
    in its prompt, fenced as data, so naming it is no invention. `finish()` takes `known` ids
    (`ui/server/agents/answer.ts`), which the assign runner sets to the assignment's item, also
    the item a rule fix was checked on; they count as returned for the citation check and for
    "rests on none". Every other id still has to come back from a tool (`ui/test/agents.test.ts`).
  - *Questions only on QUESTION: lines.* The rule-fix prompt now says the paragraph never says
    whether there are questions, and the proposal's note never repeats a QUESTION: line (null
    when there's nothing else to check). The fingerprint picks up the new text with no new
    placeholder, since neither sentence carries a rule's words.
  - *A question shows once.* Before Apply, a note that only asks a question again is left off the
    card (`noteRepeatsQuestion`, `ui/src/assign/model.ts`: half or more of the note's meaningful
    words in one question, as the live paraphrase was); any other note stays whole. Once every
    proposal is applied, the questions card becomes one quiet line per question, "Still to
    confirm with the team: …", with no "ask for a new rewrite". Why a word-overlap rule and not
    exact match: the live note was a paraphrase, and the prompt change is the first line of defence.
  - *Sync and check again answers beside the button.* When every rule passes, the status line next
    to the button reads "✓ <rule> now passes. SCRUM-32 is ready to start.", the second sentence
    from the readiness verdict on that same reading, and otherwise what it is (blocked, or needs
    more detail, with the rows that say why) (`passedText`, `ui/src/assign/recheck.ts`). The sync
    redraws the page at its top, so the result is scrolled into view once per press. A rule still
    missing or not checked keeps its own line.
  - *Copy.* "but the Command Center never slates it" → "but it won't be started automatically."; a
    readiness row read from the cache says "Source: last sync" (the row's source itself changed, in
    `ui/src/model/readiness.ts`, so every place shows it); an assignment started from Toil UI says
    "started by you"; "Too early in the sprint to judge a pace" (and the no-points basis with it)
    is the first line behind **How was this worked out?**, not a line under the headline; the Ask
    prompt's style rule tells the agent to say a gap in the tickets' words ("the tickets don't say
    why"), never in terms of the cache.

- **A rule may name what's missing** (`missing`, a short phrase such as "no Given/When/Then criteria"), so a count reads "3 of 27 stories: no Given/When/Then criteria" instead of building grammar from the rule's name. Where: `src/core/standards/types.ts`, `read.ts`, `builtin.ts`.
- **Flow calls any other story a Feature** (rule `story`, last). Why: on the demo week, without it, 63% of finished work read as unsure, since most stories carry no label; the Flow Framework counts new user-facing work as a feature. Last in order, so a story labelled security, bug or tech-debt keeps that category. Where: `src/core/classify/builtin.ts`.

## Crate's polish and the motion helpers

- **Crate's `line` is its own, no longer the site's.** The dark hairline is `#2a303a`
  (light `#e0dcd3`), quieter than the site's `#3a414d`. `test/brand-sync.test.ts` now
  holds it between the site's surface and the site's line instead of equal to the line.
  Why: the maintainer found Crate too busy; nothing relies on `--line` as a control's
  boundary (buttons and fields are outlined in `--muted`, which keeps 3:1), so cards and
  rules can go quieter without failing WCAG 1.4.11.
- **Crate's dust is off until Motion is set to Full** (`"ambient": { "default": "off" }`,
  read by `src/ambient/Ambient.tsx`). Picking Full already switches a theme's particles on.
- **Nested cards are raised and unoutlined in Crate only** (theme.css), not in the shared
  `views.css`, so the other themes keep their frames.
- **Motion lives in `src/motion.css`, loaded by `src/motion.ts`**, which every entry loads,
  rather than in each of the two entries. Closing a disclosure is instant: there is no
  way to animate a `<details>` closing without script, and leaving is not worth the wait.

## The agent mark and tooltips over expanders

- **One agent mark per theme, drawn as a mask in the text colour** (`agentMark` in each theme.json, `src/components/agent-mark.tsx`). Why: a mask follows the button's own ink on the accent fill and in both schemes, so no theme can ship a mark that vanishes on one fill; the cost is one colour per mark, which suits a 16px glyph. A theme without one borrows Plain's.
- **Which controls carry it:** those that start a run when pressed (Ask in the bar and the pane, Write it up, Fix with AI agent and Ask for a rewrite, Assign to agent and its Assign or Start, the inbox's Start, Run again, Renew and Renew all, Get a briefing, a job's Run and the job menu's items, Improve with your AI agent, Classify's ask, Start N on Tickets, the guided start's questions, the chart's suggested questions, and the setup guide's starters and Ask), plus the AI agents button, as asked. Left without it: links that only open a job's page (Draw its architecture, Draw it again), and the chart menu's Ask about this chart, which opens the pane without asking.
- **Converted to an (i):** the stand-up's two expanders (Write it up and Export, now one row of buttons; Export reveals its folder field on press), Improve with your AI agent's paragraph, and the paragraph under Start on Tickets. **Left as disclosures:** run details, transcripts, evidence, the coverage gaps, What it may ask you to approve on a job page, the Details for whoever sets it up folds (the adapters' install detail for an engineer), and the setup guide's fold on a phone, which holds a whole chat.
- **The stand-up's Dash has no `title`.** It showed the raw word "none" as a hover tooltip, the stray one between the expanders; the words beside every dash already say what it stands for, and a screen reader still hears it.
- **`.control-row`** makes every button and menu in a row 32px to the eye with the 44px hit area, so a row never mixes 44px, 36px and 32px controls. A ticket rule's row aligns on its text's baseline instead, with Fix with AI agent at `btn--sm`.


## Review round: rules as data, unread rules, the regex guard

- **The regex guard refuses repeats that can trade characters**, not only nested ones (the maintainer's choice). Two quantified atoms that vary in length and whose characters may overlap are refused when nothing between them only one could match: a repeat that may match nothing (`\s*`, `x?`) doesn't separate them, so `\w+\s*\w+` is refused (decided: written `\w+\s+\w+` it reads), and nor does a required character an *unbounded* repeat before it can also match, so `.*a.*b` is refused too. That last case goes a step past "adjacent": it measured 11 s on 4,000 a's, the same synchronous freeze, and refusing it costs one line. Bounded repeats (`[^,]{1,80}`) drop out at a required atom, so the built-in user-story pattern still reads (5 ms on adversarial text). Characters are compared coarsely and towards refusing: letters in both cases (the guard never sees the flags), beyond ASCII as two lumps (spaces, so `\s*\S+` reads, and the rest), a negated class complemented before folding, a group as every character in it. Also fixed: `[]` and `[^]` now close at once as JavaScript reads them; the old walker read `[]|)(a+)+b` as one class and let the exponential group through. Where: `src/core/standards/read.ts`, `docs/bounds.md` (`standards.read`), `skills/toil/standards.md`.
- **Every rule is fenced as data in a fix's prompt, not only a repository's.** The assignment (`AssignedRule`, `ui/src/assign/model.ts`) doesn't carry where its standard lived, and threading it through would touch the queue; a rule that describes a ticket loses nothing by being read as a description. The rules sit between `<<<TICKET_RULES` and `TICKET_RULES>>>`, after the task, which names the fence and calls it data; every fence's markers are taken out of rule and item text alike, and a rule that asks for anything but text is an `INJECTION:` line. Where: `ui/server/assign/prompts.ts`.
- **A repository standard that takes a built-in's name is set aside, with a warning**, rather than kept beside it: two standards answering to "gherkin" would need a second name everywhere a rule is addressed (`?rule=gherkin/scenarios`, an assignment's rule), and refusing is one check. The built-in is used and `STANDARD_SHADOWS_BUILTIN` names the file and suggests `team-<name>`. Your own folder may still replace a built-in, as your config replaces a default; a file named by path keeps its own name, since it was named on purpose. Where: `src/core/standards/catalog.ts`.
- **"Rules not read yet" is a fourth verdict, `unread`**, after blocked and thin: an item whose other checks pass while a ticket rule the toil project names wasn't checked on it is neither ready nor slated. It covers rules not read, a failed read, a read with no result for the item (an empty result still means no rule applies), and a rule toil skipped (a field not in the record, a `judge` rule); the last means an item with a `judge` rule is never Ready until an agent reads it, which follows from principle 12. A skipped row now sits in `why`, after the misses. Where: `ui/src/model/readiness.ts`, `ui/server/agents/tools.ts`.
- **The Blocked figure says whether it is exact** (`blockedOpenReading`): a floor while any open item has a Ticket rules row, since a rule could still fail an item. Where: `ui/src/model/readiness.ts`.
- **toil's rule warnings ride on the reading** (`RulesReading.warnings`), in toil's words, as well as on `RulesView`; the readiness tools return them as `ticketRuleWarnings`. Where: `ui/src/rules.ts`, `ui/src/model/readiness.ts`.
- **The server keys its kept check on the sync and the toil project's `standards`**, read with `projects show`, rather than dropping it on a Settings write: the CLI can change `standards` too. A sync of no items answers a check of nothing itself (toil's command refuses an empty input, a guard for a pipe that lost its items), with no standards listed since none ran. Where: `ui/server/standards.ts`.
- **A view transition's update waits one task, not two frames**: Chrome holds `requestAnimationFrame` back inside the update callback, so a drill-in froze for the transition's 4 s timeout (measured 4,040 ms in headless Chrome; 50 ms after, the whole transition about 395 ms). The fallback without View Transitions keeps its two frames. Where: `ui/src/motion.ts`.
- **A due date ends with its day**: overdue and the plan use the end of the due date (UTC, like every date here), and what waits on an item starts when that item's due day ends. Where: `ui/src/model/gantt.ts` (`dueEnd`).
- **Motion gets a fourth level, "Full, no effects", for a theme with particles**, where Crate starts (its particles default off), so the select never says Full while the effects are off and picking Full turns them on. Where: `ui/src/motion.ts` (`motionLevel`, `motionLevels`, `setMotionLevel`), `ui/src/views/settings/Motion.tsx`.

---
description: Ticket rules, called standards, for how a team writes work items, such as acceptance criteria as Given/When/Then, the user-story form, and a bug's steps to reproduce. What a standard is, where standards live, the three built in, checking work items against them, and naming the ones a toil project uses
---

# Ticket rules (standards)

A **standard** is one JSON file holding one set of rules for writing a work item: "a story's
acceptance criteria are Given/When/Then scenarios", "a bug says how to reproduce it". Toil UI
calls them **ticket rules**. `toil standards check` reads work items you pass as Open Work
Item records and says, for each rule that applies to each item, whether it holds. It asks no
service and changes nothing.

No standard applies until a toil project or the call names it: which rules a team's tickets
are held to is the team's call.

## A standard

```json
{
  "name": "gherkin",
  "revision": 1,
  "description": "A story's acceptance criteria are written as Given/When/Then scenarios.",
  "rules": [
    {
      "id": "scenarios",
      "name": "Acceptance criteria as Given/When/Then",
      "text": "State the acceptance criteria as scenarios: a Given line (context), a When line (action), a Then line (outcome).",
      "when": { "type": ["STORY"] },
      "fail": "thin",
      "check": { "kind": "pattern", "in": ["criteria"], "match": ["^\\W*given\\b", "^\\W*when\\b", "^\\W*then\\b"], "flags": "im", "labels": ["a Given line", "a When line", "a Then line"] }
    }
  ]
}
```

- **`name`** is lowercase letters, digits and single hyphens, and in a standards folder it is
  the file's name (`gherkin.json`). `revision` is a whole number (default 1);
  `description` one line of at most 300 characters.
- **`rules`**: 1 to 50. Each has an `id` (unique in the standard), a `name` (a few words a
  screen shows, at most 120 characters) and `text` (one line saying what the rule asks for,
  at most 500 characters, which an AI agent is told when asked to fix an item).
  An optional `missing` (at most 120 characters) names what an item that misses the rule
  lacks, as a short phrase a count leads into (`no Given/When/Then criteria`), for screens
  that summarise misses.
- **`when`** says which items the rule applies to, as a classification scheme's rules do
  (`classify.md`): `type` (the OWI type, `STORY`, or the tracker's own, `Spike`), `label`,
  `parent` (at any depth) and `title` (contains). Every key given must match; a key matches
  when any of its values does. Leave `when` out for a rule that applies to every item; an
  empty `{}` is an error.
- **`fail`** is what a miss makes of the item: `thin` (needs work, the default) or `fail`
  (not ready).
- **`check`** says what to look for, and **`in`** where: 1 to 5 places, their text joined.

| Place | What it reads |
|-------|---------------|
| `title` | The title |
| `description` | The body, as plain lines (ADF, HTML and wiki markup are read the same way) |
| `criteria` | The acceptance criteria: the toil project's `<area>.fields.acceptanceCriteria` field, then Azure DevOps' `Microsoft.VSTS.Common.AcceptanceCriteria`, then the description's "Acceptance criteria" section, then the whole description; the first that holds any words |
| `field:<alias or id>` | One field from the item's source record, by the toil project's alias for it or its own id |

| Kind | Passes when | Takes |
|------|-------------|-------|
| `pattern` | Every regular expression in `match` is found | `match` (1 to 10, each at most 200 characters), `flags` (only `i`, `m` and `s`), `labels` (optional) |
| `section` | One of the `heading`s is there with at least `minWords` real words under it | `heading` (1 to 10), `minWords` (default 1) |
| `field` | The text isn't empty (placeholder text such as TBD or N/A counts as empty) | |
| `words` | The text has at least `min` real words | `min` |
| `judge` | Never: it is reserved for an AI agent's reading, and is always `skipped` | `in` (default `description`) |

A pattern's **`labels`** name each of `match` in plain words, in the same order and as many:
one line each, at most 100 characters, with no credential shape. A reason is built from them
("Missing a Then line in the acceptance criteria.", "No Given, When or Then line in the
description."), so whoever reads it needn't read regular expressions. Without `labels`, a
reason quotes the patterns it didn't find. Labels that share a last word ("a Given line", "a
When line") are said together ("Given, When or Then line").

A pattern may not use a backreference, repeat a group that holds a quantifier or an
alternation (`(a+)+`, `(a|ab)*`), or put two repeats that can match the same characters
side by side (`\s*\s*`, `\d+\d+`, `.*.*`). A repeat that may match nothing doesn't keep two
apart (`\w+\s*\w+` is refused; write `\w+\s+\w+`), and nor does a character an unbounded
repeat before it also matches (`.*a.*b` is refused; write `[^,]*,.*b`). Each of these can
take minutes on text a tracker sent, and matching can't be stopped once it starts. At most
the first 20,000 characters of a text are read. A standard holds no secret, host, connection
or `writes`; text shaped like a credential is refused. When an AI agent is asked to fix an
item, the text of a rule from a repository's standard reaches it as data beside the item,
never as an instruction.

### The built-in standards

| Name | Rules |
|------|-------|
| `gherkin` | `scenarios`: a story's `criteria` hold Given, When and Then lines |
| `user-story` | `story-form`: a story's description holds "As a …, I want …, so that …" |
| `bug-repro` | `steps`, `expected`, `actual`: a bug's repro steps field (`Microsoft.VSTS.TCM.ReproSteps`) or description has a "Steps to reproduce", "Expected" and "Actual" section |

### Where standards live

Looked up by name in this order, the first found winning: your own folder
(`~/.toil/standards/<name>.json`), the repository the folder is in (`.toil/standards/<name>.json`),
then the built-ins. Your own folder may replace a built-in; a repository's file with a built-in's
name (`.toil/standards/gherkin.json`) is set aside for the built-in, with a
`STANDARD_SHADOWS_BUILTIN` warning, so name a team's version something else (`team-gherkin`).
A file can be named instead: on a call, a path ending `.json` inside the
workspace or a standards folder; in a toil project, a path relative to the toil project's file
(`./rules/team.json`). toil only reads standards; write your own file by hand and check it in.

## Commands

| Command | Flags | What it does |
|---------|-------|--------------|
| `toil standards list` | `--cwd` | Every standard visible by name, each from its highest place, with its rules |
| `toil standards check` | `--input-file`, `--text`, `--toil-project`, `--cwd`, `--standard` | Check work items against the toil project's standards, or the ones `--standard` names |
| `toil projects standards set <toil-project>` | `--use`, `--replace`, `--clear` | Name the standards a toil project's work is held to; `--clear` is CLI only |

### `standards check`

```bash
toil jira issue search --jql "project = PAY AND sprint in openSprints()" \
  | toil util owi map \
  | toil standards check --toil-project payments
```

The standards are `--standard` (repeatable, a name or a file), else the toil project's
`standards.use`; with neither, nothing is checked and `STANDARDS_NONE` says so. The toil
project's field aliases apply to `field:<alias>` and to `criteria`.

```json
{
  "toilProject": "payments",
  "standards": [{ "name": "gherkin", "revision": 1, "source": "built-in", "rules": [{ "id": "scenarios", "name": "…", "text": "…", "when": { "type": ["STORY"] }, "fail": "thin", "kind": "pattern" }] }],
  "items": [{
    "id": "corp-jira:PAY-302", "key": "PAY-302", "area": "jira", "title": "Show refunds on the statement", "url": "…",
    "verdict": "thin",
    "results": [{ "standard": "gherkin", "rule": "scenarios", "name": "…", "state": "thin", "reason": "No Given, When or Then line in the description.", "source": "description" }]
  }],
  "summary": { "items": 5, "checked": 3, "byRule": [{ "standard": "gherkin", "rule": "scenarios", "name": "…", "types": ["STORY"], "applies": 2, "pass": 1, "thin": 1, "fail": 0, "skipped": 0 }] }
}
```

- **`state`** is `pass`, `thin` or `fail` (the rule's `fail`), or `skipped`. A rule is
  skipped when none of its places is in the record read ("not read"): a field the read never
  asked for says nothing about the ticket, so it is never taken for an empty one. A record
  with no `body` key never had its description read; `"body": null` is a description read and
  found empty. Azure DevOps leaves an empty field out of a work item, so on Azure DevOps an
  empty field reads as not read. A rule with some places read and some not is checked on what
  was read: its reason speaks only of what was read, and `source` names what wasn't. `judge`
  rules are always skipped.
- **`reason`** says why, in plain words, naming places as a person would: "the acceptance
  criteria", "the description", "the title", or a field by the toil project's alias for it,
  else its id.
- **`source`** says where the text was read from, in the same plain words, with where a
  place really lives in brackets so a fix knows what to rewrite: `acceptance criteria (field
  customfield_10500)`, `acceptance criteria (in the description)`, `description`, `risk (field
  customfield_10777)`, or `field <id>` for a field with no alias. Places are comma-separated,
  then `; not read: ` and what wasn't; or `not read: …` alone when nothing was.
- **`verdict`** is the worst state of the item's rules that could be checked, or `null` when
  no rule applies or every one that does was skipped.
- **`summary.byRule`** counts, per rule, the items it applied to (`applies`) by state, and
  `types` lists those items' types.

### `projects standards set`

```bash
toil projects standards set payments --use gherkin --use user-story --use bug-repro
toil projects standards set payments --use ./rules/team.json --use gherkin --replace
```

It writes the toil project's `standards` key, `{ "use": [...] }`: at most 20 standards, each
once, each a name or a path relative to the toil project ending `.json`. A different list
already there is refused unless `--replace`, which replaces it whole. A standard that can't be
read yet is set anyway, with a `STANDARD_UNRESOLVED` warning. `--clear` removes the key and is
CLI only. The key holds no connection, host or `writes`.

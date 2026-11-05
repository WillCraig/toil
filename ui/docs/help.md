---
description: How Toil UI explains itself and points to its settings, the (i) with its Read more link, the learning links and the pencil beside a configurable value, and the rule every view follows.
lead: Explanations on request, and a way to where each thing is set.
---

# Help and edit links

Toil UI keeps each page to what you need to act. What a term means, and where a value comes from, is one press away instead of a paragraph on the page, and anything you can configure has a link to where it's set.

## The (i) and Read more

An **(i)** sits beside a term or at the end of a view's first line. Hovering or focusing it shows one or two sentences in a tooltip. Pressing it, with a click, a tap, Enter or Space, opens the same sentences in a small popover with a **Read more** link to the section of these docs that says the rest. The link is in the popover rather than the tooltip because a tooltip closes as soon as focus or the pointer leaves the (i), so a link inside one could never be reached by keyboard or touch. Escape closes either.

**Help** in the header is a menu: the docs section for the view you're on, then **What's new**. After an upgrade Help carries a dot (on a narrow screen, so does the Menu that holds it), and What's new lists what changed in toil and Toil UI since this browser last looked, a few lines a version with a link to each full changelog. The lines come from the release notes when Toil UI is built, so nothing is fetched to show them. A first visit shows no dot, and opening the list takes it away.

## Learning links

Toil UI's users are often new to agents, so where a screen uses an AI term, its (i) popover also gives the term's first sentence from Context Overflow's glossary, an AI-fluency course, with **Read more on Context Overflow** to the rest:

| Where | Terms |
|---|---|
| Settings, Agent usage, and its caps | token, input tokens, output tokens, cache tokens, context window, effort |
| Settings, Agent | model, model provider, harness, MCP, tool call |
| The Assign dialog's modes | sandbox, permission mode, human-in-the-loop, human review |
| Renew all stale | session, system prompt, skill |
| The chat's About these answers | hallucination, primary source, non-determinism |

With those links on, **Help** also has **Learn**, four of Context Overflow's modules by task (new to agents, deciding how much to hand an agent, and branches and pull requests for Implement mode).

**Links to learning content**, under Settings, General, is on by default and kept in this browser. Off, every link to Context Overflow and every glossary line is gone, and Help keeps the view's docs and What's new, for an organization that blocks outside sites.

Read more, Help, Learn and What's new's changelog links are the only links out of the app. Each opens in a new tab only when you follow it, and nothing is fetched, prefetched or previewed before that. The definitions are copied into Toil UI's source by hand; no build step fetches them either.

## Edit links

A **pencil** beside a configurable value opens the settings page where it's set, at that value:

| Beside | Opens |
|---|---|
| A connection's name, such as an item's source | Settings, Connections, at that connection |
| A Toil project's sources, on its card and in its top row | Settings, Toil projects, at the form that links an area, for that Toil project |
| The work-in-progress limit and the people, in the People view | Settings, Toil projects, at that form |
| The fields, on an item's page | Settings, Toil projects, at the form that names a field |
| The adapter, on an assignment's page | Settings, Agent |
| A cap notice under an answer, and an assignment's limits | Settings, Agent usage, at the caps |

The pencil only navigates: it never changes anything, and the page it opens makes every change through its own form. Its name says what it edits ("Edit the corp-jira connection"), and it's the same size and in the same place in every theme. When the value it names is gone, a connection since removed say, the page says so.

## Empty panels

Every empty panel offers the one action that fills it, under one short line: no pipeline linked is a pencil to Toil project setup at the Toil project's sources, no repository is **Add a repository**, a panel only a newer read can fill is **Sync now** (in the local app; the preview, which can't sync, offers Toil project setup instead), no analysis yet is **Analyze now**, and a filter that hides everything is **Show every item**. Any explanation is in the (i) beside the action.

## The rule for new views

- **A configurable value gets an edit link where it's shown**, to the exact settings section that sets it, through the helpers in `ui/src/format.ts` (`connectionEditHref`, `toilProjectEditHref`, `AGENT_SETTINGS_HREF`, `CAPS_HREF`) and the `EditLink` component. A new kind of setting adds its helper there, and its page lands on it with `useLandOn`.
- **An empty panel goes through `Empty`** (`ui/src/components/empty.tsx`), whose `action` is required: one short line, the action that fills it, and an optional (i). `ui/test/empty-states.test.tsx` fails on a view that draws the theme's empty state any other way, and on an empty panel, rendered for an empty Toil project, with no link or button but an (i).
- **A view keeps only its first line of explanation on the page.** The rest goes in a help topic, shown with `Help`. Text a person needs to act stays: what a form will do before it runs, a warning, an error and its fix.
- **A help topic is defined once**, in `ui/src/help.ts`: a title, one or two sentences, and the docs page and heading it links to. `ui/test/help.test.tsx` resolves every link to a heading in the docs, and the site's build checks each against the pages it built, so renaming a heading means updating its topic in the same change.
- **An AI term gets a glossary entry on the topic whose screen uses it**: the term, its slug and its first sentence, copied from Context Overflow's glossary. The test holds each slug to a pinned copy of the glossary's term list (`ui/test/glossary-terms.ts`), and each term to one topic.

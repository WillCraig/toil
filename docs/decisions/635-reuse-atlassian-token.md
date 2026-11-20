# Offer Jira Cloud's API token to Confluence Cloud on the same site (#635)

- **The offer is declared on the area, as data.** `defineArea({ shares: { offer: { when,
  sameHost, match } } })` says when `connections add` and `login` offer to borrow, and the
  registry hands the same object to a form as `borrows` on the pairing field
  (`apiTokenFrom`). Confluence declares `when: { deployment: 'cloud' }`, `sameHost: true`,
  `match: ['email']`. Plain data rather than a function, so Toil UI can judge it from the
  registry without a second copy of the rule. Where: `src/core/area.ts`,
  `src/areas/confluence/area.ts`, `src/api.ts`.
- **When it's offered.** Both connections are Cloud, both base URLs are on one host, and the
  Jira connection's token actually resolves (toil resolves the lender before asking, so a yes
  never points at a connection that can't sign in). The default Jira connection is offered
  first, then the rest by name; only one is offered per secret. The lender must be in the
  config file with its token as a store reference: a pairing written to the file must not
  point at a connection made of this shell's env vars, which the next shell may not have. A
  connection whose own token comes from env isn't offered the pairing at `login`, since the
  env token would still win. With two Jira connections on one site under different emails,
  the first is offered even if the email typed matches the second (the question then warns
  and defaults to no); choosing by email would mean holding every candidate until the email
  is answered, which waits for someone who has that setup. Checking that the lender's token
  resolves reads it from the OS store, on `add --set` too; on a locked keyring that can show
  the store's unlock prompt during an agent's call, as resolving the new connection already
  could. On Data Center it is never
  offered: Jira and Confluence are separate servers with separate personal access tokens.
  Where: `src/connections/borrow.ts`.
- **The question.** `Use the apiToken from corp-jira (jira) instead of entering one? y/n`, id
  `borrow:apiToken`, defaulting to `y`. It names the key rather than a friendlier phrase, so
  the same code serves any area that declares an offer. The email is asked before it,
  defaulting to Jira's. If the person types a different email, the question says the token
  won't sign in with it and defaults to `n`; a yes is still theirs to give (the Jira email
  might be the wrong one), so it isn't refused.
- **A yes writes `apiTokenFrom` and stores nothing.** On `login`, a yes also removes the
  connection's own token from config and deletes it from the store once nothing refers to it,
  so the file names one source for the token, the one the person chose. Declining the offer
  and entering a token of its own removes a pairing set before, for the same reason. A pairing
  nobody was asked about (set by hand on Data Center, where nothing is offered) is left as it
  was, as are Kibana's `apiKeyFrom` and every other area without an offer.
- **A lender that would work but whose token doesn't read is said, not skipped.** The
  `SECRET_REUSE_UNAVAILABLE` warning names it and `toil connections test <jira>`, on `add`,
  `login` and `add --set`, so a person asked for a token they already hold learns why.
- **Where an offer exists, `apiTokenFrom` is no longer asked as a plain setting** when the
  offer applies; with no offer (Data Center, another site) it is still asked as before. Toil
  UI's add form stops showing `apiTokenFrom` as a text box at all: the radio buttons are the
  way to choose it, and on Data Center there is nothing sensible to type there. Someone who
  really wants a Data Center pairing can still set it in the file or by env.
- **The agent path stays refused, and says more.** `connections add --set apiTokenFrom=…`
  is still `INVALID_INPUT` (principle 2: an agent never moves a secret). When the reuse
  applies, `SECRET_NEEDED` names the Jira connection and `toil connections login <name>`,
  and `data.secretReusable` (`{ "apiToken": "corp-jira" }`, `{}` when none, `null` when the config could not be read back to look) carries it as a
  field, additive output.
- **`connections list` adds `deployment`** (`server` or `cloud`) for areas whose variants are
  keyed on `deployment`. Toil UI needs it to tell a Data Center Confluence on the same host as
  a Data Center Jira (`https://atlassian.imagile.dev/jira` and `/confluence`) from a Cloud
  pair; it isn't a secret, and other variant keys (`db`'s `engine`) are left out to keep the
  change to what's needed. Additive output.
- **Toil UI's choice.** "Which API token?": "A token of its own" or "Reuse <jira>'s token"
  (with "Needs the same email as <jira>."), on the add form and the
  Update login form, only where `borrowChoices()` (`src/core/connection-form.ts`) finds a
  lender: same area as `borrows.area`, same host, `deployment` matching, and a token present.
  The add form starts on Jira's token (as the CLI defaults to yes); the login form starts on
  the connection's own token when it has one. Both forms always answer `borrow:<key>` for
  every secret, `n` unless reuse was chosen, so toil's question never goes unanswered where
  the page judged differently (an unanswered question would cancel the call). If the page
  offered it but toil doesn't (the Jira token doesn't read), nothing is saved and the error
  and `SECRET_REUSE_UNAVAILABLE` name the Jira connection and `toil connections test`.
- **The reverse direction (Jira borrowing from Confluence) is not built.** `shares` names one
  other area, and the pair would be an import cycle (`confluence/area.ts` already imports
  `jira/area.ts` to name it), so Jira can't declare `shares` from Confluence without moving
  both areas' declarations around. It also isn't needed for one token: the skill tells agents
  to set up Jira first, and when Confluence already holds the token, the person enters it for
  Jira and runs `toil connections login <confluence>` to switch Confluence to Jira's, leaving
  one token to rotate. Where: `skills/toil/jira.md`, `skills/toil/setup.md`.
- **The skill.** `confluence.md` (Credential), `jira.md` (Credential), `core.md` (the
  `--set` paragraph) and `setup.md` (step 4) tell an agent to raise the reuse with the person,
  never to set `apiTokenFrom` itself, and that Data Center needs a token per server.
- **The maintainer's call on #635, 2026-11-16, on the principle review's three questions:**
  reuse stays the default answer (`y` on the CLI, "Reuse <jira>'s token" chosen in Toil UI's
  add form), since the person still answers or presses Save; `apiTokenFrom` stays out of Toil
  UI's add form even where nothing is offered, since a Data Center pairing never works; and
  principle 2 keeps its wording, with one factual sentence on `shares.offer` added to
  CLAUDE.md's cross-area credentials paragraph. These were the agent's recommendations, and
  are kept as the maintainer's decisions.

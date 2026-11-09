---
description: Standing instructions for an agent asked to set toil up for a person - install, ask about Toil UI, create their connections from non-secret settings, hand every secret to the person, then a toil project and a first read
---

# Setting toil up for a person

Run this page when the person says "set up toil for me". You create their connections
and toil project with their approval. **They enter every secret, never you.** Do the steps
in order, and say what you are about to do before each one that changes anything.

## The rules this page keeps

- A secret is a token, password or API key. You never ask for one, read one, type
  one, put one in a command, a file or this chat, or move one between places.
- If the person pastes a secret into the chat anyway, tell them not to, don't use or
  repeat it, and send them to the step that enters it themselves. Suggest they revoke
  it, because it is now in a transcript.
- Create a connection only after the person says yes to its name, area and URL.
- `writes` stays off. You never turn it on; the person does (step 7).

## 0. Is toil installed?

Run `toil version`. If it prints no envelope, follow `install.md`. Then check that
this skill is installed (you are reading it, so it is) and, if the person wants it
for other projects or agents, `toil skill install --allow-write` (`install.md`).

## 1. Ask about Toil UI first

Ask this before anything else, and let the person choose:

> Do you want Toil UI? It is a local web dashboard on your toil projects, and its Settings
> page is where you can type your credentials instead of in a terminal.

Everything after this follows the answer. Toil UI is optional, and toil works the same
without it.

## 2. If they want Toil UI

Start it with `npx @imagile-dev/toil-ui`. If you can run a command in the background,
do; otherwise ask the person to run it in their terminal. It prints one plain
`http://127.0.0.1:<port>/` URL with no token in it. The person opens it and the
browser is let in by a cookie, with no step for them; tell them that anything on the
machine running as them can also reach Toil UI. Point them at its first-run checklist on the
Toil projects page (Connect a tracker, Create a toil project, Sync). Secrets are entered there,
in Settings, Connections. If they say no, stay on the CLI: secrets go in with `toil
connections login <name>` in their own terminal.

If you have no terminal the person can see, say which steps they will do themselves.

## 3. Find what they work on

1. Read the current repository's remotes: `git remote -v`. With a folder of
   repositories, `toil repos scan` lists them.
2. Map each remote host to an area:

   | Host | Area | Connection settings |
   |------|------|---------------------|
   | `github.com` | `github` | `baseUrl=https://api.github.com` |
   | a GitHub Enterprise Server host | `github` | its API root: `github.md` |
   | `dev.azure.com/<org>`, `<org>.visualstudio.com` | `ado` | `deployment=cloud`, `baseUrl=https://dev.azure.com/<org>` |
   | an Azure DevOps Server host | `ado` | `baseUrl` of the server root: `ado.md` |
   | `bitbucket.org` | `bitbucket` | `deployment=cloud`: `bitbucket.md` |
   | `<site>.atlassian.net` | `jira` and `confluence` | `deployment=cloud`, `baseUrl=https://<site>.atlassian.net`, `email=<their Atlassian email>` |
   | a Jira or Confluence Data Center host | `jira`, `confluence` | `baseUrl` of the server root |

   Other hosts, and any other tool the person names, have their own page:
   `<area>.md`. Run `toil connections list` first, and skip what is already connected.
3. Propose the connections to the person as a list (name, area, URL) and get their yes.
   Ask for anything you cannot read off a remote, such as the Jira site.
4. For databases, ask which tool they use (DBeaver, SQL Server Management Studio, Azure
   Data Studio, pgAdmin, DataGrip, MySQL Workbench, a `pg_service.conf` or
   `tnsnames.ora`). Run `toil connections import --from <tool>` to preview what it
   finds, show them the list, and on their yes run the `saveWith` line it returns. It
   copies no password: hand over each one as section 4 says (`core.md`, **Importing
   database connections**).

## 4. Create each connection, then hand over its secret

Use the person's approved names and non-secret settings only. Repeat `--set` for each:

```bash
toil connections add github --area github --set baseUrl=https://api.github.com
toil connections add imagile-jira --area jira --set baseUrl=https://jira.imagile.dev
```

For Atlassian Cloud, also set `deployment=cloud`, `email=<their account email>` and the
`<site>.atlassian.net` URL, as the table says. It asks nothing, stores no secret and leaves writes off. A secret key in `--set` is
refused. A setting the person has to look up goes in the same way: Alation's `userId` is
shown nowhere on its screens, only as the number in the address of their profile page
(`102` in `…/user/102/`), so ask them to open their profile and read it off the address bar. The result lists the secrets this connection cannot work without. A secret the area
treats as optional, such as a database password, is not listed: if the connection fails to sign in, it needs one.

Then hand it over, in the person's terminal or in Toil UI:

- Terminal: "Run `toil connections login github` in your own terminal and paste the
  token at its hidden prompt."
- Toil UI: "Open Settings, Connections, `github`, and enter the token in its password
  field."

Name the credential and give it the least access that works, read-only to begin with:
`github.md` (a fine-grained token on the repositories they use), `ado.md` (a token
with Work Items, Code and Build read), `jira.md` and `confluence.md` (a Data Center
personal access token, or an Atlassian API token for Cloud), and the page of any other
area. Do not wait on the secret in the same turn; ask the person to tell you when
it is done.

## 5. Verify

When they say it is done, run `toil connections test <name>`. A failure names the fix:
an `AUTH` error or a missing secret means they should run `toil connections login
<name>` again or re-enter it in Toil UI; a database that rejects the sign-in needs its password the same way. Report the result, never a secret.

## 6. Make a toil project

A toil project maps one body of work to their connections. In a repository that already has
one, `toil projects onboard --plan` shows what is missing and adds no connection. For a
new one, ask the person its name, then follow `projects.md`, **Create**:
`toil projects init <name> --description "<what it is>"`, `toil projects add-repo
<name> <folder>`, and `toil projects link <name> <area> --host <host> --set key=value`.
With Toil UI, they press Sync on the toil project when it is ready.

## 7. A first read, then report

Run one read per connected area, small and read-only, for example
`toil github pr list --limit 5` or `toil jira issue search --limit 5`, using the
toil project's context. Report what each returned, what is connected, and what is left.

Tell the person that every connection is read-only. If they ever want a write, they
turn it on themselves with `toil connections writes <name> on`, which asks them to
type the connection's name, and every write call still needs `--allow-write`. Don't turn
it on for them, and make only writes they ask for.

## 8. MCP, if they want it

Only if the person asks to use toil as an MCP server, follow `mcp.md`. It registers
`toil mcp --areas <list>` with their agent, and needs no secret from you.

# Confluence: create a space (#21)

- **`confluence space create <key> --name --description` is one command for both
  deployments.** Data Center sends `POST /rest/api/space` with the description as
  `description.plain`; Cloud sends `POST /wiki/api/v2/spaces` with it as
  `{ value, representation: "plain" }`, the API the area already uses for spaces. Each
  returns its own API's space, so Cloud's answer carries `id` and `homepageId`, which a
  seed needs to put pages under the homepage Confluence makes. It's additive: the
  contract records no `space create`, and the command shape allows new commands.
- **The key is the positional argument**, as on `space get <key>`: it's the id the
  space is known by. The name and description are flags.
- **Only global spaces, and only a plain-text description.** Personal spaces, space
  templates and permissions are left out until someone needs them; each is one more
  flag, not a reshape.
- **A key is letters and digits only, 1 to 255, checked before any request**
  (`INVALID_INPUT`), defined once in `src/areas/confluence/space-key.ts`. That's
  Cloud's rule. Data Center may also take non-ASCII letters, and refusing them is the
  safe side of the difference. Whether Confluence keeps a key's letter case as typed
  hasn't been checked: both live runs used upper-case keys (`KW`, `OD`).
- **It's a write, on MCP like `page create`.** Creating a space isn't a delete, so the
  usual gate (`writes` on the connection and `--allow-write`) is what stands in the way.
- **Run live on Confluence Cloud on 16 November 2026**, creating the demo spaces `KW` and
  `OD` through `ui/scripts/demo-confluence/seed.mjs`: the answer carried `id`, `key` and
  `homepageId` as the fixture has them. Data Center hasn't been run; its fixture is
  shaped from the Server REST API's documentation and says so.

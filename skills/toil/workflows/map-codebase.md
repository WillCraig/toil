---
job: map-codebase
description: Map a repository without reading every file, model it as a C4 diagram, draw it, and keep the map so the next question reads the map instead of the code. Use for "map this codebase", "draw its architecture" or "onboard me to this repository".
role: any
needs: {"optional": ["git", "dynatrace", "openshift", "artifactory", "confluence"]}
inputs: [{"name": "repository", "toilProject": true}, {"name": "map file", "toilProject": false}, {"name": "placement", "toilProject": false}]
writes: ["confluence page update", "confluence page attach"]
loop: none
verification: unit
---

# Map a codebase

Rules every page shares: `workflows/README.md`. The result is a map of a repository, a
C4 diagram built from it, and a file that keeps both. The map is built from
what commands return, never from reading every file. Onboarding someone is this page,
then `toil projects brief` and how to run the repository's gate; it needs no page of its own.

## Steps

The repository is the workspace: run from it, or pass `--workspace <repo>` before the
command. Every file toil reads or writes, the model and the diagrams included, has to be
inside the workspace.

1. **Map.** Gather facts, each remembered with the file and line or the command it
   came from.

   ```bash
   toil util size . --depth 2 --top 20
   toil util size <source-folder> --top 20
   toil util size <one-of-the-largest-source-files>
   toil util deps scan
   toil git log --count 200 --since "3 months ago"
   toil projects show
   toil util openapi list <spec-file>
   ```

   - **Tree and sizes.** `util size .` shows the folders. Its largest files will often be
     generated bundles, lockfiles and images; leave those, and any vendored or
     generated folder, in `notMapped`. Run `util size` again on the source folders (the
     manifests from `deps scan` and the tree say which) to find the largest source files,
     then read the outline (functions, classes, line ranges) of those one at a time,
     and only the parts you need.
   - **Entry points and packages.** `deps scan` returns `manifests` (each with its
     `file`, `ecosystem` and `lockFile`): read those for entry points and which
     packages live where. Its `packages` list can run to thousands, so select from it
     rather than reading it (`--select "manifests[].file"`).
   - **Edges.** A code file's outline lists its imports (`util size <file> --select
     outline.imports`; each is `{ specifier, kind, line }`, as written and never
     resolved). Scan the entry, index and largest files first, and a whole module's files
     only where its edges matter; an edge beyond the files you scanned is inferred. Then
     fold each specifier into a module yourself: a relative specifier
     (`../core/x.js`) resolves against the importing file's folder and lands in the
     module whose path holds it; a package specifier names a package. For C# and .NET,
     the `.csproj` `ProjectReference` lines are the module edges and `using` imports
     confirm them. A module's dependents are the other modules with an edge into it.
     For a language with no outline, use manifests and folders.
   - **What changes.** `git log` lists commits and no files, so a hot spot read from the
     scope in each commit message is inferred, and commits without a scope are counted
     as unscoped. If `--since` returns nothing, widen the window or drop it.
   - **Around the repository.** `toil projects show` failing with `INVALID_INPUT` "No toil project applies" is
     normal: note that none applies and move on. Run `util openapi list` only for
     specs the tree has.
   - **Recorded reasoning.** Read the repository's ADRs and decision files
     (`docs/adr/`, `docs/decisions/`), and link each to the modules it names.

   Group modules by their real boundaries: packages, manifests, top-level folders.
   Don't group by guess.

2. **Model.** Build or refresh a C4 model (context, containers, and components where
   they are clear) from the map and the toil project. Add runtime facts only where they are
   connected:

   ```bash
   toil dynatrace service list
   toil openshift deployment list
   toil artifactory build list
   ```

   The model's format is in `util.md`, **toil util c4**. A map module and its model
   element share one id. Every element and every relationship is either **observed**
   (read from source or a command; put the file and line or the command in its
   `description`) or **inferred** (your reading; begin the `description` with
   `(inferred)` and the reason). The model has no field for observed or inferred yet, so the `(inferred)` prefix is
   how the diagram shows it. A relationship that ends on a components view's boundary
   element is not drawn in that view (`C4_RELATIONSHIP_NOT_DRAWN`); point it at a
   component inside to show it there. Find the **hubs**: the modules most others
   depend on, and the ones most often changed together, so a reader knows where
   everything flows and where to start.

3. **Draw and place.** One view at a time.

   ```bash
   toil util c4 render <model.json> --view containers --out <new-file>.svg
   toil util c4 mermaid <model.json> --view context --select text
   toil util c4 d2 <model.json> --view components
   ```

   `render --out` never overwrites a file, so a refresh needs a new name, and the
   file has to be inside the workspace. `mermaid` with `--select text` returns the
   Mermaid text itself as `data`. Propose where the map goes and write it only on the
   person's yes: a folder of the repository (`docs/`, where Mermaid draws inline on
   GitHub), or a Confluence page. If the repository shouldn't hold it, keep the model
   and diagrams in another folder and pass that as `--workspace` for the `c4`
   commands. For Confluence, Data Center takes
   `toil confluence page update <id> --body-file <file> --markdown --allow-write`;
   Cloud takes storage format, from `toil util md <file> --to storage`, saved and sent as
   `--body-file`. Attach the SVG with `toil confluence page attach <id> --file <svg> --allow-write`.

4. **Keep the map.** Write one JSON file at a path the person picks, inside the
   repository or the workspace they chose (propose `docs/map/map.json`, with the
   model beside it), with the agent's own file tools:

   ```json
   { "schemaVersion": 1, "toilVersion": "<toil version>", "commit": "<repository sha mapped>",
     "modules": [{ "id": "core", "path": "src/core", "how": "observed", "source": "package.json" }],
     "edges": [{ "from": "cli", "to": "core", "how": "inferred", "reason": "folder naming" }],
     "hubs": [{ "id": "core", "dependents": 12, "changedWith": ["cli"],
                "changedWithHow": "inferred", "changedWithReason": "commit scopes" }],
     "decisions": [{ "file": "docs/decisions/12-x.md", "modules": ["core"] }],
     "notMapped": ["dist/", "vendored/"], "c4": { "model": "docs/map/model.json" } }
   ```

   - Module ids are the model's element ids, and `edges`, `hubs` and `decisions` use
     only those ids. `changedWith` holds module ids and nothing else; when it was read
     from commit scopes, say so in `changedWithHow` and `changedWithReason`.
     `decisions[].modules` may be empty.
   - `<toil version>` is `toil version`. `commit` is the **repository's** head at the
     mapping, from `toil git log --count 1` (not the commit `toil version` prints, which
     is toil's own build).
   - A module's `path` is one path, or an array when the module spans several, and
     `how` with its `source` or `reason` follows the observed or inferred rule above. An
     external system has no `path`.

   **Refresh.** A later run reads the file instead of the code, then updates only what
   changed:

   1. List the changed files with your own git: `git diff --name-only <commit> HEAD`
      (toil's `git diff` shows only staged or working changes).
   2. Map each path to its module by path prefix (the longest prefix wins); a path no module holds is new
      (add a module) or belongs in `notMapped`.
   3. Re-scan imports only for changed source files, update those modules' edges, and
      recompute the hubs.
   4. Render the diagrams again under new names, since `--out` never overwrites, and,
      on the person's yes, replace the committed files and record the new `commit`.

   Without git, there is no changed-file list: re-map from step 1.

   Answer questions from the file rather than the code. `--select` works on a toil
   command's output, not on a file, so query the file with your own tools.

## Done when

The person has the diagram or has chosen where it goes, the map file is written where
they said, and the report says what was not mapped.

## Report

1. The map in a few lines: modules, hubs, entry points.
2. How much of it is observed and how much inferred, and the commit it describes.
3. What wasn't mapped: generated code, vendored folders, languages `util size` has no
   outline for.
4. Three questions worth asking next, each answerable from the map.

## Never

- Read every file, or present an inference as observed.
- Overwrite a diagram or the person's file without asking, or write to Confluence
  without a yes.
- Parse with anything but toil's commands and your own reading: no new dependency.
- Map folders you were not pointed at, or send repository contents anywhere.

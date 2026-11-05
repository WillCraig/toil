# Changelog

## [0.1.0-beta.4](https://github.com/imagile-dev/toil/compare/toil-ui-v0.1.0-beta.3...toil-ui-v0.1.0-beta.4) (2026-11-05)


### ⚠ BREAKING CHANGES

* contractVersion is 3. The MCP tools dossiers_* and <area>_check_dossier are now projects_* and <area>_check_toil_project, the input dossier is toilProject, and the resources toil://dossiers* are toil://projects*; the old names are gone, so update agent configs and allowed-tools lists. In envelopes, meta.context.dossier is meta.context.toilProject, the source value "dossier" is "toil-project", projects list returns toilProjects and projects show returns toilProject, and warning codes DOSSIER_* are TOIL_PROJECT_*. Still working for one beta, with a warning: `toil dossiers` and `<area> check-dossier` (use `toil projects` and `<area> check-toil-project`), --dossier (use --toil-project), TOIL_DOSSIER and TOIL_DOSSIER_PATHS (use TOIL_PROJECT and TOIL_PROJECT_PATHS), the dossierPaths config key (now projectPaths, config version 4; run `toil connections migrate`), and the dossiers/ folders (run `toil projects migrate` for ~/.toil/dossiers, and `git mv .toil/dossiers .toil/projects` in a repository). See skills/toil/upgrading.md.

### Features

* rename dossier to toil project across the CLI, MCP, config, env, UI and docs ([#559](https://github.com/imagile-dev/toil/issues/559)) ([f9368d6](https://github.com/imagile-dev/toil/commit/f9368d6dbd1b923b50e36a9ca98ce139c72e6107))
* **ui:** offer the workflow jobs (Review, Ship, Diagram) where they apply ([#558](https://github.com/imagile-dev/toil/issues/558)) ([1f47622](https://github.com/imagile-dev/toil/commit/1f476229b24554c7a725d871a5afa7120e1dadf5))
* **ui:** read every repository and project a dossier names ([#544](https://github.com/imagile-dev/toil/issues/544)) ([f9c7bab](https://github.com/imagile-dev/toil/commit/f9c7babd81dc3da38d2f4b7b07d63478f9f3a6a2))
* **ui:** Toil UI for people new to AI: plain words, quieter screens, guided Ask ([#553](https://github.com/imagile-dev/toil/issues/553)) ([89022f5](https://github.com/imagile-dev/toil/commit/89022f5841464b9d6e99b61806c2a062a5962128))


### Bug Fixes

* **ui:** AI helper setup first, calm first run, stale notice, inline citations, Ask row ([#556](https://github.com/imagile-dev/toil/issues/556)) ([#557](https://github.com/imagile-dev/toil/issues/557)) ([19606dc](https://github.com/imagile-dev/toil/commit/19606dc6db9b43431ff7815566b7c56a4ab3f524))
* **ui:** give the dossier tabs the whole row on a phone, with Agents beside Ask ([#549](https://github.com/imagile-dev/toil/issues/549)) ([5a73395](https://github.com/imagile-dev/toil/commit/5a73395b11a030cbe5e94c0a607e08462ad9e5e0))
* **ui:** give the long-chat test a 30 s timeout so slow Windows runners pass ([#554](https://github.com/imagile-dev/toil/issues/554)) ([bb7fd5e](https://github.com/imagile-dev/toil/commit/bb7fd5e4d409471a33218e69847a6e46b6dc0af3))
* **ui:** one chip per insight code on a board card, with a count ([#545](https://github.com/imagile-dev/toil/issues/545)) ([f934f23](https://github.com/imagile-dev/toil/commit/f934f23338c215a32676213becb954a76b8f97d5))
* **ui:** scope theme decoration to the app's own elements ([#550](https://github.com/imagile-dev/toil/issues/550)) ([4fe197f](https://github.com/imagile-dev/toil/commit/4fe197f49ab490ffd67d57def75033c85e39070a))
* **ui:** start the chat on an agent that can answer, and remember the one picked ([#547](https://github.com/imagile-dev/toil/issues/547)) ([d5fad57](https://github.com/imagile-dev/toil/commit/d5fad57a21e6bf743786af9bb39a48622b10cdc0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @imagile-dev/toil bumped from 0.1.0-beta.3 to 0.1.0-beta.4

## [0.1.0-beta.3](https://github.com/imagile-dev/toil/compare/toil-ui-v0.1.0-beta.2...toil-ui-v0.1.0-beta.3) (2026-10-29)


### ⚠ BREAKING CHANGES

* the ado-cloud area is gone, with no deprecation period. The contract version is 2 for this release, the same bump the Jira fold makes. Migrate as follows:
    - Config: a version 1 or 2 file loads as it is; a connection with "area":
      "ado-cloud" is read as "area": "ado", "deployment": "cloud", and
      defaults.ado-cloud folds into defaults.ado (ado's default connection wins,
      with a warning naming the one dropped; defaults.ado's shared keys are written
      onto existing Server connections instead of reaching Services ones). Commands
      that save config write version 3. Keychain entries are untouched.
    - Commands: `toil ado-cloud ...` is `toil ado ...` (use --connection, or make the
      Services connection the default). The old path fails with INVALID_INPUT naming
      the new form.
    - MCP: ado_cloud_* tools are ado_*, and `toil mcp --areas ado-cloud` is
      `--areas ado`.
    - Env vars: TOIL_ADO_CLOUD_* is refused with CONFIG_INVALID; set TOIL_ADO_*
      with TOIL_ADO_DEPLOYMENT=cloud (or TOIL_CONN_<NAME>_* with
      TOIL_CONN_<NAME>_AREA=ado and TOIL_CONN_<NAME>_DEPLOYMENT=cloud). In an Azure
      Pipelines step, set TOIL_ADO_DEPLOYMENT: cloud beside TOIL_ADO_PAT and
      TOIL_ADO_BASE_URL. SYSTEM_ACCESSTOKEN is read for a Server default only.
    - Dossiers: rename an ado-cloud section to ado (transition pins are
      ado.transitions). It is read as ado with a warning until you do, and ado wins
      when both exist.
    - Warning codes: ADO_CLOUD_WORK_ITEMS_MISSING, ADO_CLOUD_TYPE_UNKNOWN and
      ADO_CLOUD_DEFAULT_TEAM are ADO_WORK_ITEMS_MISSING, ADO_TYPE_UNKNOWN and
      ADO_DEFAULT_TEAM.
    - Flags: ado pr list takes --creator <id> and --reviewer <id> (the value was
      always an identity id).
* the bitbucket-cloud area is gone, with no deprecation period. Migrate as follows:
    - Config: a version 1 or 2 file loads as it is; a connection with "area":
      "bitbucket-cloud" is read as "area": "bitbucket", "deployment": "cloud", and
      defaults.bitbucket-cloud folds into defaults.bitbucket (bitbucket's default
      connection wins, with a warning naming the one dropped). Commands that save
      config write version 3. Keychain entries are untouched.
    - Commands: `toil bitbucket-cloud ...` is `toil bitbucket ...` (use
      --connection, or make the Cloud connection the default). The old path fails
      with INVALID_INPUT naming the new form. `pr request-changes` is an alias of
      `pr needs-work`.
    - MCP: bitbucket_cloud_* tools are bitbucket_* (bitbucket_cloud_pr_request_changes
      is bitbucket_pr_needs_work), and `toil mcp --areas bitbucket-cloud` is
      `--areas bitbucket`.
    - Env vars: TOIL_BITBUCKET_CLOUD_* is refused with CONFIG_INVALID; set
      TOIL_BITBUCKET_* with TOIL_BITBUCKET_DEPLOYMENT=cloud (or TOIL_CONN_<NAME>_*
      with TOIL_CONN_<NAME>_AREA=bitbucket and TOIL_CONN_<NAME>_DEPLOYMENT=cloud).
      A Bitbucket Pipelines step also needs TOIL_BITBUCKET_DEPLOYMENT=cloud.
    - Dossiers: rename a bitbucket-cloud section to bitbucket. It is read as
      bitbucket with a warning until you do, and bitbucket wins when both exist.
    - Flags: Cloud's --reviewers placeholder is <users>, and repo create's
      --project is the shared project input.
* the confluence-cloud area is gone, with no deprecation period. Migrate as follows.
    - Config: a connection with "area": "confluence-cloud" is read as "area":
      "confluence", "deployment": "cloud", and defaults.confluence-cloud folds into
      defaults.confluence. Any toil connections change writes the file back with the
      new form. Keychain entries are untouched.
    - Commands and tools: toil confluence-cloud ... is toil confluence ...,
      confluence_cloud_* tools are confluence_*, and --areas confluence-cloud is
      --areas confluence. The old forms fail with INVALID_INPUT naming the new one.
    - Env vars: TOIL_CONFLUENCE_CLOUD_* is refused with CONFIG_INVALID. Use
      TOIL_CONFLUENCE_* with TOIL_CONFLUENCE_DEPLOYMENT=cloud, or TOIL_CONN_<NAME>_*
      with TOIL_CONN_<NAME>_AREA=confluence and TOIL_CONN_<NAME>_DEPLOYMENT=cloud.
      TOIL_CONFLUENCE_* values on a default connection that is Cloud are refused
      unless TOIL_CONFLUENCE_DEPLOYMENT is set.
    - Dossiers: a confluence-cloud section is read as confluence, with a
      DOSSIER_RENAMED_AREA warning. A dossier has one confluence section.
* the jira-cloud area is gone, with no deprecation period, and the contract version is 2. Migrate as follows:
    - Config: a version 2 file loads as it is; a connection with "area":
      "jira-cloud" is read as "area": "jira", "deployment": "cloud", and
      defaults.jira-cloud folds into defaults.jira (jira's default connection wins,
      with a warning naming the one dropped). Commands that save config write
      version 3. Keychain entries are untouched.
    - Commands: `toil jira-cloud …` is `toil jira …` (use --connection, or make the
      Cloud connection the default). The old path fails with INVALID_INPUT naming the
      new form.
    - MCP: jira_cloud_* tools are jira_*, and `toil mcp --areas jira-cloud` is
      `--areas jira`.
    - Env vars: TOIL_JIRA_CLOUD_* is refused with CONFIG_INVALID; set TOIL_JIRA_*
      with TOIL_JIRA_DEPLOYMENT=cloud (or TOIL_CONN_<NAME>_* with
      TOIL_CONN_<NAME>_AREA=jira and TOIL_CONN_<NAME>_DEPLOYMENT=cloud).
    - Dossiers: rename a jira-cloud section to jira. It is read as jira with a
      warning until you do, and jira wins when both exist.
    - jira issue schema takes --deployment cloud for the Cloud input file shape.

### Features

* ado work-item feed, and Toil UI reads Azure DevOps histories from it ([#511](https://github.com/imagile-dev/toil/issues/511)) ([35e90b9](https://github.com/imagile-dev/toil/commit/35e90b9d50c55e4970bbe41dd30dd27e5ebe10d5))
* agent-led setup: the skill walks an agent through toil and Toil UI, and the person enters every secret ([#518](https://github.com/imagile-dev/toil/issues/518)) ([e757af7](https://github.com/imagile-dev/toil/commit/e757af75638a50c29481a9612237c6ac21bc9fc3))
* brief a dossier by code, and tune and serve its Analyze prompt ([#497](https://github.com/imagile-dev/toil/issues/497)) ([63c0820](https://github.com/imagile-dev/toil/commit/63c0820f9764dcd5819ba89f6b3e03222501bcc0))
* every theme has a light and a dark scheme, in Toil UI and the welcome menu ([#512](https://github.com/imagile-dev/toil/issues/512)) ([f72141c](https://github.com/imagile-dev/toil/commit/f72141c565cc6ca21a6c8db988d2f21d99902f12))
* fold ado-cloud into ado: one surface for Server and Services ([40b4e2c](https://github.com/imagile-dev/toil/commit/40b4e2c03b1a212952e45e06de09f69f545ee3e1))
* fold bitbucket-cloud into bitbucket: one surface for Data Center and Cloud ([#504](https://github.com/imagile-dev/toil/issues/504)) ([5a102c1](https://github.com/imagile-dev/toil/commit/5a102c1bc4e12ebc22adfa076c85039be6a8290d))
* fold confluence-cloud into confluence: one surface for Data Center and Cloud ([#501](https://github.com/imagile-dev/toil/issues/501)) ([95846f8](https://github.com/imagile-dev/toil/commit/95846f8641d5987129c24051f07e6704fad722d3))
* fold jira-cloud into jira: one surface for Data Center and Cloud ([#499](https://github.com/imagile-dev/toil/issues/499)) ([877e9a1](https://github.com/imagile-dev/toil/commit/877e9a11716ddde6b9f266b4724a6a37405a3297))
* jira issue search --changelog, and Toil UI reads Jira histories from the search ([#509](https://github.com/imagile-dev/toil/issues/509)) ([7b7fb22](https://github.com/imagile-dev/toil/commit/7b7fb2246d46351abf4e118e6adb49c6d4350bf1))
* **ui:** a briefing written by Analyze, with an item drawer, Analyze settings and Customize ([#500](https://github.com/imagile-dev/toil/issues/500)) ([9b37a91](https://github.com/imagile-dev/toil/commit/9b37a9131617abb06c0c7d14d763bd65dcad171b))
* **ui:** Analyze remembers the agent picked for each dossier, falling back to your default agent ([#514](https://github.com/imagile-dev/toil/issues/514)) ([7145a29](https://github.com/imagile-dev/toil/commit/7145a29539b5f105e4a70d6a3f2ad280df570dca))
* **ui:** keep the session across a reload with sessionStorage ([#517](https://github.com/imagile-dev/toil/issues/517)) ([b066092](https://github.com/imagile-dev/toil/commit/b066092279895d657a1aa60215b6940eb362eda4))


### Bug Fixes

* **ui:** decide Services from the dossier's connection, not from the items loaded ([40b4e2c](https://github.com/imagile-dev/toil/commit/40b4e2c03b1a212952e45e06de09f69f545ee3e1))
* **ui:** propose board moves on Cloud items with the Cloud area's own transition command ([#496](https://github.com/imagile-dev/toil/issues/496)) ([8652258](https://github.com/imagile-dev/toil/commit/865225839d21051f8c80cabb6dd8ae6c3bebb4af)), closes [#495](https://github.com/imagile-dev/toil/issues/495)


### Performance Improvements

* **ui:** sync a bounded window, write only what changed, pool per-item calls, notice deletions ([#503](https://github.com/imagile-dev/toil/issues/503)) ([907edad](https://github.com/imagile-dev/toil/commit/907edad881dbc5a007c3bef7c82bb866ea0024d1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @imagile-dev/toil bumped from 0.1.0-beta.2 to 0.1.0-beta.3

## [0.1.0-beta.2](https://github.com/imagile-dev/toil/compare/toil-ui-v0.1.0-beta.1...toil-ui-v0.1.0-beta.2) (2026-10-26)


### Features

* **ui:** sync Jira Cloud dossiers, and let triage change Toil UI ([#488](https://github.com/imagile-dev/toil/issues/488)) ([b245d0e](https://github.com/imagile-dev/toil/commit/b245d0ec6640a84e771732cb4f9ccdb47462c6df))


### Bug Fixes

* **ui:** preserve USER for Claude CLI authentication ([#491](https://github.com/imagile-dev/toil/issues/491)) ([b6f44cc](https://github.com/imagile-dev/toil/commit/b6f44ccba9dea0fb8d060789f57d8dda02ea4d4a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @imagile-dev/toil bumped from 0.1.0-beta.1 to 0.1.0-beta.2

## [0.1.0-beta.1](https://github.com/imagile-dev/toil/compare/toil-ui-v0.1.0-alpha.3...toil-ui-v0.1.0-beta.1) (2026-10-24)


### Features

* Crate in the site's blue, in Toil UI, the welcome menu and the site's screenshot ([#475](https://github.com/imagile-dev/toil/issues/475)) ([9c5be91](https://github.com/imagile-dev/toil/commit/9c5be917c1339dd32a6f3080d44ffa31b82738b5))
* Crate is the default theme everywhere, CLI included ([#470](https://github.com/imagile-dev/toil/issues/470)) ([db54367](https://github.com/imagile-dev/toil/commit/db543677011f1736916d1b8794bda6b96f0c56b3))
* move toil and Toil UI to beta, with a stable interface from 0.1.0-beta.1 ([#481](https://github.com/imagile-dev/toil/issues/481)) ([abe6958](https://github.com/imagile-dev/toil/commit/abe6958a4c3f956831d0e58f39ca879e0344cce7))
* one theme setting for the welcome menu and Toil UI ([#461](https://github.com/imagile-dev/toil/issues/461)) ([46ac45f](https://github.com/imagile-dev/toil/commit/46ac45fe23e42f7a969362b0b991a589b6dd9f25))
* **site:** a full blue reskin in Toil UI Plain's palette ([#448](https://github.com/imagile-dev/toil/issues/448)) ([ad773d5](https://github.com/imagile-dev/toil/commit/ad773d5e7f8a63f31d3e5f363c59ed7fbdd54210))
* **ui:** a blocker Gantt on the sprint timeline, with the critical chain ([#403](https://github.com/imagile-dev/toil/issues/403)) ([875520c](https://github.com/imagile-dev/toil/commit/875520cabbaf0a13175bad69c6ac63ca5265053b))
* **ui:** a guided first run, a command palette, and search across dossiers ([#426](https://github.com/imagile-dev/toil/issues/426)) ([ca491b6](https://github.com/imagile-dev/toil/commit/ca491b65268151f55a7a1583ee2bf6e9db10e6c2))
* **ui:** a history of analyses, and answers that read top-down ([#407](https://github.com/imagile-dev/toil/issues/407)) ([58e62c5](https://github.com/imagile-dev/toil/commit/58e62c5df1be1a51202088a32609957a7856e939))
* **ui:** add hidden Powershell Man arcade to UI and site ([#477](https://github.com/imagile-dev/toil/issues/477)) ([0fdc0c3](https://github.com/imagile-dev/toil/commit/0fdc0c38577d5e841a0a953595f3aeaac616ac70))
* **ui:** Context Overflow glossary links in the (i)s, and Learn in Help, the chat and the CLI menu ([#424](https://github.com/imagile-dev/toil/issues/424)) ([e294fbc](https://github.com/imagile-dev/toil/commit/e294fbc60927452fccfa42fb7cd98947b743915f))
* **ui:** Crate looks like the toil site, without the pallets ([#399](https://github.com/imagile-dev/toil/issues/399)) ([672f11f](https://github.com/imagile-dev/toil/commit/672f11fe85e3aad8123702a82fc58e5f50ab996b)), closes [#397](https://github.com/imagile-dev/toil/issues/397)
* **ui:** dossier page in tabs, with an Agents sidebar and a Minto overview ([#402](https://github.com/imagile-dev/toil/issues/402)) ([3ebb235](https://github.com/imagile-dev/toil/commit/3ebb235dc52073dec1d055959fe03f0ad7e4e4da))
* **ui:** Frontier, a steampunk theme with a wild west flair ([#423](https://github.com/imagile-dev/toil/issues/423)) ([f966e50](https://github.com/imagile-dev/toil/commit/f966e50a458fc181404a44a140e13679929180f9))
* **ui:** give the launch splash data, so Realm's d20 lands on the sprint's day ([#465](https://github.com/imagile-dev/toil/issues/465)) ([cf430e3](https://github.com/imagile-dev/toil/commit/cf430e348bd9b80b5da8a7ec56d23beca2f07296))
* **ui:** moments:measure and screens:sheet, the theme-moments frame timings and contact sheets as repo tools ([#466](https://github.com/imagile-dev/toil/issues/466)) ([e975b3b](https://github.com/imagile-dev/toil/commit/e975b3b74f930132526c30477cb223fa872ddf25))
* **ui:** Overworld, a top-down 16-bit adventure theme ([#429](https://github.com/imagile-dev/toil/issues/429)) ([12155a3](https://github.com/imagile-dev/toil/commit/12155a3ac035c25487dd19364bf0d389d2498b85))
* **ui:** Realm leans into tabletop dungeon crawling ([#428](https://github.com/imagile-dev/toil/issues/428)) ([5b3273d](https://github.com/imagile-dev/toil/commit/5b3273df6367eb34b429de6101d522bd564a73ab))
* **ui:** Sprawl, a cyberpunk theme on terminal bones ([#422](https://github.com/imagile-dev/toil/issues/422)) ([ccec44e](https://github.com/imagile-dev/toil/commit/ccec44e6fcb1700c6d7278c627e7f00adcff5abc))
* **ui:** theme moments for Frontier: a train pulling into the depot, a pressure-gauge loader, PAID stamps and a blown boiler ([#456](https://github.com/imagile-dev/toil/issues/456)) ([10f3b41](https://github.com/imagile-dev/toil/commit/10f3b41c25caa2c8553a1bc452ceb741b670d923))
* **ui:** theme moments for Overworld: a pixel title card, a map-scroll loader, and chest, brazier, door and key moments ([#458](https://github.com/imagile-dev/toil/issues/458)) ([3bb1b74](https://github.com/imagile-dev/toil/commit/3bb1b743081517d618fe0085ed0c74f531fca03a))
* **ui:** theme moments for Realm: a d20 thrown into a dice tray, natural 20 and critical fail, and a session recap ([#455](https://github.com/imagile-dev/toil/issues/455)) ([27ba05f](https://github.com/imagile-dev/toil/commit/27ba05fca61fc85fa76ce57d3ae984e9c54c087b)), closes [#440](https://github.com/imagile-dev/toil/issues/440)
* **ui:** theme moments for Sprawl: a cold boot that glitches into the skyline, a data-shard loader, and ICE moments ([#450](https://github.com/imagile-dev/toil/issues/450)) ([4ffe066](https://github.com/imagile-dev/toil/commit/4ffe0660d89c31d192c15326ba400f4ab7cef938))
* **ui:** theme moments for Starship: a warp-in splash, a sensor-sweep loader, red alert and all clear ([#447](https://github.com/imagile-dev/toil/issues/447)) ([21b73d9](https://github.com/imagile-dev/toil/commit/21b73d97f1d04596e0a892bf56b7d61b9db2a6ee))
* **ui:** theme moments: splash, loading screens, event moments and toil tips, with Crate and Harvest ([#430](https://github.com/imagile-dev/toil/issues/430)) ([a4ba492](https://github.com/imagile-dev/toil/commit/a4ba4927600b92cc4171ba184af75dcc9c2e7502))
* **ui:** what's new after an upgrade, empty panels that act, and a notification bell ([#449](https://github.com/imagile-dev/toil/issues/449)) ([c34daaf](https://github.com/imagile-dev/toil/commit/c34daaf510176b66b74e21935430c0167988d58a))


### Bug Fixes

* point toil feedback, Toil UI and the skill at /about/feedback/ ([#445](https://github.com/imagile-dev/toil/issues/445)) ([50c7b7e](https://github.com/imagile-dev/toil/commit/50c7b7ecbc710f1028bd27b2225da531c12238ee)), closes [#435](https://github.com/imagile-dev/toil/issues/435)
* require a Node patched for CVE-2026-111497 (24.22.1 or 26.12.1) ([#480](https://github.com/imagile-dev/toil/issues/480)) ([b2eacb1](https://github.com/imagile-dev/toil/commit/b2eacb1cfade0b97a66f884b9aecf5512a7c933d))
* **ui:** Claude's agent features verified live on Haiku, with two usage fixes ([#398](https://github.com/imagile-dev/toil/issues/398)) ([89ee711](https://github.com/imagile-dev/toil/commit/89ee711523834d58937f00259c8691b0d0dc5cc0)), closes [#318](https://github.com/imagile-dev/toil/issues/318)
* **ui:** one animation to an element in the moments engine, Sprawl's scan-in on the compositor, and every theme re-measured ([#463](https://github.com/imagile-dev/toil/issues/463)) ([2f4232e](https://github.com/imagile-dev/toil/commit/2f4232e42cad442f72766125cf14628351531c7e))
* **ui:** Realm's rest days skip today, and their key shows only under a calendar ([#441](https://github.com/imagile-dev/toil/issues/441)) ([05ef95e](https://github.com/imagile-dev/toil/commit/05ef95e16d98409acaa3342837962af775e578be)), closes [#415](https://github.com/imagile-dev/toil/issues/415)
* **ui:** show a board drag while it happens and where it lands ([#400](https://github.com/imagile-dev/toil/issues/400)) ([83879a2](https://github.com/imagile-dev/toil/commit/83879a2eacfdedcbe22009ad77ba64833ed252a5))
* **ui:** the layout check's board drag waits on conditions, not time ([#405](https://github.com/imagile-dev/toil/issues/405)) ([baf16d1](https://github.com/imagile-dev/toil/commit/baf16d179c25d479d825ba794faf9812b698927e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @imagile-dev/toil bumped from 0.1.0-alpha.5 to 0.1.0-beta.1

## [0.1.0-alpha.3](https://github.com/imagile-dev/toil/compare/toil-ui-v0.1.0-alpha.2...toil-ui-v0.1.0-alpha.3) (2026-10-21)


### Features

* onboard to a repo's dossiers, match connections by host, and shareable dossiers by default ([#369](https://github.com/imagile-dev/toil/issues/369)) ([797e884](https://github.com/imagile-dev/toil/commit/797e88422c7f3ec88b261da998dd70209e65d5ef))
* show that a pasted secret arrived, and check the paste, on the CLI and in Toil UI ([#370](https://github.com/imagile-dev/toil/issues/370)) ([d88684d](https://github.com/imagile-dev/toil/commit/d88684d4edb45ace5a056e6a138b01e5a3d79b29))
* **site:** a Toil UI showcase at /ui/ that frames the real app and shows how themes change the prompts ([#386](https://github.com/imagile-dev/toil/issues/386)) ([2136d9e](https://github.com/imagile-dev/toil/commit/2136d9eb05f54d7d718d6ea1222727df14ae6c98))
* ticket the work before starting it, in the skill and in Toil UI's chat ([#367](https://github.com/imagile-dev/toil/issues/367)) ([60f5e48](https://github.com/imagile-dev/toil/commit/60f5e488919f9d77888a211cbd1429db8ca47f49))
* **ui:** a particle switch for every theme, and Fredoka in Plain ([#356](https://github.com/imagile-dev/toil/issues/356)) ([d5c9902](https://github.com/imagile-dev/toil/commit/d5c9902653c284058ab2fc88488555a6b4ae1509))
* **ui:** a stand-up report folded from the worklog, by person, with an optional agent write-up ([#360](https://github.com/imagile-dev/toil/issues/360)) ([a7cf3db](https://github.com/imagile-dev/toil/commit/a7cf3dbc313b0e2c09fb515deb747d1b1efac830))
* **ui:** Ask up front with live status and Analyze; switch agents live and install an approved SDK in one press ([#378](https://github.com/imagile-dev/toil/issues/378)) ([3b82ae2](https://github.com/imagile-dev/toil/commit/3b82ae218a51c3736be507f75f406beb31e227b5))
* **ui:** dossier pages that preview the work, and a dossier's name and description edited in place ([#371](https://github.com/imagile-dev/toil/issues/371)) ([67840ef](https://github.com/imagile-dev/toil/commit/67840ef7405d1414aae2374c06faf941c0faa4b3))
* **ui:** drag the whole board card, with its moves in a context menu ([#375](https://github.com/imagile-dev/toil/issues/375)) ([e65d18c](https://github.com/imagile-dev/toil/commit/e65d18c04327455f30971e2d2fa13ff68183b74f)), closes [#347](https://github.com/imagile-dev/toil/issues/347)
* **ui:** notify on agent state changes, never on events ([#382](https://github.com/imagile-dev/toil/issues/382)) ([ca54072](https://github.com/imagile-dev/toil/commit/ca54072b513421771cfb7a6eacf0e818b1476d0a))
* **ui:** stale sessions, recorded fingerprints and one-click renew ([#381](https://github.com/imagile-dev/toil/issues/381)) ([045fc5c](https://github.com/imagile-dev/toil/commit/045fc5c8ccda9a1797b446e635b0493bc5a0f1f6))
* **ui:** tooltips with Read more links, and edit links to configuration ([#383](https://github.com/imagile-dev/toil/issues/383)) ([f065710](https://github.com/imagile-dev/toil/commit/f0657101a21abe0b489c4b99ae4f500a4d905eb2))


### Bug Fixes

* **ci:** Linux gates on PRs, other platforms daily, and a parallel layout check ([#377](https://github.com/imagile-dev/toil/issues/377)) ([74e44da](https://github.com/imagile-dev/toil/commit/74e44dab5fdbf9b02a53fbdbbf00f3c3d97ad99f))
* **ui:** Copilot's agent features verified live, with the five fixes they needed ([#384](https://github.com/imagile-dev/toil/issues/384)) ([69746c9](https://github.com/imagile-dev/toil/commit/69746c9ea858f8d20e21682fd3c9480dd471aa97))
* **ui:** drop a stale comment in the layout check's help states ([#385](https://github.com/imagile-dev/toil/issues/385)) ([1dead19](https://github.com/imagile-dev/toil/commit/1dead19e3aec3ea058222ca2f0f662a59f5be46f)), closes [#346](https://github.com/imagile-dev/toil/issues/346)
* **ui:** hold only the sample data's header to the 1440px row ([#391](https://github.com/imagile-dev/toil/issues/391)) ([a0ed41a](https://github.com/imagile-dev/toil/commit/a0ed41a1660470faf07ed3bc5987b148c1d4242b))
* **ui:** show Plain's full header row at desktop widths ([#390](https://github.com/imagile-dev/toil/issues/390)) ([dff97b3](https://github.com/imagile-dev/toil/commit/dff97b3de0cda43eddfb1fd784f394b477a4a35d)), closes [#387](https://github.com/imagile-dev/toil/issues/387)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @imagile-dev/toil bumped from 0.1.0-alpha.4 to 0.1.0-alpha.5

## [0.1.0-alpha.2](https://github.com/imagile-dev/toil/compare/toil-ui-v0.1.0-alpha.1...toil-ui-v0.1.0-alpha.2) (2026-10-20)


### Features

* **ado-cloud:** read a team's sprints, backlogs, boards and work item type states ([#331](https://github.com/imagile-dev/toil/issues/331)) ([eec14da](https://github.com/imagile-dev/toil/commit/eec14da286fa5657de0293981fd630545a282fae))
* one command shape for jira and ado, and a Services menu ([#310](https://github.com/imagile-dev/toil/issues/310)) ([fae6921](https://github.com/imagile-dev/toil/commit/fae6921ddd942affdfb0cc4aa1dde4783992fee1))
* OWI for GitHub without a board: milestones as sprints, estimate labels and links ([#324](https://github.com/imagile-dev/toil/issues/324)) ([55f6404](https://github.com/imagile-dev/toil/commit/55f640467b7304040481726deda5c7cc8acdbb56))
* pull request tracking in Toil UI across GitHub, Bitbucket and Azure DevOps ([#334](https://github.com/imagile-dev/toil/issues/334)) ([49ece25](https://github.com/imagile-dev/toil/commit/49ece25ff479c5635318b714da1846948e806ad2))
* seed an Azure DevOps Services board from OWI, test ado-cloud on it, and run Toil UI on it ([#327](https://github.com/imagile-dev/toil/issues/327)) ([e2d0b60](https://github.com/imagile-dev/toil/commit/e2d0b6064e517220236c2c20522b4164610de6b9))
* the command shape for every remaining integration ([#323](https://github.com/imagile-dev/toil/issues/323)) ([323c40c](https://github.com/imagile-dev/toil/commit/323c40cd3d94646443cd5e3877b7d5e7f00f04f3))
* the dog-eared badge as toil's mark, an orbit splash, and a badge per Toil UI theme ([#282](https://github.com/imagile-dev/toil/issues/282)) ([4e1e0ce](https://github.com/imagile-dev/toil/commit/4e1e0ce7a512ce11deb5af0c6fa83c95a273037e))
* toil audit stats, and a Usage of toil page in Toil UI ([#329](https://github.com/imagile-dev/toil/issues/329)) ([7299292](https://github.com/imagile-dev/toil/commit/7299292e6af41794855cd3aed713f268f3e35d68))
* transitions by intent, resolved against each item's own workflow ([#322](https://github.com/imagile-dev/toil/issues/322)) ([e155760](https://github.com/imagile-dev/toil/commit/e155760b2e31ed8d2a1ce8edf85a5bd143cfe7d7))
* **ui:** a daily worklog per dossier, folded from the sync, pull requests, builds and agent runs ([#338](https://github.com/imagile-dev/toil/issues/338)) ([88e813f](https://github.com/imagile-dev/toil/commit/88e813fc42d7613f7891431db91627f6210a4da3))
* **ui:** a People view of what each person and agent is working on ([#336](https://github.com/imagile-dev/toil/issues/336)) ([2fc9178](https://github.com/imagile-dev/toil/commit/2fc917849c503367ff7be0eb2a8a317c11d819d4))
* **ui:** a refined, grimdark Realm theme ([#357](https://github.com/imagile-dev/toil/issues/357)) ([ed9b18e](https://github.com/imagile-dev/toil/commit/ed9b18e349e427d663012905d501aadb0e35e80e))
* **ui:** assign work items to an agent, in refine, investigate and implement modes ([#341](https://github.com/imagile-dev/toil/issues/341)) ([8033f55](https://github.com/imagile-dev/toil/commit/8033f55ca09a33a22a27adf6db3537e06c36e6c6))
* **ui:** npm run verify:ui, Codex in a home of its own, and the lockfile held to the pin ([#325](https://github.com/imagile-dev/toil/issues/325)) ([7f9fc73](https://github.com/imagile-dev/toil/commit/7f9fc73dbfaf5fdc48215c7e1beded4ee02ef410))
* **ui:** per-chat model usage from the Claude, Codex and Copilot SDKs, with optional caps ([#337](https://github.com/imagile-dev/toil/issues/337)) ([9d4e94c](https://github.com/imagile-dev/toil/commit/9d4e94cb4ecb6c4366e7204efa0eba82f2ee2273))
* **ui:** the readiness gate and a read-only Command Center ([#351](https://github.com/imagile-dev/toil/issues/351)) ([a37e707](https://github.com/imagile-dev/toil/commit/a37e70785f002e4ff58a16ab3216119efb6052c4))
* **ui:** theme depth: themed wording, the agent's voice and your own instructions ([#284](https://github.com/imagile-dev/toil/issues/284)) ([f05630e](https://github.com/imagile-dev/toil/commit/f05630e937200030ccd75f7dbd1eca268beb29d5))
* **ui:** Toil UI on real data, bare bones ([#315](https://github.com/imagile-dev/toil/issues/315)) ([3a8d3d5](https://github.com/imagile-dev/toil/commit/3a8d3d5fd35b96ce94c47fb8b4874487bb34de42))
* util owi similar finds likely duplicate work items, offline and deterministic ([#316](https://github.com/imagile-dev/toil/issues/316)) ([dc56487](https://github.com/imagile-dev/toil/commit/dc564873667ab68b0521f2da2075e92c7a7b6cf3))


### Bug Fixes

* **core:** refuse UNC paths before any file access, and validate and encode ids used in API paths ([#352](https://github.com/imagile-dev/toil/issues/352)) ([95b4012](https://github.com/imagile-dev/toil/commit/95b40120062f007b68842df0f897a6dba0d67892))
* **ui:** run verify:ui and dev-real on toil built from this checkout ([#335](https://github.com/imagile-dev/toil/issues/335)) ([51ac386](https://github.com/imagile-dev/toil/commit/51ac386948db17ef393e06e5dff5aad0e5421dec))
* **ui:** Toil UI tests stop timing out on Windows runners ([#330](https://github.com/imagile-dev/toil/issues/330)) ([01c324d](https://github.com/imagile-dev/toil/commit/01c324d7b7f0e6b02988ada74760cdc34256092f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @imagile-dev/toil bumped from 0.1.0-alpha.3 to 0.1.0-alpha.4

## 0.1.0-alpha.1 (2026-10-19)


### Features

* consented feedback from the site, the API, toil feedback and Toil UI ([#270](https://github.com/imagile-dev/toil/issues/270)) ([ba6a558](https://github.com/imagile-dev/toil/commit/ba6a5582a703da95b5378fcc77d63b857c075f11))
* playful wordmark across the site, Toil UI and the CLI ([#274](https://github.com/imagile-dev/toil/issues/274)) ([913e7bf](https://github.com/imagile-dev/toil/commit/913e7bfda433f649fd758f9ae9934139fdffb74b))
* **ui:** agent adapters for Claude, Copilot and Codex ([#260](https://github.com/imagile-dev/toil/issues/260)) ([48c8748](https://github.com/imagile-dev/toil/commit/48c87480f4fbf397e5f421a61408e20732ccff43))
* **ui:** board, flow, dependency graph, insights, charts and a docked chat ([#255](https://github.com/imagile-dev/toil/issues/255)) ([70e4bd2](https://github.com/imagile-dev/toil/commit/70e4bd2e82fb7945f8f34f2714fae52e50e8e7d6))
* **ui:** generated art for the game themes ([#269](https://github.com/imagile-dev/toil/issues/269)) ([e919f36](https://github.com/imagile-dev/toil/commit/e919f364ee0b096699a5d5d586a191d92f4c8a6f))
* **ui:** Harvest, Starship and Realm themes ([#259](https://github.com/imagile-dev/toil/issues/259)) ([cb78b63](https://github.com/imagile-dev/toil/commit/cb78b6369d3247bc843b2a96a52ae9d45491352d))
* **ui:** motion and life for the game themes ([#275](https://github.com/imagile-dev/toil/issues/275)) ([552ab20](https://github.com/imagile-dev/toil/commit/552ab204231fbdd11b890b0987bd65196abe136e))
* **ui:** one dashboard per dossier, fed by a fixture execute() ([#229](https://github.com/imagile-dev/toil/issues/229)) ([01a4e39](https://github.com/imagile-dev/toil/commit/01a4e395450ccfaeaa0ae34cdf740c8679fb10f7))
* **ui:** settings pages for toil's connections and dossiers, through ./api ([#258](https://github.com/imagile-dev/toil/issues/258)) ([dd37791](https://github.com/imagile-dev/toil/commit/dd37791dc3e1590d58633be74901e2b788c3cffd))
* **ui:** sync into a local SQLite cache through ./api ([#257](https://github.com/imagile-dev/toil/issues/257)) ([b8ede69](https://github.com/imagile-dev/toil/commit/b8ede69f761f247b50f00f9f2134d08a7c42ecbe))
* **ui:** the @imagile-dev/toil-ui package and its local server ([#254](https://github.com/imagile-dev/toil/issues/254)) ([40f4698](https://github.com/imagile-dev/toil/commit/40f46987023fd89f41c604bad5a328815a19b0e3))
* **ui:** Toil UI site preview on a fixture Store and a scripted Agent ([#227](https://github.com/imagile-dev/toil/issues/227)) ([b33ab70](https://github.com/imagile-dev/toil/commit/b33ab70600fcca990f3b58966de35c192f29f4f5))


### Bug Fixes

* layout primitives, an overflow check, and the UI and site sweep fixes ([#280](https://github.com/imagile-dev/toil/issues/280)) ([44aa883](https://github.com/imagile-dev/toil/commit/44aa88396c054373b34e8c6202115b75902bc613))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @imagile-dev/toil bumped from 0.1.0-alpha.2 to 0.1.0-alpha.3

/**
 * Settings (#253, item 4), each page its own address under `#/settings/`:
 * General first (notifications, applying board moves, links to learning content, then a closed
 * Advanced section), Connections, Toil projects, Appearance (the theme, light
 * or dark, the font and one Motion setting), Usage (how Toil is used, and what
 * the AI agent's models used, with the Codex rates) and AI agent. The title is just
 * "Settings" on every page. Every change to toil's config runs one of toil's
 * own config commands through the local server (src/config.ts), never by
 * editing a file: no tracker is ever written from here. The AI agent page is
 * Toil UI's own setting. In the preview, the pages show sample data and every
 * change is turned off, with a note saying why. A form for the forms, finally
 * approved.
 */

import type { SettingsPage } from '../App.tsx';
import { AgentSettingsPanel, AgentSettingsPreview, type AgentSettingsPanelProps } from '../agent-settings.tsx';
import type { ConfigApi } from '../config.ts';
import { NavButton } from '../components/nav-button.tsx';
import { Scroller } from '../components/layout.tsx';
import { Help } from '../components/help.tsx';
import type { HelpTopicId } from '../help.ts';
import './settings.css';
import { Connections } from './settings/Connections.tsx';
import { ToilProjectSetup } from './settings/ToilProjectSetup.tsx';
import type { ClassifyApi } from '../classify-api.ts';
import type { WorkItem } from '../toil.ts';
import { Advanced, type CacheControl } from './settings/General.tsx';
import { ChartMarksSetting } from './settings/ChartMarks.tsx';
import { MotionSetting } from './settings/Motion.tsx';
import { LearningSetting } from './settings/Learning.tsx';
import { BoardMovesSetting } from './settings/BoardMoves.tsx';
import { NotifySetting } from '../components/notify.tsx';
import { ThemeSetting } from './settings/Theme.tsx';
import { usePlain } from '../plain-words.ts';
import { Usage } from './settings/Usage.tsx';
import type { ModelUsageApi } from '../server-client.ts';

/**
 * Where a link lands on a page that isn't a named thing (#416): the add-connection form, or the
 * create-toil-project form. A connection or toil project name can't start with `+`, so these never collide with one.
 */
export const ADD_CONNECTION_HREF = '#/settings/connections/+add';
export const CREATE_TOIL_PROJECT_HREF = '#/new-project';

export const SETTINGS_PAGES: Array<{ page: SettingsPage; label: string; plain?: { label: string; about: string }; about: string; topic: HelpTopicId }> = [
  { page: 'general', label: 'General', about: 'Notifications, applying board moves, and links to learning content, in this browser. Advanced holds what few people need.', topic: 'settings' },
  { page: 'connections', label: 'Connections', plain: { label: 'Connections', about: 'Your links to tools such as Jira and GitHub: add one, check that it works, choose the main one, allow writes or make it read only, update a login, or remove it.' }, about: 'Your links to tools such as Jira and GitHub.', topic: 'connections' },
  { page: 'projects', label: 'Toil projects', plain: { label: 'Toil projects', about: 'Set up a Toil project: the repositories it covers, its tools, its field names, its people and a limit on work in progress. Create Toil projects here too.' }, about: 'Set up a repository that has a Toil project, create Toil projects, and give them repositories, areas, field names, people and a work-in-progress limit.', topic: 'toil-project-setup' },
  { page: 'appearance', label: 'Appearance', about: 'The theme, light or dark, the font and motion in this browser.', topic: 'themed-wording' },
  { page: 'usage', label: 'Usage', about: 'How Toil is used on this computer, and what your AI agent has used.', topic: 'audit' },
  { page: 'agent', label: 'AI agent', about: 'Which AI agent answers questions in the chat, and your own instructions for it.', topic: 'agent' },
];

export function Settings({ page, at = [], config, agent, modelUsage = null, cache, classify, loadItems }: { page: SettingsPage; at?: string[]; config: ConfigApi | null; agent?: AgentSettingsPanelProps; modelUsage?: ModelUsageApi | null; cache?: CacheControl; classify?: ClassifyApi | undefined; loadItems?: ((toilProject: string) => Promise<WorkItem[]>) | undefined }) {
  const current = SETTINGS_PAGES.find((p) => p.page === page)!;
  const form = at[0] === '+add' || at[0] === '+new';
  const plain = usePlain();
  const shown = (p: (typeof SETTINGS_PAGES)[number]) => ({ label: plain.on && p.plain ? p.plain.label : p.label, about: plain.on && p.plain ? p.plain.about : p.about });
  return (
    <>
      <div className="view-head">
        {/* No eyebrow saying "Settings" over "Settings", and no lede per tab repeating its cards' titles (#657): what a tab is for is the heading's (i). */}
        <div className="view-head__row">
          <span className="control-row__group">
            <h1 tabIndex={-1}>Settings</h1>
            <Help topic={current.topic} note={shown(current).about} />
          </span>
          <NavButton href="#/setup" kind="secondary" size="sm">
            Set things up step by step
          </NavButton>
        </div>
      </div>
      {/* One line at any width (#657): on a phone the tabs scroll sideways inside a declared scroller, with its cue. */}
      <nav className="subnav" aria-label="Settings pages">
        <Scroller label="Settings tabs">
        <ul>
          {SETTINGS_PAGES.map((p) => (
            <li key={p.page}>
              <a href={`#/settings/${p.page}`} aria-current={p.page === page ? 'page' : undefined} title={plain.on && p.plain && p.plain.label !== p.label ? plain.title(p.label) : undefined}>
                {shown(p).label}
              </a>
            </li>
          ))}
        </ul>
        </Scroller>
      </nav>
      {config?.disabled && page !== 'agent' && page !== 'usage' && page !== 'appearance' && page !== 'general' && (
        <p className="config-off">
          <strong>Changes are turned off.</strong> {config.disabled}
        </p>
      )}
      {page === 'appearance' ? (
        <>
          <ThemeSetting />
          <MotionSetting />
          <ChartMarksSetting />
          <p className="note" data-saved-here="">Saved in this browser only.</p>
        </>
      ) : page === 'agent' ? (
        agent ? <AgentSettingsPanel {...agent} /> : <AgentSettingsPreview />
      ) : page === 'usage' ? (
        <Usage config={config} modelUsage={modelUsage} landOn={at[0] === 'rates' ? 'model-usage-rates' : null} />
      ) : page === 'general' ? (
        <>
          <NotifySetting />
          <BoardMovesSetting />
          <LearningSetting />
          <p className="note" data-saved-here="">Saved in this browser only.</p>
          <Advanced config={config} cache={cache} />
        </>
      ) : !config ? (
        <p className="failure">This app can't change settings here, so there is nothing to show.</p>
      ) : page === 'connections' ? (
        <Connections config={config} {...(form ? { toForm: true } : at[0] ? { at: at[0] } : {})} />
      ) : page === 'projects' ? (
        <ToilProjectSetup config={config} classify={classify} loadItems={loadItems} {...(form ? { toForm: true } : at[0] ? { at: { toilProject: at[0], section: at[1] ?? null } } : {})} />
      ) : null}
    </>
  );
}

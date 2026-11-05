/**
 * toil's configuration from the browser (#253, item 4): Connections, Toil projects,
 * General (the theme and how deep it goes, #283, motion in this browser,
 * #271, notifications, links to learning content, #418, then bounds and the time limit), Usage (what toil's audit log says
 * about how toil is used, #309), Agent usage (what the agent's models used,
 * and its caps, #295), and
 * the agent's own settings (#251), each its own page under `#/settings/`. Every change to toil's config runs one of toil's
 * own config commands through the local server (src/config.ts), never by
 * editing a file: no tracker is ever written from here. The Agent page is
 * Toil UI's own setting, and its panel (src/agent-settings.tsx) says so. In the preview, the pages show sample
 * data and every change is turned off, with a note saying why. A form for the
 * forms, finally approved.
 */

import type { SettingsPage } from '../App.tsx';
import { AgentSettingsPanel, AgentSettingsPreview, type AgentSettingsPanelProps } from '../agent-settings.tsx';
import type { ConfigApi } from '../config.ts';
import { useWords } from '../skins.tsx';
import { Help } from '../components/help.tsx';
import type { HelpTopicId } from '../help.ts';
import './settings.css';
import { Connections } from './settings/Connections.tsx';
import { ToilProjectSetup } from './settings/ToilProjectSetup.tsx';
import { General } from './settings/General.tsx';
import { MotionSetting } from './settings/Motion.tsx';
import { LearningSetting } from './settings/Learning.tsx';
import { NotifySetting } from '../components/notify.tsx';
import { ThemeSetting } from './settings/Theme.tsx';
import { PlainWordsSetting } from '../components/plain-switch.tsx';
import { usePlain } from '../plain-words.ts';
import { Usage } from './settings/Usage.tsx';
import { ModelUsage } from './settings/ModelUsage.tsx';
import type { ModelUsageApi } from '../server-client.ts';

/**
 * Where a link lands on a page that isn't a named thing (#416): the add-connection form, or the
 * create-toil-project form. A connection or toil project name can't start with `+`, so these never collide with one.
 */
export const ADD_CONNECTION_HREF = '#/settings/connections/+add';
export const CREATE_TOIL_PROJECT_HREF = '#/settings/projects/+new';

export const SETTINGS_PAGES: Array<{ page: SettingsPage; label: string; plain?: { label: string; about: string }; about: string; topic: HelpTopicId }> = [
  { page: 'connections', label: 'Connections', plain: { label: 'Connections', about: 'Your links to tools such as Jira and GitHub: add one, check that it works, choose the main one, allow or stop changes, update a login, or remove it.' }, about: 'The connections toil uses: add, test, set the default, turn writes on or off, replace a secret, remove.', topic: 'connections' },
  { page: 'projects', label: 'Toil projects', plain: { label: 'Toil projects', about: 'Set up a Toil project: the repositories it covers, its tools, its field names, its people and a limit on work in progress. Create Toil projects here too.' }, about: 'Set up a repository that has a Toil project, create Toil projects, and give them repositories, areas, field names, people and a work-in-progress limit.', topic: 'toil-project-setup' },
  { page: 'toil', label: 'General', about: 'How Toil UI looks, talks, moves, notifies and links out in this browser, and the settings toil has no command for.', topic: 'bounds' },
  { page: 'usage', label: 'Usage', about: "How toil is used on this machine: calls per day, the commands used and failing most, and the ones never called, from toil's local audit log.", topic: 'audit' },
  { page: 'agent-usage', label: 'Agent usage', plain: { label: 'AI usage', about: 'What the AI helpers used in your chats, and optional limits that stop a runaway.' }, about: "What the agent's models used in your chats, and optional caps that stop a runaway.", topic: 'model-usage' },
  { page: 'agent', label: 'Agent', plain: { label: 'AI helper', about: 'Which AI helper answers questions in the chat, and your own instructions for it.' }, about: 'Which agent answers questions in the chat, and your own instructions for it.', topic: 'agent' },
];

export function Settings({ page, at = [], config, agent, modelUsage = null }: { page: SettingsPage; at?: string[]; config: ConfigApi | null; agent?: AgentSettingsPanelProps; modelUsage?: ModelUsageApi | null }) {
  const current = SETTINGS_PAGES.find((p) => p.page === page)!;
  const form = at[0] === '+add' || at[0] === '+new';
  const words = useWords();
  const plain = usePlain();
  const shown = (p: (typeof SETTINGS_PAGES)[number]) => ({ label: plain.on && p.plain ? p.plain.label : p.label, about: plain.on && p.plain ? p.plain.about : p.about });
  return (
    <>
      <div className="view-head">
        <p className="eyebrow">{words('settings.eyebrow')}</p>
        <h1 tabIndex={-1} title={plain.title("toil's configuration")}>
          {plain.pw("toil's configuration", 'Connections and Toil projects')}
        </h1>
        <p className="lede">
          {plain.on ? (
            <>Your links to tools, and your Toil projects.</>
          ) : (
            <>What <code>toil connections</code> and <code>toil projects</code> manage, through toil's own commands.</>
          )}{' '}
          <Help topic="settings" />
        </p>
      </div>
      <nav className="subnav" aria-label="Settings pages">
        <ul>
          {SETTINGS_PAGES.map((p) => (
            <li key={p.page}>
              <a href={`#/settings/${p.page}`} aria-current={p.page === page ? 'page' : undefined} title={plain.on && p.plain && p.plain.label !== p.label ? plain.title(p.label) : undefined}>
                {shown(p).label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {config?.disabled && page !== 'agent' && page !== 'usage' && page !== 'agent-usage' && (
        <p className="config-off">
          <strong>Changes are turned off.</strong> {config.disabled}
        </p>
      )}
      <h2 className="page-title">{shown(current).label}</h2>
      <p className="lede">
        {shown(current).about} <Help topic={current.topic} />
      </p>
      {page === 'toil' && (
        <>
          <PlainWordsSetting />
          <ThemeSetting />
          <MotionSetting />
          <NotifySetting />
          <LearningSetting />
        </>
      )}
      {page === 'agent' ? (
        agent ? <AgentSettingsPanel {...agent} /> : <AgentSettingsPreview />
      ) : page === 'agent-usage' ? (
        <ModelUsage api={modelUsage} landOn={at[0] === 'caps' ? 'model-usage-caps' : null} />
      ) : !config ? (
        <p className="failure">This app wasn't given toil's config commands, so there is nothing to show.</p>
      ) : page === 'connections' ? (
        <Connections config={config} {...(form ? { toForm: true } : at[0] ? { at: at[0] } : {})} />
      ) : page === 'projects' ? (
        <ToilProjectSetup config={config} {...(form ? { toForm: true } : at[0] ? { at: { toilProject: at[0], section: at[1] ?? null } } : {})} />
      ) : page === 'usage' ? (
        <Usage config={config} />
      ) : (
        <General config={config} />
      )}
    </>
  );
}

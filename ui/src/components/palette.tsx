/**
 * The command palette and the shortcuts sheet (#416). Ctrl+K (⌘K on a Mac)
 * opens the palette from anywhere: it jumps to a toil project, a toil project's tab, an
 * item in any toil project, a saved analysis, a settings page or a theme, and runs
 * Sync, Ask, Analyze, assign the focused item to an agent, and the choice of
 * agent for the chat. `?` opens the sheet, drawn from the shortcut table
 * (src/shortcuts.ts). Both stay out of sight until called up.
 *
 * It's React Aria's Autocomplete around a Menu, so a screen reader follows
 * the highlighted result while focus stays in the search field, and the
 * matching is our own (src/fuzzy.ts). Items are searched in what the App has
 * read, which the local app answers from its cache: the palette makes no live
 * call. A result from a toil project whose last sync is old says how old. A
 * switchboard, without the hold music.
 */

import { useEffect, useState } from 'react';
import { Autocomplete, Button, Dialog, Header, Heading, Input, Menu, MenuItem, MenuSection, Modal, ModalOverlay, SearchField } from 'react-aria-components';
import type { AdapterList, Agent } from '../agent.ts';
import type { AnalysesApi } from '../analyses.ts';
import type { Route } from '../App.tsx';
import { sendCommand, type UiCommand } from '../commands.ts';
import { analysisHref, dateTime, toilProjectHref, itemHref, shortKey, standupHref, STATUS_CATEGORY_LABEL, toilProjectEditHref } from '../format.ts';
import { fuzzyRank } from '../fuzzy.ts';
import type { ToilProjectData } from '../load.ts';
import type { AnalysisSummary } from '../model/analysis.ts';
import { keyLabel, SHORTCUTS, type Shortcut } from '../shortcuts.ts';
import { TOIL_PROJECT_TABS } from '../views/ToilProjectShell.tsx';
import { FACE } from '../model/jobs.ts';
import { jobHref } from './jobs.tsx';
import { usePlain } from '../plain-words.ts';
import type { SyncedAt } from '../views/ToilProjects.tsx';
import { SETTINGS_PAGES } from '../views/Settings.tsx';
import { Help } from './help.tsx';
import './palette.css';

export type PaletteGroup = 'commands' | 'toilProjects' | 'tabs' | 'items' | 'analyses' | 'settings' | 'themes';

const GROUP_LABEL: Record<PaletteGroup, string> = { commands: 'Commands', toilProjects: 'Toil projects', tabs: 'Tabs', items: 'Items', analyses: 'Analyses', settings: 'Settings', themes: 'Themes' };
/** The groups plain words (src/plain-words.ts) renames. */
const PLAIN_GROUP_LABEL: Partial<Record<PaletteGroup, string>> = { toilProjects: 'Toil projects', tabs: 'Pages', analyses: 'Past briefings' };
/** The order with nothing typed. With a query, the groups go in the order of their best match. */
const GROUP_ORDER: PaletteGroup[] = ['commands', 'toilProjects', 'tabs', 'items', 'analyses', 'settings', 'themes'];
/** The most results a group shows for a query: enough to choose from, few enough to read. */
const GROUP_CAP: Record<PaletteGroup, number> = { commands: 8, toilProjects: 8, tabs: 10, items: 20, analyses: 8, settings: 8, themes: 12 };

/** How old a toil project's cache may be before its results say how old. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface PaletteEntry {
  id: string;
  group: PaletteGroup;
  label: string;
  /** A second line: where it is, its status, how old. */
  detail?: string;
  /** What the query is matched against; the label when absent. */
  text?: string;
  /** Found only by typing: one per Toil project would bury the commands that are always shown (principle 11). */
  typed?: true;
  /** A place to go, or something to do. */
  go: { href: string } | { command: UiCommand } | { run: () => void };
}

type Loaded = { ok: true; value: ToilProjectData } | { ok: false; message: string };

/** "3 days", "5 hours", "20 minutes". */
export function ageText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** What an item's result says after its toil project when the toil project's cache is stale: its age, or that its last sync failed. */
export function staleNote(synced: SyncedAt | undefined, at: number): string | null {
  if (!synced) return null;
  const age = at - Date.parse(synced.at);
  if (synced.status !== 'ok') return `last sync ${synced.status === 'partial' ? 'partly failed' : 'failed'}, cached ${ageText(age)} ago`;
  return age > STALE_AFTER_MS ? `cached ${ageText(age)} ago` : null;
}

export interface EntriesInput {
  route: Route;
  toilProjects: string[];
  loaded: Record<string, Loaded | undefined>;
  analyses: Record<string, AnalysisSummary[] | undefined>;
  synced: Record<string, SyncedAt> | undefined;
  /** The wall clock, for how old a cache is. */
  at: number;
  themes: Array<{ name: string; label: string }>;
  currentTheme: string;
  setTheme: (name: string) => void;
  scheme: 'system' | 'light' | 'dark';
  setScheme: (scheme: 'system' | 'light' | 'dark') => void;
  onSync: (() => void) | undefined;
  /** Archives (true) or unarchives (false) a Toil project (#561); absent where the page may not change things. */
  onArchive?: ((name: string, archive: boolean) => void) | undefined;
  /** The archived Toil projects, for the Unarchive entries. */
  archivedNames?: string[];
  /** The item the focus was on when the palette opened, in the toil project on screen. */
  focused: string | null;
  canAssign: boolean;
  adapters: AdapterList | null;
  agentSettings: boolean;
  openShortcuts: () => void;
  /** Whether a worklog is kept, which the stand-up is folded from. */
  hasWorklog?: boolean;
}

/** Every entry the palette can show, before any query. */
export function paletteEntries(x: EntriesInput): PaletteEntry[] {
  const pw = (_standard: string, plain: string) => plain;
  const out: PaletteEntry[] = [];
  const here = x.route.view === 'toilProjects' || x.route.view === 'settings' || x.route.view === 'setup' || x.route.view === 'newProject' ? null : x.route.toilProject;
  const current = here ? x.loaded[here] : undefined;
  if (x.onSync) out.push({ id: 'cmd:sync', group: 'commands', label: 'Sync now', detail: 'Read every Toil project through toil into the cache', go: { run: x.onSync } });
  if (here && current?.ok) {
    out.push({ id: 'cmd:ask', group: 'commands', label: `Ask about ${here}`, detail: 'Focus the Ask bar', go: { command: { kind: 'ask' } } });
    out.push({ id: 'cmd:analyze', group: 'commands', label: pw(`Analyze ${here}`, `Get a briefing on ${here}`), detail: pw("The agent's pulse check of the Toil project", "An AI agent writes a briefing of what needs attention"), go: { command: { kind: 'analyze' } } });
    out.push({ id: 'cmd:agents', group: 'commands', label: pw('Open the Agents panel', 'Open the AI agents panel'), detail: pw('Assignments, the inbox and limits', 'What the AI agents are doing, and what waits on you'), text: 'agents ai agents assignments inbox', go: { command: { kind: 'agents' } } });
    if (x.hasWorklog) out.push({ id: 'cmd:standup', group: 'commands', label: 'Open the stand-up', detail: `Since the last working day, in ${here}`, text: 'stand-up standup daily meeting since yesterday what happened', go: { href: standupHref(here) } });
    // The workflow jobs (#532): each opens its own page, which says what it needs and has the Run button.
    out.push({ id: 'cmd:job:review', group: 'commands', label: pw('Review a pull request', 'Check a code change'), detail: FACE.review.gist, text: 'review pull request code review job', go: { href: jobHref(here, 'review') } });
    out.push({ id: 'cmd:job:ship', group: 'commands', label: pw('Ship: answer a review', 'Answer the review of my code change'), detail: FACE.ship.gist, text: 'ship answer review pull request job author', go: { href: jobHref(here, 'ship') } });
    out.push({ id: 'cmd:job:diagram', group: 'commands', label: pw(`Diagram ${here}`, `Draw the architecture of ${here}`), detail: FACE['map-codebase'].gist, text: 'diagram draw architecture c4 map codebase job', go: { href: jobHref(here, 'map-codebase') } });
    const item = x.focused ? current.value.items.find((i) => i.id === x.focused) : undefined;
    if (item && x.canAssign) out.push({ id: 'cmd:assign', group: 'commands', label: pw(`Assign ${shortKey(item)} to an agent`, `Give ${shortKey(item)} to an AI agent`), detail: item.title, go: { command: { kind: 'assign', id: item.id } } });
    for (const o of x.adapters?.options ?? []) {
      if (!o.ready) continue;
      const label = o.model ? `${o.label} (${o.model})` : o.label;
      out.push({ id: `cmd:agent:${o.name}`, group: 'commands', label: `Answer with ${label}`, detail: 'For this chat, from its next question', go: { command: { kind: 'agent', name: o.name, label } } });
    }
  }
  if (x.agentSettings) out.push({ id: 'cmd:agent-default', group: 'commands', label: 'Choose the default AI agent', detail: 'Settings, AI agent', go: { href: '#/settings/agent' } });
  out.push({ id: 'cmd:setup', group: 'commands', label: 'Set up toil, step by step', detail: 'The setup wizard: tools, a Toil project, an AI agent', text: 'setup wizard guided get started connect tools onboarding', go: { href: '#/setup' } });
  out.push({ id: 'cmd:new-project', group: 'commands', label: 'Create a Toil project', detail: 'Name it, say where it lives and pick its tools', text: 'new create toil project name folder repository tools', typed: true, go: { href: '#/new-project' } });
  // Reading a few Jira issues to name its custom fields in a Toil project, in Settings or, with no Toil project yet, the wizard that makes one.
  out.push({ id: 'cmd:find-fields', group: 'commands', label: 'Find your Jira fields', detail: 'Name story points and sprints in a Toil project', text: 'find jira fields custom field discover story points sprint customfield', go: { href: x.toilProjects[0] ? toilProjectEditHref(x.toilProjects[0], 'find-fields') : '#/setup' } });
  out.push({ id: 'cmd:shortcuts', group: 'commands', label: 'Keyboard shortcuts', detail: `Press ${SHORTCUTS.shortcuts.keys.join('')} anywhere`, go: { run: x.openShortcuts } });

  out.push({ id: 'toilProject:*', group: 'toilProjects', label: 'All Toil projects', go: { href: '#/' } });
  for (const d of x.toilProjects) out.push({ id: `toilProject:${d}`, group: 'toilProjects', label: d, go: { href: toilProjectHref(d) } });
  // Putting one away and bringing it back (#561): one more way to each, found by typing archive or the name.
  const onArchive = x.onArchive;
  if (onArchive) {
    for (const d of x.toilProjects) out.push({ id: `cmd:archive:${d}`, group: 'commands', label: `Archive ${d}`, detail: 'Hide it from the list; nothing is deleted', text: `archive put away hide ${d}`, typed: true, go: { run: () => onArchive(d, true) } });
    for (const d of x.archivedNames ?? []) out.push({ id: `cmd:unarchive:${d}`, group: 'commands', label: `Unarchive ${d}`, detail: 'Put it back in the list', text: `unarchive restore bring back ${d}`, typed: true, go: { run: () => onArchive(d, false) } });
  }
  for (const d of x.toilProjects) {
    // With plain words on, a tab is found by either name: its plain label shows, and its own term still matches a search.
    for (const t of TOIL_PROJECT_TABS) out.push({ id: `tab:${d}:${t.id}`, group: 'tabs', label: pw(t.label, t.plain), detail: d, text: `${pw(t.label, t.plain)} ${t.label} ${d}`, go: { href: t.href(d) } });
    // How Analyze briefs it (#494): its page in Settings, one more way in.
    out.push({ id: `settings:analyze:${d}`, group: 'settings', label: 'How Analyze briefs it', detail: d, text: `analyze settings ${d}`, go: { href: toilProjectEditHref(d, 'analyze') } });
  }
  for (const d of x.toilProjects) {
    const l = x.loaded[d];
    if (!l?.ok) continue;
    const stale = staleNote(x.synced?.[d], x.at);
    for (const i of l.value.items) {
      const status = i.status ?? STATUS_CATEGORY_LABEL[i.statusCategory];
      out.push({ id: `item:${d}:${i.id}`, group: 'items', label: `${shortKey(i)} ${i.title}`, detail: [d, status, stale].filter(Boolean).join(' · '), go: { href: itemHref(d, i.id) } });
    }
  }
  for (const d of x.toilProjects) {
    for (const a of x.analyses[d] ?? []) {
      out.push({ id: `analysis:${d}:${a.id}`, group: 'analyses', label: `Analysis of ${d}, ${dateTime(a.at)}`, ...(a.recommendation ? { detail: a.recommendation } : {}), text: `analysis ${d} ${dateTime(a.at)} ${a.recommendation ?? ''}`, go: { href: analysisHref(d, a.id) } });
    }
  }
  for (const p of SETTINGS_PAGES) out.push({ id: `settings:${p.page}`, group: 'settings', label: p.label, detail: 'Settings', text: `settings ${p.label}`, go: { href: `#/settings/${p.page}` } });
  for (const t of x.themes) out.push({ id: `theme:${t.name}`, group: 'themes', label: `${t.label} theme`, ...(t.name === x.currentTheme ? { detail: 'The theme now' } : {}), go: { run: () => x.setTheme(t.name) } });
  for (const [id, name] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const) out.push({ id: `scheme:${id}`, group: 'themes', label: `Appearance: ${name}`, ...(id === x.scheme ? { detail: 'The appearance now' } : {}), go: { run: () => x.setScheme(id) } });
  return out;
}

/**
 * What the palette shows for a query, group by group. With nothing typed: the
 * commands, the toil projects, the tabs of the toil project on screen, settings and
 * themes, since every item of every toil project is too many to read. With a
 * query: everything that matches, best first in each group, and the group
 * with the best match first.
 */
export function paletteResults(entries: PaletteEntry[], query: string, here: string | null): Array<{ group: PaletteGroup; entries: PaletteEntry[] }> {
  const q = query.trim();
  if (!q) {
    const shown = entries.filter((e) => !e.typed && e.group !== 'items' && e.group !== 'analyses' && (e.group !== 'tabs' || e.detail === here));
    return GROUP_ORDER.map((group) => ({ group, entries: shown.filter((e) => e.group === group) })).filter((g) => g.entries.length);
  }
  const ranked = fuzzyRank(entries, q, (e) => e.text ?? e.label);
  const groups = GROUP_ORDER.map((group) => {
    const hits = ranked.filter((r) => r.entry.group === group).slice(0, GROUP_CAP[group]);
    return { group, best: hits[0]?.score ?? -Infinity, entries: hits.map((r) => r.entry) };
  }).filter((g) => g.entries.length);
  return groups.sort((a, b) => b.best - a.best).map(({ group, entries: es }) => ({ group, entries: es }));
}

/** Runs after the palette has closed and handed focus back, so a new page's heading or the Ask bar can take it. */
const afterClose = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

export interface CommandPaletteProps extends Omit<EntriesInput, 'analyses' | 'adapters' | 'at'> {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  analysesApi: AnalysesApi;
  /** Toil projects still being read from the cache for the item search. */
  reading: number;
}

export function CommandPalette({ isOpen, onOpenChange, agent, analysesApi, reading, ...input }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [adapters, setAdapters] = useState<AdapterList | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, AnalysisSummary[]>>({});
  // The wall clock when it opened, for how old a cache is: the App's own clock is when its data was read.
  const [at, setAt] = useState(0);
  const names = input.toilProjects.join('\n');
  const here = input.route.view === 'toilProjects' || input.route.view === 'settings' || input.route.view === 'setup' || input.route.view === 'newProject' ? null : input.route.toilProject;

  // Each time it opens: the adapters and the saved analyses, both read from what the server already has.
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    setAt(Date.now());
    if (agent.adapters && here) agent.adapters(here).then((a) => live && setAdapters(a), () => live && setAdapters(null));
    for (const d of names ? names.split('\n') : []) analysesApi.list(d).then((list) => live && setAnalyses((all) => ({ ...all, [d]: list })), () => undefined);
    return () => {
      live = false;
    };
  }, [isOpen, agent, analysesApi, names, here]);

  // Built on each render while it's open, which is cheap next to a keystroke (a few hundred entries), and not at all
  // while it's closed: the App re-renders often (a streaming answer), and every item of every toil project is a lot to list for nothing.
  const plain = usePlain();
  const entries = isOpen ? paletteEntries({ ...input, analyses, adapters, at }) : [];
  const results = paletteResults(entries, query, here);
  const byId = new Map(entries.map((e) => [e.id, e]));

  const choose = (id: string) => {
    const e = byId.get(id);
    onOpenChange(false);
    if (!e) return;
    const go = e.go;
    afterClose(() => {
      if ('href' in go) window.location.hash = go.href;
      else if ('command' in go) sendCommand(go.command);
      else go.run();
    });
  };
  // However it closed (a result, Escape, a click outside, Ctrl+K again), it opens next time empty.
  useEffect(() => {
    if (!isOpen) setQuery('');
  }, [isOpen]);

  return (
    <ModalOverlay className="palette-overlay" data-backdrop="" isDismissable isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal className="palette-modal">
        <Dialog className="palette" aria-label="Command palette" data-palette="">
          <Autocomplete inputValue={query} onInputChange={setQuery}>
            <SearchField className="palette__search" aria-label="Jump to or run" autoFocus>
              <Input className="palette__input" placeholder={plain.pw('Jump to a Toil project, tab, item or setting, or run a command', 'Jump to a Toil project, page, item or setting, or run a command')} data-palette-input="" />
            </SearchField>
            <p className="palette__status note" role="status">
              {reading > 0 ? `Reading ${reading} more ${reading === 1 ? 'Toil project' : 'Toil projects'} from the cache for the item search…` : !query.trim() ? 'Type a key or a title to search the items of every Toil project.' : ''}
            </p>
            <Menu className="palette__list" aria-label="Results" onAction={(k) => choose(String(k))} renderEmptyState={() => <p className="palette__empty">Nothing matches “{query.trim()}”.</p>}>
              {results.map((g) => (
                <MenuSection key={g.group} id={g.group} className="palette__group">
                  <Header className="menu-header">{plain.on ? (PLAIN_GROUP_LABEL[g.group] ?? GROUP_LABEL[g.group]) : GROUP_LABEL[g.group]}</Header>
                  {g.entries.map((e) => (
                    // Its name is all of what it shows, the detail line too, so the name a screen reader or voice control uses is the words on screen (WCAG 2.5.3).
                    <MenuItem key={e.id} id={e.id} textValue={e.label} className="menu-item palette__item" data-palette-item={e.group}>
                      <span className="palette__label">{e.label}</span>
                      {e.detail && <span className="palette__detail">{e.detail}</span>}
                    </MenuItem>
                  ))}
                </MenuSection>
              ))}
            </Menu>
          </Autocomplete>
          <p className="palette__foot note">
            <kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Escape</kbd> to close. <Help topic="palette" />
          </p>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The `?` sheet: every shortcut in the table, grouped by where it works. */
export function ShortcutsSheet({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const groups = new Map<string, Shortcut[]>();
  for (const s of Object.values(SHORTCUTS) as Shortcut[]) groups.set(s.where, [...(groups.get(s.where) ?? []), s]);
  const keys = (ks: readonly string[]) =>
    ks.map((k, i) => (
      <span key={k}>
        {i > 0 && '+'}
        <kbd>{keyLabel(k)}</kbd>
      </span>
    ));
  return (
    <ModalOverlay className="palette-overlay" data-backdrop="" isDismissable isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal className="palette-modal shortcuts-modal">
        <Dialog className="shortcuts" aria-labelledby="shortcuts-title" data-shortcuts="">
          {({ close }) => (
            <>
              <div className="shortcuts__head">
                <Heading slot="title" id="shortcuts-title">
                  Keyboard shortcuts
                </Heading>
                <Button className="btn btn--small" onPress={close} data-shortcuts-close="">
                  Close
                </Button>
              </div>
              {[...groups].map(([where, list]) => (
                <section key={where} className="shortcuts__group" aria-label={where}>
                  <h3>{where}</h3>
                  <dl>
                    {list.map((s) => (
                      <div key={s.what} className="shortcuts__row">
                        <dt>
                          {keys(s.keys)}
                          {(s.or ?? []).map((o) => (
                            <span key={o.join('+')}>
                              {' or '}
                              {keys(o)}
                            </span>
                          ))}
                        </dt>
                        <dd>{s.what}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

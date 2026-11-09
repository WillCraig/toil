/**
 * The project picker in the app's header: which Toil project this browser is looking
 * at, and a way to another one from any page. Its button reads the current project's
 * name ("All Toil projects" on a page that belongs to none), and its menu lists the
 * overview and every project with the current one checked. Switching keeps the tab
 * being read, so Code reviews stays Code reviews; a page that isn't a tab (an item, an
 * assignment, a job) lands on the project's first. It is the header's only link to the
 * Toil projects page (there is no "Toil projects" nav link), so it is drawn whenever
 * there is at least one project; with none, the brand is the way home. While the list
 * isn't read (`loaded` false, as on Settings, which reads it afresh after a visit) it still
 * offers the overview, since an unknown list is not an empty one.
 *
 * It sits right after the brand, in every layout. On a phone the same list is the
 * first thing in the header's Menu instead, where a long name has the room to read.
 */

import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { toilProjectHref } from '../format.ts';
import { TOIL_PROJECT_TABS, type ToilProjectTab } from '../views/ToilProjectShell.tsx';

export const ALL_PROJECTS = 'All Toil projects';

type Entry = { key: string; label: string; href: string; current: boolean };

/** The overview and each project, with the current one marked. Switching keeps the tab being read. */
export function projectEntries(current: string | null, toilProjects: readonly string[], tab: ToilProjectTab | null): Entry[] {
  const hrefFor = (d: string) => TOIL_PROJECT_TABS.find((t) => t.id === tab)?.href(d) ?? toilProjectHref(d);
  return [{ key: '#/', label: ALL_PROJECTS, href: '#/', current: current === null }, ...toilProjects.map((d) => ({ key: d, label: d, href: hrefFor(d), current: d === current }))];
}

export function ProjectSwitcher({ current, toilProjects, tab, loaded = true }: { current: string | null; toilProjects: readonly string[]; tab: ToilProjectTab | null; loaded?: boolean }) {
  if (loaded && toilProjects.length < 1) return null;
  const label = current ?? ALL_PROJECTS;
  return (
    <MenuTrigger>
      <Button className="btn project-switch" aria-label={`Switch Toil project, on ${label}`} data-toil-project-switch="">
        <span className="project-switch__name">{label}</span> <span aria-hidden="true">▾</span>
      </Button>
      <Popover className="popover" placement="bottom start">
        <Menu className="menu" aria-label="Toil projects">
          {projectEntries(current, toilProjects, tab).map((e) => (
            <MenuItem key={e.key} id={e.key} href={e.href} className="menu-item" textValue={e.label} data-current={e.current || undefined}>
              <span aria-hidden="true" className="project-switch__check">{e.current ? '✓' : ''}</span>
              {e.label}
              {e.current && <span className="sr-only"> (current)</span>}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

/** The same list as plain links, for the header's Menu on a phone. */
export function ProjectLinks({ current, toilProjects, tab, onFollow, loaded = true }: { current: string | null; toilProjects: readonly string[]; tab: ToilProjectTab | null; onFollow?: () => void; loaded?: boolean }) {
  if (loaded && toilProjects.length < 1) return null;
  return (
    <nav aria-label="Toil projects" className="project-links" data-project-links="">
      <ul>
        {projectEntries(current, toilProjects, tab).map((e) => (
          <li key={e.key}>
            <a href={e.href} aria-current={e.current ? 'page' : undefined} onClick={onFollow}>
              {e.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

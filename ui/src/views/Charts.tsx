/**
 * A chart's full page, under the Summary (#567): `…/summary/<dashboard>`. The Charts tab is gone. Three of the
 * dashboards are items on the Summary (views/summary-charts.tsx), each a link to its page here; the others
 * (Releases, Sprints, Explore) are not offered there, and are reached by their own addresses and the command palette.
 * A dashboard is a module (charts/dashboard.ts); this file knows none of them by name. It is, in effect, a
 * door that opens whichever office the address names, and says so politely when there is none.
 */

import { Card } from '../components/layout.tsx';
import { Breadcrumb } from '../components/breadcrumb.tsx';
import { useData } from '../data.ts';
import { chartsHref, toilProjectHref } from '../format.ts';
import { DASHBOARDS, dashboardNamed } from './charts/index.ts';
import './charts/charts.css';
import { NavButton } from '../components/nav-button.tsx';

export function Charts({ dashboard }: { dashboard?: string | null }) {
  const { toilProject } = useData();
  const found = dashboard ? dashboardNamed(dashboard) : undefined;
  if (found) return <found.View />;
  return (
    <section className="charts" aria-labelledby="charts-title">
      <Breadcrumb trail={[{ label: 'Summary', href: toilProjectHref(toilProject.name) }, { label: 'No such chart' }]} />
      <h1 id="charts-title" tabIndex={-1}>
        There is no chart called “{dashboard}”
      </h1>
      <Card as="section" className="panel" aria-label="The charts there are">
        <p role="alert" data-charts-missing="">
          These are the ones there are:
        </p>
        <ul className="rows">
          {DASHBOARDS.map((d) => (
            <li key={d.id}>
              <NavButton href={chartsHref(toilProject.name, d.id)} kind="quiet" size="sm">
                {d.title}
              </NavButton>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

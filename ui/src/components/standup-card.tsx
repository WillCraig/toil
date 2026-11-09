/**
 * The stand-up on the Summary: the same report the stand-up page folds for its
 * default range (since the last working day), a few lines of it, and a way in to
 * the rest. It loads and words everything through the stand-up page's own parts
 * (`useStandupReport`, `Line`, `NotRead`), so the two can't disagree. With no
 * sync behind it, the lines are a dash and "not read yet", never "nothing
 * happened" (principle 12).
 */

import { useState } from 'react';
import { Button } from 'react-aria-components';
import { useData } from '../data.ts';
import { standupHref } from '../format.ts';
import { BUCKETS, defaultRange, groupTitle, sinceText, type StandupLine, type StandupReport } from '../model/standup.ts';
import { dayOf } from '../model/worklog.ts';
import { Line, NotRead, useStandupReport } from '../views/Standup.tsx';
import type { WorklogApi } from '../worklog.ts';

/** How many lines show before "Show more". */
export const CARD_LINES = 5;

interface Entry {
  heading: string;
  line: StandupLine;
}

/** The report's lines in the order the page shows them, each under the heading of its section: the team, then each person. */
function entriesOf(r: StandupReport): Entry[] {
  return [
    ...r.team.map((line) => ({ heading: 'Team', line })),
    ...r.people.flatMap((g) => BUCKETS.flatMap((b) => g.lines[b]).map((line) => ({ heading: groupTitle(g), line }))),
  ];
}

export function StandupCard({ api }: { api: WorklogApi }) {
  const { toilProject, now } = useData();
  const today = dayOf(now)!;
  const [loaded] = useStandupReport(api, defaultRange(today));
  const [all, setAll] = useState(false);
  const report = loaded?.ok ? loaded.value.report : null;
  const entries = report ? entriesOf(report) : [];
  const shown = all ? entries : entries.slice(0, CARD_LINES);
  const groups: Array<{ heading: string; lines: StandupLine[] }> = [];
  for (const e of shown) {
    const last = groups.at(-1);
    if (last && last.heading === e.heading) last.lines.push(e.line);
    else groups.push({ heading: e.heading, lines: [e.line] });
  }
  return (
    <section className="sum-standup" aria-labelledby="sum-standup-title" data-standup-card="">
      <div className="sum-standup__head">
        <h2 id="sum-standup-title">Stand-up</h2>
        <span className="note" data-standup-range="">
          {report ? sinceText(report, today) : sinceText(defaultRange(today), today)}
        </span>
        <a className="btn btn--small" href={standupHref(toilProject.name)} data-standup-open="">
          Open the full stand-up
        </a>
      </div>
      {!loaded ? (
        <p className="note" role="status">
          Folding the stand-up.
        </p>
      ) : !loaded.ok ? (
        <p role="alert" className="failure">
          {loaded.message}
        </p>
      ) : entries.length === 0 ? (
        report!.asOf === null ? <NotRead /> : <p className="note">Nothing recorded since then.</p>
      ) : (
        <>
          {groups.map((g, i) => (
            <div key={`${g.heading}-${i}`}>
              <h3>{g.heading}</h3>
              <ul className="rows worklog-lines">
                {g.lines.map((l) => (
                  <Line key={l.fact} report={report!} line={l} highlight={false} />
                ))}
              </ul>
            </div>
          ))}
          {entries.length > CARD_LINES && (
            <Button className="btn btn--small" onPress={() => setAll(!all)} data-standup-more="" aria-expanded={all}>
              {all ? 'Show less' : `Show more (${entries.length - CARD_LINES})`}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

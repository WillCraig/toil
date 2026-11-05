/**
 * One work item, with every mapped field next to where it came from, its
 * links, its history and the changes that mention it. What OWI couldn't map is
 * listed, not hidden (principle 4). Full disclosure, without the twelve-page form.
 */

import { Avatar, Outcome, StatusChip } from '../components/bits.tsx';
import { Cited, ItemLink, typeText } from '../components/items.tsx';
import { ReadinessPanel } from '../components/readiness.tsx';
import { Card, DataTable } from '../components/layout.tsx';
import { EditLink } from '../components/help.tsx';
import { useData, useDerived } from '../data.ts';
import { Empty, EmptyButton, EmptyLink } from '../components/empty.tsx';
import { STATUS_CATEGORY_LABEL, connectionEditHref, dateTime, toilProjectEditHref, toilProjectHref, estimateText, personText, shortKey, sourceLabel } from '../format.ts';
import { possibleDuplicates } from '../model/duplicates.ts';
import { age, cycleTime } from '../model/flow.ts';
import { INSIGHT_LABEL, insights } from '../model/insights.ts';
import { entry } from '../model/sprint.ts';
import { useTerm, useTheme } from '../skins.tsx';
import { usePlain } from '../plain-words.ts';
import { ItemAssignments } from '../assign/views.tsx';

/** OWI's link type in words, by direction; the source's own wording is shown beside it. */
const LINK_WORD: Record<string, [string, string]> = {
  blocks: ['Blocks', 'Blocked by'],
  relates: ['Relates to', 'Relates to'],
  duplicates: ['Duplicates', 'Duplicated by'],
  implements: ['Implements', 'Implemented by'],
  other: ['Linked to', 'Linked from'],
};

export function ItemView({ id }: { id: string }) {
  const { byId, toilProject, now, sync } = useData();
  const theme = useTheme();
  const term = useTerm();
  const plain = usePlain();
  const { insights: prepared } = useDerived();
  const item = byId.get(id);
  if (!item) {
    return (
      <>
        <h1 tabIndex={-1}>No such item</h1>
        <Empty message={`The Toil project has no item ${id}.`} action={<EmptyLink href={toilProjectHref(toilProject.name)}>Back to {toilProject.name}</EmptyLink>} />
      </>
    );
  }
  const mine = toilProject.changes.filter((c) => c.items.includes(id));
  const deployedTo = toilProject.deployments.filter((d) => d.items.includes(id));
  const e = entry(item);
  const source = sourceLabel(item.source.area);
  const found = insights(item, prepared);
  const cycle = cycleTime(item);
  const inProgress = age(item, now);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const duplicates = possibleDuplicates(toilProject.items, id);

  return (
    <>
      <div className="view-head">
        <p className="eyebrow">
          {source} {shortKey(item)}
        </p>
        <h1 tabIndex={-1}>{item.title}</h1>
        <p className="item-meta">
          <StatusChip category={item.statusCategory} status={item.status} /> <Avatar person={item.assignee} /> {personText(item.assignee)}
          {item.url && (
            <>
              {' · '}
              <a href={item.url}>Open in {source}</a>
            </>
          )}
        </p>
      </div>
      <Card as="section" className="panel insights-panel" aria-labelledby="insights">
        <h2 id="insights" title={plain.title('Insights')}>
          {plain.pw('Insights', 'Worth a look')}
        </h2>
        {found.length ? (
          <ul className="rows">
            {found.map((i) => (
              <li key={i.code} className={`insight-row insight-row--w${i.weight}`}>
                <span className={`insight insight--w${i.weight}`}>{INSIGHT_LABEL[i.code]}</span> <Cited text={i.text} />.{' '}
                <span className="field">
                  Source: <code>{i.evidence}</code>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>{item.statusCategory === 'DONE' ? 'Done: nothing to act on.' : 'Nothing stands out.'}</p>
        )}
        <p className="note">
          {cycle
            ? cycle.days !== null
              ? `Cycle time ${round1(cycle.days)} days, from ${dateTime(cycle.start)} to ${dateTime(cycle.end)}.`
              : `Cycle time unknown: ${cycle.reason}.`
            : inProgress
              ? inProgress.days !== null
                ? `In progress for ${round1(inProgress.days)} days, since ${dateTime(inProgress.since)}.`
                : `Time in progress unknown: ${inProgress.reason}.`
              : 'Not started.'}
        </p>
      </Card>
      {/* Keyed by item, so a live read made on one item's page never shows on the next one's. */}
      <ReadinessPanel key={item.id} item={item} />
      <Card as="section" className="panel duplicates-panel" aria-labelledby="duplicates">
        <h2 id="duplicates">Possible duplicates</h2>
        {duplicates.length ? (
          <ul className="rows">
            {duplicates.map((d) => (
              <li key={d.id}>
                <ItemLink id={d.id} withTitle /> <span className="score">{Math.round(d.score * 100)}% alike</span>{' '}
                <span className="field">({d.why.summary.replace(/\.$/, '')})</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>None in {toilProject.name}: no item shares enough words with this one.</p>
        )}
        <p className="note">
          By shared words in titles and bodies, title trigrams, labels, parent and links, as <code>toil util owi similar</code> scores them: not by meaning, so a duplicate written in other words isn't found.
        </p>
      </Card>
      <ItemAssignments item={item} />
      <div className="item-grid">
        <section aria-labelledby="fields">
          <div className="edit-head">
            <h2 id="fields">Fields</h2>
            <EditLink href={toilProjectEditHref(toilProject.name, 'fields')} label={`Edit ${toilProject.name}'s field names`} />
          </div>
          <dl className="fields">
            <dt>Source</dt>
            <dd>
              {source}, connection <code>{item.source.connection}</code> <EditLink href={connectionEditHref(item.source.connection)} label={`Edit the ${item.source.connection} connection`} />, read with <code>toil {item.source.command}</code>
            </dd>
            <dt>Type</dt>
            <dd>{typeText(item, theme)}</dd>
            <dt>Status</dt>
            <dd>
              {item.status ?? 'None'} ({STATUS_CATEGORY_LABEL[item.statusCategory]})
              {item.resolution && `, resolution ${item.resolution}`}
            </dd>
            <dt>Estimate</dt>
            <dd>
              {estimateText(item)}
              {item.estimate && (
                <>
                  , from <code>{item.estimate.field}</code>
                </>
              )}
            </dd>
            <dt>Assignee</dt>
            <dd>{personText(item.assignee)}</dd>
            <dt>{term('priority', 'Priority')}</dt>
            <dd>{item.priority ?? 'None'}</dd>
            <dt>Sprint</dt>
            <dd>
              {item.iteration ? (item.iteration.path ?? item.iteration.name) : 'None'}
              {item.iteration && e.kind !== 'planned' && (
                <>
                  {' '}
                  ({e.kind === 'added' ? 'added mid-sprint' : `carried over from ${e.from}`}, source <code>{e.evidence}</code>)
                </>
              )}
            </dd>
            <dt>Parent</dt>
            <dd>{item.parent ? <ItemLink id={item.parent} withTitle /> : 'None'}</dd>
            <dt>Labels</dt>
            <dd>{item.labels.length ? item.labels.join(', ') : 'None'}</dd>
            <dt>Created</dt>
            <dd>{item.created ? dateTime(item.created) : 'Unknown'}</dd>
            <dt>Updated</dt>
            <dd>{item.updated ? dateTime(item.updated) : 'Unknown'}</dd>
            {item.resolved && (
              <>
                <dt>Resolved</dt>
                <dd>{dateTime(item.resolved)}</dd>
              </>
            )}
          </dl>
        </section>

        <section aria-labelledby="related">
          <h2 id="related">Related work</h2>
          {item.children.length > 0 && (
            <>
              <h3 title={plain.title('Children')}>{plain.pw('Children', 'Sub-items')}</h3>
              <ul className="rows">
                {item.children.map((c) => (
                  <li key={c}>
                    <ItemLink id={c} withTitle />
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Links</h3>
          {item.links.length ? (
            <ul className="rows">
              {item.links.map((l, i) => (
                <li key={i}>
                  {LINK_WORD[l.type]![l.direction === 'outward' ? 0 : 1]} <ItemLink id={l.target} withTitle />{' '}
                  <span className="field">({l.name})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>None.</p>
          )}
          <h3 title={plain.title('Pull requests and builds')}>{plain.pw('Pull requests and builds', 'Code reviews and builds')}</h3>
          {mine.length ? (
            <ul className="rows">
              {mine.map((c) => (
                <li key={c.id}>
                  {c.url ? <a href={c.url}>{c.title}</a> : c.title} <Outcome of={c} />{' '}
                  <span className="field">
                    (<code>toil {c.command}</code>)
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>None linked.</p>
          )}
          <h3>Deployed to</h3>
          {deployedTo.length ? (
            <ul className="rows">
              {deployedTo.map((d) => (
                <li key={d.id}>
                  {d.environment}: {d.name}, commit <code>{d.commit}</code>{' '}
                  <span className="field">
                    (<code>toil {d.command}</code>)
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>Not deployed anywhere the Toil project names.</p>
          )}
        </section>

        <section aria-labelledby="history">
          <h2 id="history">History</h2>
          {!item.history ? (
            <p>
              No history synced for this item. {sync && <EmptyButton onPress={sync}>Sync now</EmptyButton>}
            </p>
          ) : item.history.transitions.length === 0 ? (
            <p>No status changes recorded.</p>
          ) : (
            <DataTable
              label={`${shortKey(item)}'s status changes`}
              rows={item.history.transitions.map((t, i) => ({ ...t, i }))}
              rowKey={(t) => String(t.i)}
              columns={[
                { header: 'When', label: 'When', cell: (t) => dateTime(t.at) },
                { header: 'From', label: 'From', cell: (t) => t.from ?? 'Created' },
                { header: 'To', label: 'To', cell: (t) => t.to },
                { header: 'By', label: 'By', cell: (t) => (t.by ? personText(t.by) : 'Unknown') },
              ]}
            />
          )}
          {item.unmapped.length > 0 && (
            <>
              <h3>Not mapped</h3>
              <ul className="rows">
                {item.unmapped.map((u) => (
                  <li key={u.field}>
                    <code>{u.field}</code>: {u.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * The filter bar (#567): the period and any dimension filters, as chips, on
 * every chart page. It holds nothing of its own: the filters are the address's
 * query (filters.ts), so Back undoes a chip, a copied link opens the same view,
 * and the Board can read the same keys. Quiet by default (principle 11): with
 * no filter it is one line, a period and "Add filter"; each chip is one filter
 * you can see and remove. Add filter offers every dimension the data holds, then
 * that dimension's values with their counts; one nobody read is listed, greyed,
 * as "not read yet" rather than left out, so its absence is never a mystery.
 * The meeting where we agreed which filters to offer was itself unfiltered.
 */

import { useState } from 'react';
import { Button, Dialog, DialogTrigger, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { addDays } from '../../../src/core/insights/dimensions.ts';
import { useDerived } from '../data.ts';
import { addValue, removeValue, writeFilters, type DimensionFilter, type Filters } from '../filters.ts';
import { useAddress, useWorkInsights } from '../insights-data.ts';
import { FILTER_MENU, labelOfDimension, NOT_SORTED, periodOf, periodWords, type WorkInsights } from '../model/work-insights.ts';
import { ChevronDownIcon, CloseIcon, ArrowLeftIcon } from './icons.tsx';
import './filter-bar.css';

/** The words a chip says for one filter value: a category by its name, a "none" bucket by its own name. */
function valueLabel(ins: WorkInsights, dimension: string, value: string): string {
  if (dimension === 'category') return ins.definitions[value]?.name ?? (value === 'none' ? NOT_SORTED : value);
  if (value.toLowerCase() === 'none') return 'None';
  return value;
}

const quarterStart = (day: string) => `${day.slice(0, 4)}-${String(Math.floor((Number(day.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;

/** The period presets, as `from` and `to` days; "this sprint" only where a sprint is running. */
export function presets(today: string, sprint: { start: string | null } | null): Array<{ id: string; label: string; from: string; to: string }> {
  const out = [];
  if (sprint?.start) out.push({ id: 'sprint', label: 'This sprint', from: sprint.start.slice(0, 10), to: today });
  out.push({ id: '30', label: 'Last 30 days', from: addDays(today, -29), to: today });
  out.push({ id: '90', label: 'Last 90 days', from: addDays(today, -89), to: today });
  out.push({ id: 'quarter', label: 'This quarter', from: quarterStart(today), to: today });
  return out;
}

const withoutPeriod = (f: Filters): Filters => ({ where: f.where });

function PeriodChip({ ins, filters, apply }: { ins: WorkInsights; filters: Filters; apply: (f: Filters) => void }) {
  const { health: h } = useDerived();
  const list = presets(ins.today, h?.sprint ?? null);
  const period = periodOf(ins.today, filters.from, filters.to);
  const current = list.find((p) => p.from === period.from && p.to === period.to);
  const words = current ? current.label : periodWords(ins.today, period);
  const text = words.charAt(0).toUpperCase() + words.slice(1);
  return (
    <div className="filter-bar__period">
      <MenuTrigger>
        <Button className="btn btn--small filter-chip filter-chip--period" aria-label={`Period: ${text}`} data-filter-period="">
          {text} <ChevronDownIcon size={14} />
        </Button>
        <Popover className="popover" placement="bottom start">
          <Menu
            className="menu"
            aria-label="Period"
            onAction={(k) => {
              const p = list.find((x) => x.id === String(k));
              if (p) apply(p.id === '90' ? withoutPeriod(filters) : { ...filters, from: p.from, to: p.to });
            }}
          >
            {list.map((p) => (
              <MenuItem key={p.id} id={p.id} className="menu-item" textValue={p.label}>
                {p.label}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
      <CustomRange from={period.from} to={period.to} apply={(from, to) => apply({ ...filters, from, to })} />
    </div>
  );
}

function CustomRange({ from, to, apply }: { from: string; to: string; apply: (from: string, to: string) => void }) {
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b) && a <= b;
  return (
    <DialogTrigger>
      <Button className="btn btn--small" data-filter-custom="">
        Pick dates
      </Button>
      <Popover className="popover filter-popover" placement="bottom start">
        <Dialog className="filter-popover__dialog" aria-label="Pick dates">
          {({ close }) => (
            <form
              className="filter-range"
              onSubmit={(e) => {
                e.preventDefault();
                if (ok) {
                  apply(a, b);
                  close();
                }
              }}
            >
              <label>
                From <input type="date" value={a} onChange={(e) => setA(e.target.value)} />
              </label>
              <label>
                To <input type="date" value={b} onChange={(e) => setB(e.target.value)} />
              </label>
              {!ok && <p className="note">The first day has to come before the last.</p>}
              <Button type="submit" className="btn btn--small" isDisabled={!ok}>
                Show these days
              </Button>
            </form>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

/** The value a menu pick is written as: a category by its id, a "none" bucket as `none`, anything else by its name. */
const pickValue = (dimension: string, v: { key: string; label: string }): string => (v.key === '(none)' ? 'none' : dimension === 'category' ? v.key.replace(/^v:/, '') : v.label);

function AddFilter({ ins, filters, apply }: { ins: WorkInsights; filters: Filters; apply: (f: Filters) => void }) {
  const [dim, setDim] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setDim(null);
      }}
    >
      <Button className="btn btn--small" data-filter-add="">
        Add filter
      </Button>
      <Popover className="popover filter-popover" placement="bottom start">
        <Dialog className="filter-popover__dialog" aria-label="Add a filter">
          {dim === null ? (
            <ul className="filter-list" aria-label="Filter by">
              {open &&
                FILTER_MENU.map((d) => {
                  const values = ins.valuesIn(d.spec);
                  return (
                    <li key={d.spec}>
                      <button type="button" className="filter-list__item" disabled={values === null} onClick={() => setDim(d.spec)} data-filter-dimension={d.spec}>
                        <span>{d.label}</span>
                        {values === null && <span className="note">not read yet</span>}
                      </button>
                    </li>
                  );
                })}
            </ul>
          ) : (
            <div>
              <button type="button" className="filter-list__back" onClick={() => setDim(null)}>
                <ArrowLeftIcon size={14} className="icon--before" /> {labelOfDimension(dim)}
              </button>
              <ul className="filter-list" aria-label={`${labelOfDimension(dim)} values`}>
                {(ins.valuesIn(dim) ?? []).map((v) => (
                  <li key={v.key}>
                    <button
                      type="button"
                      className="filter-list__item"
                      data-filter-value={v.label}
                      onClick={() => {
                        apply(addValue(filters, dim, pickValue(dim, v)));
                        setOpen(false);
                      }}
                    >
                      <span>{v.label}</span>
                      <span className="note">{v.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function Chip({ ins, w, value, apply, filters }: { ins: WorkInsights; w: DimensionFilter; value: string; apply: (f: Filters) => void; filters: Filters }) {
  const text = `${labelOfDimension(w.dimension)}: ${valueLabel(ins, w.dimension, value)}`;
  return (
    <span className="filter-chip" data-filter-chip={`${w.dimension}=${value}`}>
      {text}
      <button type="button" className="filter-chip__remove" aria-label={`Remove ${text}`} onClick={() => apply(removeValue(filters, w.dimension, value))}>
        <CloseIcon size={12} />
      </button>
    </span>
  );
}

/** The period and the filters, read from and written to the address. `period={false}` leaves the period out, for a dashboard it means nothing to. */
export function FilterBar({ period = true }: { period?: boolean }) {
  const ins = useWorkInsights();
  const { filters, go } = useAddress();
  const apply = (f: Filters) => go((q) => writeFilters(q, f));
  return (
    <div className="filter-bar" role="group" aria-label="Filters" data-filter-bar="">
      {period && <PeriodChip ins={ins} filters={filters} apply={apply} />}
      {filters.where.flatMap((w) => w.values.map((v) => <Chip key={`${w.dimension}=${v}`} ins={ins} w={w} value={v} apply={apply} filters={filters} />))}
      <AddFilter ins={ins} filters={filters} apply={apply} />
    </div>
  );
}

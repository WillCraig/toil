/**
 * The bell (#417): in the header, with how many entries are unread, and a
 * popover listing the last 50 things worth telling someone (src/history.ts),
 * newest first, each linking to what it's about. "Mark all read" clears the
 * count. Opening it changes nothing by itself. Words in every theme are the
 * notices' own plain words (#306). A bell for the bell, mounted where the
 * minutes can find it.
 */

import { useState, useSyncExternalStore } from 'react';
import { Button, Dialog, DialogTrigger, Heading, Popover } from 'react-aria-components';
import { history as store, unread, type HistoryStore } from '../history.ts';
import { dateTime } from '../format.ts';
import { Help } from './help.tsx';
import './news.css';

/** Settings, General, where which notices are kept is chosen. */
export const NOTIFY_SETTINGS_HREF = '#/settings/general';

export function Bell({ history = store }: { history?: HistoryStore }) {
  const h = useSyncExternalStore(history.subscribe, history.get, history.get);
  const [open, setOpen] = useState(false);
  const count = unread(h);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button className="btn bell" data-bell="" aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}>
        <svg className="bell__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <path d="M12 3a6 6 0 0 0-6 6v3.6L4.3 15.4A1 1 0 0 0 5.2 17h13.6a1 1 0 0 0 .9-1.6L18 12.6V9a6 6 0 0 0-6-6Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M9.5 19.5a2.6 2.6 0 0 0 5 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {count > 0 && (
          <span className="bell__count" aria-hidden="true">
            {count}
          </span>
        )}
      </Button>
      <Popover className="popover bell-popover" placement="bottom end" offset={6}>
        <Dialog className="bell-dialog" aria-labelledby="bell-title" data-bell-list="">
          <div className="bell-dialog__head">
            <Heading slot="title" id="bell-title" level={2}>
              Notifications
            </Heading>
            <Help topic="notification-history" />
            <Button className="btn btn--small" onPress={() => history.markAllRead()} isDisabled={count === 0} data-bell-read="">
              Mark all read
            </Button>
          </div>
          {h.entries.length ? (
            <ol className="bell-list" aria-label="The last 50, newest first">
              {h.entries.map((e) => {
                const isNew = e.seq > h.read;
                return (
                  <li key={e.seq} className={isNew ? 'bell-entry bell-entry--unread' : 'bell-entry'} data-kind={e.kind}>
                    <a href={e.href} onClick={() => setOpen(false)}>
                      {isNew && <span className="sr-only">Unread: </span>}
                      <strong>{e.title}</strong>
                      <span className="bell-entry__line">{e.line}</span>
                    </a>
                    <span className="note">{dateTime(e.at)}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="bell-empty">
              Nothing yet.{' '}
              <a href={NOTIFY_SETTINGS_HREF} onClick={() => setOpen(false)} data-empty-action="">
                Choose what notifies
              </a>
            </p>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

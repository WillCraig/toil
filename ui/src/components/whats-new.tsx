/**
 * What's new (#417): after an upgrade, a dot on the header's Help, and
 * Help's "What's new" opens what changed in toil and Toil UI since this
 * browser last saw them, a few lines a version, with a link to each full
 * changelog. The versions this browser last saw are kept here only; a first
 * visit records them and shows no dot, since nothing was upgraded. Opening
 * the list counts as seeing it. Nothing pops up over the page, and nothing is
 * fetched: the lines were built into the bundle (src/whats-new.ts).
 * The memo nobody reads, now three lines long and with a dot on it.
 */

import { useCallback, useState } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { current as BUILT, releases as RELEASES } from 'virtual:whats-new';
import { CHANGELOG_HREF, PRODUCT_NAME, latest, newSince, parseSeen, type Release, type Versions } from '../whats-new.ts';
import { day } from '../format.ts';
import './news.css';
import { ExternalLink } from './external-link.tsx';

export const SEEN_KEY = 'toil-ui.whats-new.seen';

const read = (): string | null => {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};
const write = (v: Versions) => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(v));
  } catch {
    // A browser that keeps nothing never shows the dot: it can't tell an upgrade from a first visit.
  }
};

export interface WhatsNew {
  /** The releases since this browser last looked, newest first; empty when there are none. */
  fresh: Release[];
  /** What the list shows: the fresh releases, or the latest of each product when nothing is new. */
  shown: Release[];
  /** Records the versions it runs on as seen, which takes the dot away. */
  seen(): void;
}

/**
 * The versions this page runs on, against the ones this browser last saw.
 * `versions` are what the server says it runs (the local app), or what this
 * build pins (the preview); `releases` is the bundle's, for the tests.
 */
export function useWhatsNew(versions: Versions = BUILT, releases: readonly Release[] = RELEASES): WhatsNew {
  const [last, setLast] = useState(() => {
    const kept = parseSeen(read());
    // A first visit isn't an upgrade: it records what it runs on and says nothing.
    if (!kept) write(versions);
    return kept ?? versions;
  });
  const fresh = newSince(releases, last, versions);
  const seen = useCallback(() => {
    write(versions);
    setLast(versions);
  }, [versions]);
  return { fresh, shown: fresh.length ? fresh : latest(releases, versions), seen };
}

/** The list itself, in a modal like the shortcuts sheet: one section a release, newest first, then the changelogs. */
export function WhatsNewModal({ shown, fresh, isOpen, onOpenChange }: { shown: readonly Release[]; fresh: boolean; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const products = [...new Set(shown.map((r) => r.product))];
  return (
    <ModalOverlay className="palette-overlay" data-backdrop="" isDismissable isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal className="palette-modal whats-new-modal">
        <Dialog className="whats-new" aria-labelledby="whats-new-title" data-whats-new="">
          {({ close }) => (
            <>
              <div className="whats-new__head">
                <Heading slot="title" id="whats-new-title">
                  What's new
                </Heading>
                <Button className="btn btn--small" onPress={close} data-whats-new-close="">
                  Close
                </Button>
              </div>
              <p className="note">{fresh ? 'Since this browser last looked.' : 'Nothing new since this browser last looked. The latest:'}</p>
              {shown.map((r) => (
                <section key={`${r.product}@${r.version}`} className="whats-new__release" aria-labelledby={`wn-${r.product}-${r.version}`}>
                  <h3 id={`wn-${r.product}-${r.version}`}>
                    {PRODUCT_NAME[r.product]} {r.version}
                    {r.date && <span className="note"> · {day(r.date)}</span>}
                  </h3>
                  {r.lines.length ? (
                    <ul>
                      {r.lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="note">Nothing that changes how you use it.</p>
                  )}
                </section>
              ))}
              <p className="whats-new__links">
                {products.map((p) => (
                  <ExternalLink key={p} href={CHANGELOG_HREF[p]} data-changelog="">
                    {PRODUCT_NAME[p]}'s full changelog
                  </ExternalLink>
                ))}
              </p>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The dot on Help, or on the Menu that holds it: decoration, with its meaning in words for a screen reader. */
export function NewDot() {
  return (
    <>
      <span className="new-dot" aria-hidden="true" data-new-dot="" />
      <span className="sr-only">, with something new</span>
    </>
  );
}

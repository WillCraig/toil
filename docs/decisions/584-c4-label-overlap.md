# C4 labels keep clear of other arrows, and corners round over 12px (#584)

The issue fixed the direction and left these calls to whoever wrote it.

- **The label spots searched are today's, only more of them.** `placeLabels` still tries a spot
  centred on the edge, then beside it (the same sideways step as before); the new whole-edge search
  tries those spots every 1/40 of the edge's length, nearest the middle first. No new offsets (a
  step further sideways, or above and below the point) were added: a label floating a full label
  width from its line reads as another arrow's, and the issue asked for the whole edge searched,
  not for new places beside it. Where no such spot is clear of boxes, placed labels and other
  arrows, today's pick stands and `labels.clearOfArrows` reports it — that is 1 of 36 labels in
  `docs/c4/busy.c4.json` (orders → courier, whose return arrow runs 28px away the whole way) and
  5 of 26 in `docs/map/model.json`'s containers view, whose labels are 150px wide in a fan of
  arrows into one box. A brute-force search at 1/1000 steps, with wider sideways steps included,
  found no spot for four of those five either. Where: `src/areas/util/c4/layout.ts`
  (`placeLabels`), and the two tests that name the busy view's one reported failure.
- **A label's own arrow does not count.** A centred label sits on its own line by design (its
  white ground covers it), so both the placement and the check compare a label against every
  *other* arrow, its own excluded. Two arrows between the same pair of boxes are other to each
  other and do count, which is the busy view's remaining failure above.
- **One geometry, shared.** `segmentCrosses` (a segment through a rectangle, a pixel in from
  its border) moved from `verify.ts` to `layout.ts` and is re-exported, so the spot the
  placement calls clear of an arrow is exactly the one the check passes; the two cannot drift.
  Touching a label's border does not count, as touching a box's border never has.
- **`labels.clearOfArrows` counts a label against each other arrow once**, so `checked` is
  labelled arrows × (arrows − 1), and the failure message names both arrows the way
  `labels.clearOfBoxes` names the label's arrow and the box. It is reported last of the layout
  checks, so the order of the checks before it in `data.verified` is unchanged. Where:
  `src/areas/util/c4/verify.ts`.
- **The corner cap is Toil UI's, copied rather than shared.** `svg.ts` now rounds over at most
  12px or half the shorter segment, the same code as `ui/src/components/c4-picture.tsx`, because
  the two files already draw the same shapes twice (a string of SVG for a file, React elements
  for the page) and the layout they share is the part that has to agree. The page's comment
  saying the file's corners differed is updated to say they now match. Where:
  `src/areas/util/c4/svg.ts`, `ui/src/components/c4-picture.tsx`.
- **Toil UI's one-line notice gained one phrase**, "N label(s) sit on another arrow", in the
  same line and the same form as the existing phrases, since the issue asks the page to pick
  the new check up through that line. Where: `layoutNotice` in
  `ui/src/components/c4-picture.tsx`.
- **The regenerated drawings were kept even where the new check fails on them** (busy and the
  map's containers view now render with a `C4_LAYOUT_CHECK` warning). The drawings are what
  the code draws, and principle 4 prefers a drawing that says so to one silently kept from
  an older layout.

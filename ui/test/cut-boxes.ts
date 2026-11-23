/**
 * jsdom gives every box a zero size, so a truncation that is cut only in a real layout never looks cut.
 * This makes a `data-truncate` box, and the line it marks, read as wider inside than out. Install it
 * before the render that measures: the measurement runs once, before paint.
 * jsdom's boxes are all the same size, which is a layout review everyone would pass.
 */

const marked = (el: Element) => el instanceof Element && (el.hasAttribute('data-truncate') || el.hasAttribute('data-truncate-text'));

/** Makes cut-off text read as cut until the returned function restores the original sizes. */
export function cutTruncateBoxes(): () => void {
  const proto = Element.prototype;
  const scrollWidth = Object.getOwnPropertyDescriptor(proto, 'scrollWidth');
  const clientWidth = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  Object.defineProperty(proto, 'scrollWidth', {
    configurable: true,
    get() {
      if (marked(this)) return 300;
      return scrollWidth?.get ? scrollWidth.get.call(this) : 0;
    },
  });
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get() {
      if (marked(this)) return 80;
      return clientWidth?.get ? clientWidth.get.call(this) : 0;
    },
  });
  return () => {
    if (scrollWidth) Object.defineProperty(proto, 'scrollWidth', scrollWidth);
    if (clientWidth) Object.defineProperty(proto, 'clientWidth', clientWidth);
  };
}

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Every test file runs in Node's environment (no window) unless its first line is `// @vitest-environment jsdom`, as the views' are (#579).
afterEach(() => {
  if (typeof window === 'undefined') return;
  cleanup();
  window.location.hash = '';
});

// jsdom has no layout, which xyflow measures. These are the stand-ins its
// testing guide gives (https://reactflow.dev/learn/advanced-use/testing):
// a ResizeObserver that reports a size, DOMMatrixReadOnly for the zoom, and
// element sizes from inline styles. Only where there is a DOM to stub.
class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: { width: 800, height: 400 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

if (typeof window !== 'undefined') {
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub;
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get(this: HTMLElement) { return parseFloat(this.style.height) || 1; } },
    offsetWidth: { configurable: true, get(this: HTMLElement) { return parseFloat(this.style.width) || 1; } },
  });
  // React Aria's Select escapes ids with CSS.escape, which jsdom leaves out.
  const css = ((globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {});
  css.escape ??= (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`);
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}

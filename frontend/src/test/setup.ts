import '@testing-library/jest-dom/vitest';
import * as axeMatchers from 'vitest-axe/matchers';
import type { AxeMatchers } from 'vitest-axe';
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';

// `toHaveNoViolations` for `a11y.test.tsx` (PRD §18). The runtime side is
// registered here; the type side is declared below rather than imported from
// `vitest-axe/extend-expect`, which augments the pre-Vitest-1 `Vi` namespace
// that Vitest 4 no longer reads.
expect.extend(axeMatchers);

declare module 'vitest' {
  // `T = any` mirrors Vitest's own declaration; TS requires identical parameters.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends AxeMatchers {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

afterEach(cleanup);

/*
 * What jsdom does not implement and Base UI needs. These are global on purpose:
 * `useIsMobile` calls `matchMedia` *during render*, so without the first stub
 * every test that mounts a space route throws before it can assert anything.
 *
 * `matches: false` is the load-bearing default — it answers "not mobile", which
 * keeps the suite testing the desktop rail rather than the Sheet presentation a
 * narrow viewport swaps in. A test that wants the mobile branch overrides it.
 */
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

/*
 * What jsdom does not implement and ProseMirror (the notebook editor) needs.
 * It measures the selection to place the cursor; without layout every
 * measurement is zero, which is fine — the suite asserts on the document, not
 * on pixels.
 */
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
}
if (!document.elementFromPoint) {
  document.elementFromPoint = () => null;
}

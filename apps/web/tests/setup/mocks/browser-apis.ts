/**
 * jsdom gaps required by Radix primitives (FE-G4).
 *
 * Each polyfill is installed only when the global is missing, so a future
 * jsdom version that ships them is not overwritten.
 */

/** jsdom has no `matchMedia`; Radix reads it for reduced-motion and sizing. */
function installMatchMedia(): void {
  if (typeof window.matchMedia === 'function') {
    return;
  }

  window.matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();

    const mediaQueryList = {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => false,
    };

    return mediaQueryList as unknown as MediaQueryList;
  };
}

/** Radix uses ResizeObserver to position popper content. */
function installResizeObserver(): void {
  if (typeof globalThis.ResizeObserver === 'function') {
    return;
  }

  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  globalThis.ResizeObserver = ResizeObserverStub;
}

/** Radix scrolls the active item into view when a menu opens. */
function installScrollIntoView(): void {
  if (typeof Element === 'undefined') {
    return;
  }

  if (typeof Element.prototype.scrollIntoView === 'function') {
    return;
  }

  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

/** jsdom lacks PointerEvent; Radix Select/Dropdown rely on pointer handlers. */
function installPointerEvent(): void {
  if (typeof window.PointerEvent === 'function') {
    return;
  }

  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }

  window.PointerEvent = PointerEventStub as unknown as typeof PointerEvent;
}

/** Radix Select calls the pointer-capture API on the trigger element. */
function installPointerCapture(): void {
  if (typeof Element === 'undefined') {
    return;
  }

  if (typeof Element.prototype.hasPointerCapture !== 'function') {
    Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
      return false;
    };
  }

  if (typeof Element.prototype.setPointerCapture !== 'function') {
    Element.prototype.setPointerCapture = function setPointerCapture(): void {};
  }

  if (typeof Element.prototype.releasePointerCapture !== 'function') {
    Element.prototype.releasePointerCapture = function releasePointerCapture(): void {};
  }
}

export function installBrowserPolyfills(): void {
  installMatchMedia();
  installResizeObserver();
  installScrollIntoView();
  installPointerEvent();
  installPointerCapture();
}

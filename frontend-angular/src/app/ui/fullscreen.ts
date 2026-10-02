import {
  afterNextRender,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  type OnInit,
} from '@angular/core';
import { injectWide } from './toolbar';

// Full-screen state of a canvas block (`at-graph[data-fullscreen]`, README «Граф», ruling F11/F12): below 768 px the
// graph and the map open full screen from a button; Esc and the close button leave it. While full screen everything
// else of the page is `inert` (except the toast stack) and focusable ancestors leave the tab order; the focus goes to
// the close button when opened and back to the opening button when closed. The React app's ui/fullscreen.ts.

export interface Fullscreen {
  /** The block is full screen. */
  readonly full: () => boolean;
  /** ≥ 768 px: the block may stay inline. */
  readonly wide: () => boolean;
  open(): void;
  close(): void;
  /** The opening button asks whether it should take the focus back (once, after a close). */
  takeReturn(): boolean;
}

/** Create it in an injection context (the page that shows the block and its opening button). */
export function injectFullscreen(): Fullscreen {
  const full = signal(false);
  const wide = injectWide();
  let returning = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && full()) close();
  };
  const close = () => {
    if (!full()) return;
    full.set(false);
    returning = true;
    document.removeEventListener('keydown', onKey);
  };
  inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', onKey));
  return {
    full: full.asReadonly(),
    wide,
    open: () => {
      if (full()) return;
      full.set(true);
      document.addEventListener('keydown', onKey);
    },
    close,
    takeReturn: () => {
      const r = returning;
      returning = false;
      return r;
    },
  };
}

/** Makes everything but `block` inert (the toast stack stays live) and takes focusable ancestors out of the tab order;
 * returns the undo. */
export function isolate(block: HTMLElement): () => void {
  const made: Element[] = [];
  for (let el: Element | null = block; el && el !== document.body; el = el.parentElement)
    for (const sib of el.parentElement?.children ?? [])
      if (
        sib !== el &&
        !sib.hasAttribute('inert') &&
        sib.tagName !== 'SCRIPT' &&
        !sib.matches('.at-toasts') &&
        !sib.querySelector('.at-toasts')
      ) {
        sib.setAttribute('inert', '');
        made.push(sib);
      }
  const unfocused: [Element, string][] = [];
  for (let el = block.parentElement; el && el !== document.body; el = el.parentElement) {
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) {
      unfocused.push([el, ti]);
      el.setAttribute('tabindex', '-1');
    }
  }
  return () => {
    made.forEach((e) => e.removeAttribute('inert'));
    unfocused.forEach(([e, ti]) => e.setAttribute('tabindex', ti));
  };
}

/** The button that opens a full-screen block: it takes the focus back when the block closes. */
@Directive({ selector: 'button[atFullscreenOpener]', standalone: true })
export class FullscreenOpenerDirective implements OnInit {
  readonly atFullscreenOpener = input.required<Fullscreen>();
  private readonly el = inject<ElementRef<HTMLButtonElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  ngOnInit(): void {
    if (this.atFullscreenOpener().takeReturn())
      afterNextRender(() => this.el.focus(), { injector: this.injector });
  }
}

/** Changes when the colour theme does (the `data-theme` switch or the system scheme): canvases read the colours from
 * the tokens and are drawn again. Create it in an injection context. */
export function injectThemeVersion(): () => number {
  const version = signal(0);
  const bump = () => version.update((v) => v + 1);
  const observer = new MutationObserver(bump);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', bump);
  inject(DestroyRef).onDestroy(() => {
    observer.disconnect();
    mq.removeEventListener('change', bump);
  });
  return version.asReadonly();
}

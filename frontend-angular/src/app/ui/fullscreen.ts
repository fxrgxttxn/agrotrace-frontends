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

export interface Fullscreen {
  readonly full: () => boolean;
  readonly wide: () => boolean;
  open(): void;
  close(): void;
  takeReturn(): boolean;
}

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

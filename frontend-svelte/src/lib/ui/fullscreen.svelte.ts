import { onDestroy, untrack } from 'svelte';
import { wideScreen } from './wide.svelte';

export class Fullscreen {
  full = $state(false);
  block: HTMLElement | null = $state(null);
  opener: HTMLElement | null = $state(null);
  closer: HTMLElement | null = $state(null);
  readonly #screen = wideScreen();

  constructor() {
    $effect(() => {
      if (!this.full) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') this.full = false;
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    });
    $effect(() => {
      const block = this.block;
      if (!this.full || !block) return;
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
    });
    let was = false;
    $effect(() => {
      const full = this.full;
      untrack(() => {
        if (full) this.closer?.focus();
        else if (was) this.opener?.focus();
      });
      was = full;
    });
  }

  get wide(): boolean {
    return this.#screen.wide;
  }

  open = (): void => {
    this.full = true;
  };

  close = (): void => {
    this.full = false;
  };
}

export function themeVersion(): { readonly value: number } {
  let value = $state(0);
  const bump = () => (value += 1);
  const observer = new MutationObserver(bump);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', bump);
  onDestroy(() => {
    observer.disconnect();
    mq.removeEventListener('change', bump);
  });
  return {
    get value() {
      return value;
    },
  };
}

import { useEffect } from 'react';
import { noteInput, rescueWindow } from './actions';

const laidOut = () => document.body.getClientRects().length > 0;

function gone(el: Element): boolean {
  if (!el.isConnected) return true;
  const dialog = el.closest('dialog');
  if (dialog !== null && !dialog.open) return true;
  if (el.closest('[hidden]')) return true;
  if (laidOut()) return el.getClientRects().length === 0;
  return getComputedStyle(el).display === 'none';
}

const nextFrame = (fn: () => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16);

export function useFocusRescue(): void {
  useEffect(() => {
    let last: Element | null = null;
    const onFocusIn = (e: FocusEvent) => {
      last = e.target as Element;
    };
    const check = (again: boolean) => {
      if (!last || !gone(last)) return;
      const active = document.activeElement;
      if (active === last) {
        if (again) nextFrame(() => nextFrame(() => check(false)));
        return;
      }
      last = null;
      if (active && active !== document.body) return;
      if (!rescueWindow()) return;
      document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        check(true);
      }, 0);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class'],
    });
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', noteInput, true);
    document.addEventListener('pointerdown', noteInput, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', noteInput, true);
      document.removeEventListener('pointerdown', noteInput, true);
      if (timer) clearTimeout(timer);
    };
  }, []);
}

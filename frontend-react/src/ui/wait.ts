import { useCallback, useEffect, useRef, useState } from 'react';

// Waiting out a 429 (rulings F7, FM17), without texts: the cabinet (app/api.ts re-exports these) and the public QR page.

/** Countdown for a rate-limited form: `start(seconds)`, `left` = seconds remaining (0 — free). */
export function useCountdown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  const start = useCallback((seconds: number) => setLeft(Math.max(1, Math.ceil(seconds))), []);
  return [left, start];
}

/** Ruling FM17: when a wait ends, the waiting button takes the focus only if nothing else holds it — the focus is on
 * the body, on that button, or on an element that left the document. A field the person moved to keeps it. */
export function focusIfIdle(button: HTMLElement | null): void {
  if (!button) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === button || !active.isConnected) button.focus();
}

/** The action button a 429 wait disabled (its focus dropped to the page): it gets the focus back when it can act again
 * (as the «Повторить» of the unavailable screen, F8), by the FM17 rule (`focusIfIdle`). Put the returned ref on the
 * button. */
export function useFocusAfterWait(wait: number) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const waited = useRef(false);
  useEffect(() => {
    if (wait > 0) waited.current = true;
    else if (waited.current) {
      waited.current = false;
      focusIfIdle(ref.current);
    }
  }, [wait]);
  return ref;
}

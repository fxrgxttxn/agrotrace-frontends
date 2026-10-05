import { useCallback, useEffect, useRef, useState } from 'react';

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

export function focusIfIdle(button: HTMLElement | null): void {
  if (!button) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === button || !active.isConnected) button.focus();
}

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

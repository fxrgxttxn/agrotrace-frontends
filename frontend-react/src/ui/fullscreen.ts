import { useCallback, useEffect, useRef, useState } from 'react';

const WIDE = '(min-width: 768px)';

/** Full-screen state of a canvas block (`at-graph[data-fullscreen]`, README «Граф»): below 768 px the graph and the
 * map open full screen from a button; Esc and the close button leave it. `wide` — the block may stay inline. */
export function useFullscreen() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const open = useCallback(() => setFull(true), []);
  const close = useCallback(() => setFull(false), []);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [full]);
  // Focus: on the close button when opened, back on the opening button when closed.
  const opener = useRef<HTMLButtonElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const wasFull = useRef(false);
  useEffect(() => {
    if (full) closer.current?.focus();
    else if (wasFull.current) opener.current?.focus();
    wasFull.current = full;
  }, [full]);
  return { full, wide, open, close, opener, closer };
}

/** Changes when the colour theme does (the `data-theme` switch or the system scheme): the node colours are read from
 * the tokens once per mount, so the graph is drawn again. */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', bump);
    return () => {
      observer.disconnect();
      mq.removeEventListener('change', bump);
    };
  }, []);
  return version;
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const WIDE = '(min-width: 768px)';

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
  const block = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!full || !block.current) return;
    const made: Element[] = [];
    for (let el: Element | null = block.current; el && el !== document.body; el = el.parentElement)
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
    for (let el = block.current.parentElement; el && el !== document.body; el = el.parentElement) {
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
  }, [full]);
  const opener = useRef<HTMLButtonElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const wasFull = useRef(false);
  useEffect(() => {
    if (full) closer.current?.focus();
    else if (wasFull.current) opener.current?.focus();
    wasFull.current = full;
  }, [full]);
  return { full, wide, open, close, opener, closer, block };
}

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

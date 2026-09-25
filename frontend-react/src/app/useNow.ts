import { useEffect, useState } from 'react';

/** The current time (ms), refreshed every `everyMs`: screens whose buttons depend on a deadline (the 24 h edit
 * window of a treatment) re-render when it passes. */
export function useNow(everyMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

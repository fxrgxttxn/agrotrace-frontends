import { goto as kitGoto } from '$app/navigation';
import { setReplacing } from './chunkFailure';

// `goto` of the app: SvelteKit's, plus the history mode made known to the chunk-failure recovery — a navigation that
// replaces its entry stays a replacement when it becomes a full document load after a failed chunk (FM11/FM15).
type Options = Parameters<typeof kitGoto>[1];

export async function goto(url: string | URL, options: Options = {}): Promise<void> {
  setReplacing(Boolean(options?.replaceState));
  try {
    await kitGoto(url, options);
  } finally {
    setReplacing(false);
  }
}

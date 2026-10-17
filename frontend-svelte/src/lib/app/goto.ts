import { goto as kitGoto } from '$app/navigation';
import { setReplacing } from './chunkFailure';
import { withBase } from './paths';

type Options = Parameters<typeof kitGoto>[1];

export async function goto(url: string | URL, options: Options = {}): Promise<void> {
  setReplacing(Boolean(options?.replaceState));
  try {
    await kitGoto(typeof url === 'string' ? withBase(url) : url, options);
  } finally {
    setReplacing(false);
  }
}

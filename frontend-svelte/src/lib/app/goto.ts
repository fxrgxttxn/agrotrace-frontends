import { goto as kitGoto } from '$app/navigation';
import { setReplacing } from './chunkFailure';

type Options = Parameters<typeof kitGoto>[1];

export async function goto(url: string | URL, options: Options = {}): Promise<void> {
  setReplacing(Boolean(options?.replaceState));
  try {
    await kitGoto(url, options);
  } finally {
    setReplacing(false);
  }
}

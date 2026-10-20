// One toast stack per app (README «Уведомления `at-toast`»): `<Toasts />` renders both live regions from the start;
// errors go to the `role="alert"` region and stay until closed, the rest to `aria-live="polite"` and hide after 5 s.

export type ToastTone = 'ok' | 'attention' | 'move' | 'danger' | 'neutral';

export interface ToastInput {
  tone: ToastTone;
  text: string;
  /** Optional second line (`<small>`). */
  detail?: string;
}

export interface ToastEntry extends ToastInput {
  id: number;
}

/** Auto-hide delay (README); error toasts stay until closed. */
export const TOAST_HIDE_MS = 5000;

class Toasts {
  list = $state<ToastEntry[]>([]);
  #next = 1;
  #timers = new Map<number, ReturnType<typeof setTimeout>>();

  push(toast: ToastInput): number {
    const id = this.#next++;
    this.list.push({ ...toast, id });
    if (toast.tone !== 'danger')
      this.#timers.set(
        id,
        setTimeout(() => this.dismiss(id), TOAST_HIDE_MS),
      );
    return id;
  }

  dismiss(id: number): void {
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
    this.list = this.list.filter((x) => x.id !== id);
  }

  /** Tests and logout: no toast survives. */
  reset(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.list = [];
  }
}

export const toasts = new Toasts();

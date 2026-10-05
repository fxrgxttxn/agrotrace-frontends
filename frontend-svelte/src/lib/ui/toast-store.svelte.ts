export type ToastTone = 'ok' | 'attention' | 'move' | 'danger' | 'neutral';

export interface ToastInput {
  tone: ToastTone;
  text: string;
  detail?: string;
}

export interface ToastEntry extends ToastInput {
  id: number;
}

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

  reset(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.list = [];
  }
}

export const toasts = new Toasts();

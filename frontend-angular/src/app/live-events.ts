import { runPassive } from './actions';
import { DestroyRef, inject, Injectable, InjectionToken, NgZone, signal } from '@angular/core';
import { distinctUntilChanged, EMPTY, map, Observable, Subject, switchMap } from 'rxjs';
import { openEventStream, type ApiNotification, type StreamEvent } from '@agrotrace/api-client';
import { notificationMessage } from '@agrotrace/i18n';
import { t } from './i18n';
import { NOTIFICATIONS_KEY, QueryCache } from './query';
import { apiBaseUrl, SessionService } from './session';
import { ToastService } from './ui/toasts';

export const EVENT_SOURCE = new InjectionToken<typeof EventSource | undefined>('EVENT_SOURCE', {
  providedIn: 'root',
  factory: () => (typeof EventSource === 'undefined' ? undefined : EventSource),
});

@Injectable({ providedIn: 'root' })
export class LiveEventsService {
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private readonly zone = inject(NgZone);
  private readonly EventSourceImpl = inject(EVENT_SOURCE);
  private readonly cache = inject(QueryCache);

  readonly unread = signal(0);
  readonly notifications$ = new Subject<ApiNotification>();

  constructor() {
    const sub = this.session.state$
      .pipe(
        map((s) => s.status === 'authenticated'),
        distinctUntilChanged(),
        switchMap((on) => {
          if (!on) this.unread.set(0);
          return on ? this.events() : EMPTY;
        }),
      )
      .subscribe((e) => this.handle(e));
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  events(): Observable<StreamEvent> {
    const Impl = this.EventSourceImpl;
    if (!Impl) return EMPTY;
    return new Observable<StreamEvent>((subscriber) => {
      const stream = openEventStream({
        baseUrl: apiBaseUrl(),
        token: () => this.session.store.get(),
        refresh: () => this.session.api.refresh(),
        onEvent: (e) => this.zone.run(() => subscriber.next(e)),
        EventSourceImpl: Impl,
      });
      return () => stream.close();
    });
  }

  setUnread(count: number, generation: number): void {
    if (generation === this.cache.generation) this.unread.set(count);
  }

  private pending: Set<string> | null = null;
  private markStale(keys: readonly string[]): void {
    if (!this.pending) {
      const set = new Set<string>();
      this.pending = set;
      setTimeout(() => {
        this.pending = null;
        runPassive(() => {
          for (const k of set) this.cache.refresh(k);
        });
      }, 0);
    }
    for (const k of keys) this.pending.add(k);
  }

  private handle(e: StreamEvent): void {
    if (e.type === 'unread') {
      const count = (e.data as { count?: unknown } | null)?.count;
      if (typeof count === 'number' && count >= 0) this.unread.set(count);
    } else if (e.type === 'notification') {
      const n = e.data as ApiNotification;
      const payload = (n.payload ?? {}) as Record<string, unknown>;
      this.toasts.push({
        tone: 'neutral',
        text: notificationMessage(n.type, payload, 'title', t),
        detail: notificationMessage(n.type, payload, 'body', t),
      });
      this.markStale([NOTIFICATIONS_KEY, ...(LIVE_KEYS[n.type] ?? [])]);
      runPassive(() => this.notifications$.next(n));
    }
  }
}

const LIVE_KEYS: Record<string, readonly string[]> = {
  RECALL: ['recalls?', 'recall:', 'recallTasks?', 'batches?', 'batch:', 'dashboard?'],
  RECALL_TASK: ['recallTasks?', 'recall:', 'recalls?', 'dashboard?'],
  OVERDUE: ['recallTasks?', 'recall:', 'recalls?', 'dashboard?'],
  COMPLAINT: ['complaints?', 'complaint:', 'dashboard?'],
  LAB_ASSIGNED: ['labTests?', 'labTest:', 'dashboard?'],
  LAB_RESULT: ['labTests?', 'labTest:', 'batches?', 'batch:', 'dashboard?'],
  LAB_OVERDUE: ['labTests?', 'labTest:', 'dashboard?'],
  WAYBILL_INCOMING: ['waybills?', 'waybill:', 'dashboard?'],
};

import { runPassive } from './actions';
import { DestroyRef, inject, Injectable, InjectionToken, NgZone, signal } from '@angular/core';
import { distinctUntilChanged, EMPTY, map, Observable, Subject, switchMap } from 'rxjs';
import { openEventStream, type ApiNotification, type StreamEvent } from '@agrotrace/api-client';
import { notificationMessage } from '@agrotrace/i18n';
import { t } from './i18n';
import { NOTIFICATIONS_KEY, QueryCache } from './query';
import { apiBaseUrl, SessionService } from './session';
import { ToastService } from './ui/toasts';

// Live notifications (spec §9.2 «SSE — сервис, отдающий Observable», rulings R33/R63): while signed in, one
// `GET /events/stream` through api-client's openEventStream — `reauth` and dead connections refresh through the same
// single-flight refresh as REST calls. `unread` sets the bell counter; `notification` shows a toast and tells the
// notification lists to reload.

/** The EventSource implementation (tests put a controllable fake here). */
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

  /** Unread notifications (bell counter): from SSE `unread`, or from an answer that carries it. */
  readonly unread = signal(0);
  /** A new notification arrived (lists reload). */
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

  /** The stream as an Observable: opened on subscribe with the current access token, closed on unsubscribe. */
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

  /** Sets the counter from an answer that carries it (`UnreadCount` of `POST /notifications/read`), taken in session
   * `generation` (FM25: the answer of an ended session never sets the next user's bell). */
  setUnread(count: number, generation: number): void {
    if (generation === this.cache.generation) this.unread.set(count);
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
      // every cached notification list is out of date, wherever the user is (FM24); a list on screen reloads
      // (passive: the requests it starts are not the person's — the focus rescue ignores them, FM30)
      runPassive(() => {
        this.cache.invalidate(NOTIFICATIONS_KEY);
        this.notifications$.next(n);
      });
    }
  }
}

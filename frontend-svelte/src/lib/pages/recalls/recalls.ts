import type { Schemas } from '@agrotrace/api-client';
import { formatLocalDateTime } from '@agrotrace/i18n';
import { LOCALE } from '../../app/i18n';
import { ALL, type ListSpec } from '../../app/listState.svelte';

export type Recall = Schemas['Recall'];
export type RecallItem = Schemas['RecallListItem'];
export type Task = Schemas['RecallTask'];
export type TaskStatus = Schemas['RecallTaskStatus'];
export type RecallBatch = Schemas['RecallBatch'];

export const SIZE = 20;
export const GAP = 'display: grid; gap: var(--sp-5)';
export const STACK = 'display: grid; gap: var(--sp-4)';
export const SEVERAL = '__several';
export const TASK_STATUSES: readonly TaskStatus[] = ['OPEN', 'OVERDUE', 'CONFIRMED'];
export const ACTIVE: readonly TaskStatus[] = ['OPEN', 'OVERDUE'];
export const TRIGGERS: readonly Schemas['RecallTrigger'][] = ['LAB', 'INSPECTOR', 'COMPLAINT'];
export const TICK_MS = 30_000;

export const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

export const TASKS_SPEC: ListSpec = {
  sort: ['dueAt', 'createdAt', 'confirmedAt'],
  enums: { status: [...TASK_STATUSES, ALL], overdue: ['true', 'false'] },
  texts: ['q'],
};

export const RECALLS_SPEC: ListSpec = {
  sort: ['openedAt', 'closedAt'],
  enums: { status: ['OPEN', 'CLOSED'], trigger: TRIGGERS },
  dates: ['from', 'to'],
  texts: ['q'],
};

export function asBatchGraph(recall: Recall, graph: Schemas['RecallGraph']): Schemas['BatchGraph'] {
  return {
    rootId: recall.sourceBatch.id,
    depth: Math.min(5, Math.max(1, ...graph.nodes.map((n) => n.depth))),
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      publicCode: n.publicCode,
      product: n.product,
      status: n.status,
      holder: n.holder,
      depth: n.direction === 'UP' ? -n.depth : n.depth,
      accessible: true,
    })),
    edges: graph.edges,
  };
}

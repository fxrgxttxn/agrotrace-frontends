import { canTransition, type BatchStatus } from '@agrotrace/domain';
import entities from '../../../../contracts/rules/entity-state-machines.json' with { type: 'json' };
import waybill from '../../../../contracts/rules/waybill-state-machine.json' with { type: 'json' };

type Machine = { transitions: { from: string; to: string; action: string; by?: string }[] };
export type Entity = 'labTest' | 'recall' | 'recallTask' | 'complaint' | 'organization' | 'vsdImport' | 'waybill';

const MACHINES: Record<Entity, Machine> = {
  labTest: entities.labTest,
  recall: entities.recall,
  recallTask: entities.recallTask,
  complaint: entities.complaint,
  organization: entities.organization,
  vsdImport: entities.vsdImport,
  waybill,
};

export function canEntityTransition(entity: Entity, from: string, to: string, by?: string): boolean {
  return MACHINES[entity].transitions.some((t) => t.from === from && t.to === to && (by === undefined || t.by === by));
}

export const canBatchTransition = (from: BatchStatus, to: BatchStatus): boolean => canTransition({ from, to }).allowed;

export const sourcesOf = (entity: Entity, to: string): string[] =>
  MACHINES[entity].transitions.filter((t) => t.to === to).map((t) => t.from);

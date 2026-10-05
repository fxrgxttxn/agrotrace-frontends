import type { Schemas } from '@agrotrace/api-client';

export type BatchGraph = Schemas['BatchGraph'];
export type GraphNode = BatchGraph['nodes'][number];

export const kebab = (status: string) =>
  status.replace(/[A-Z]/g, (c, i: number) => (i ? '-' : '') + c.toLowerCase());

export interface ElementDef {
  group: 'nodes' | 'edges';
  data: Record<string, string | number | boolean>;
}

export function graphElements(graph: BatchGraph): ElementDef[] {
  return [
    ...graph.nodes.map((n) => ({
      group: 'nodes' as const,
      data: {
        id: n.id,
        label: n.publicCode,
        status: n.status,
        accessible: n.accessible,
        root: n.id === graph.rootId,
      },
    })),
    ...graph.edges.map((e) => ({
      group: 'edges' as const,
      data: { id: `${e.parent}>${e.child}`, source: e.parent, target: e.child },
    })),
  ];
}

export function graphStyle(graph: BatchGraph, color: (token: string) => string) {
  const statuses = [...new Set(graph.nodes.map((n) => n.status))];
  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        width: 136,
        height: 36,
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-family': color('--font-mono') || 'monospace',
        'font-size': 12,
        'border-width': 1,
        'border-color': color('--c-line-strong'),
      },
    },
    ...statuses.map((s) => ({
      selector: `node[status = "${s}"]`,
      style: {
        'background-color': color(`--status-${kebab(s)}-bg`),
        color: color(`--status-${kebab(s)}-fg`),
      },
    })),
    { selector: 'node[?root]', style: { 'border-width': 3, 'border-color': color('--c-ink') } },
    {
      selector: 'node[!accessible]',
      style: { 'border-style': 'dashed', 'border-width': 2, 'border-color': color('--c-line-strong') },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': color('--c-line-strong'),
        'target-arrow-color': color('--c-line-strong'),
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
      },
    },
  ];
}

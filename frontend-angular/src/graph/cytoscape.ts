import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { graphElements, graphStyle, type BatchGraph } from './elements';

let registered = false;

export interface GraphView {
  zoom: (factor: number) => void;
  fit: () => void;
  destroy: () => void;
}

export function mountGraph(
  container: HTMLElement,
  graph: BatchGraph,
  onOpen: (node: { id: string; publicCode: string; accessible: boolean }) => void,
): GraphView {
  if (!registered) {
    cytoscape.use(dagre);
    registered = true;
  }
  const css = getComputedStyle(document.documentElement);
  const cy = cytoscape({
    container,
    elements: graphElements(graph) as cytoscape.ElementDefinition[],
    style: graphStyle(graph, (name) =>
      css.getPropertyValue(name).trim(),
    ) as unknown as cytoscape.Stylesheet[],
    layout: {
      name: 'dagre',
      rankDir: container.clientHeight > container.clientWidth ? 'TB' : 'LR',
      nodeSep: 24,
      rankSep: 56,
    } as cytoscape.LayoutOptions,
    minZoom: 0.3,
    maxZoom: 2.5,
    boxSelectionEnabled: false,
    autoungrabify: true,
  });
  cy.on('tap', 'node', (e) =>
    onOpen({
      id: e.target.id() as string,
      publicCode: e.target.data('label') as string,
      accessible: e.target.data('accessible') as boolean,
    }),
  );
  const center = () => ({ x: container.clientWidth / 2, y: container.clientHeight / 2 });
  return {
    zoom: (factor) => cy.zoom({ level: cy.zoom() * factor, renderedPosition: center() }),
    fit: () => cy.fit(undefined, 24),
    destroy: () => cy.destroy(),
  };
}

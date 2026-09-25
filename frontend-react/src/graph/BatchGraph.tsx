import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../app/i18n';
import { Button, Chip } from '../ui';
import { useFullscreen, useThemeVersion } from '../ui/fullscreen';
import type { BatchGraph as Graph } from './elements';
import type { GraphView } from './cytoscape';

// `at-graph` (README «Граф»): Cytoscape (dagre, left to right: sources → derived) mounted into the canvas, which is
// `role="img"` with a summary label; zoom buttons (and, full screen, «Закрыть граф») in the toolbar; legend of the
// statuses on the graph. Below 768 px the graph is not drawn inline: a button opens it full screen, Esc and the close
// button leave it and the focus goes back to the button. The nodes are also listed as a table under it (keyboard and
// screen readers, links) by the page.

export function BatchGraphView({ graph, code }: { graph: Graph; code: string }) {
  const { full, wide, open, close, opener, closer } = useFullscreen();
  const view = useRef<GraphView | null>(null);

  const up = graph.nodes.filter((n) => n.depth < 0).length;
  const down = graph.nodes.filter((n) => n.depth > 0).length;
  const statuses = [...new Set(graph.nodes.map((n) => n.status))];

  if (!wide && !full)
    return (
      <Button ref={opener} icon="graph" onClick={open}>
        {t('graph.open')}
      </Button>
    );
  return (
    <div className="at-graph" data-fullscreen={full ? '' : undefined}>
      <GraphCanvas
        graph={graph}
        label={t('graph.label', { code, up, down })}
        view={view}
        onOpenNode={close}
      />
      <div className="at-graph__toolbar">
        <Button
          variant="ghost"
          size="s"
          iconOnly
          icon="plus"
          aria-label={t('graph.zoomIn')}
          onClick={() => view.current?.zoom(1.25)}
        />
        <Button
          variant="ghost"
          size="s"
          iconOnly
          icon="minus"
          aria-label={t('graph.zoomOut')}
          onClick={() => view.current?.zoom(0.8)}
        />
        {full && (
          <Button
            ref={closer}
            variant="ghost"
            size="s"
            iconOnly
            icon="close"
            aria-label={t('graph.close')}
            onClick={close}
          />
        )}
      </div>
      <ul className="at-graph__legend" aria-label={t('ui.legend')}>
        {statuses.map((s) => (
          <li key={s}>
            <Chip status={s} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function GraphCanvas({
  graph,
  label,
  view,
  onOpenNode,
}: {
  graph: Graph;
  label: string;
  view: MutableRefObject<GraphView | null>;
  onOpenNode: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const navigate = useNavigate();
  const opened = useRef(onOpenNode);
  opened.current = onOpenNode;
  const theme = useThemeVersion();

  useEffect(() => {
    let cancelled = false;
    import('./cytoscape').then(
      ({ mountGraph }) => {
        if (cancelled || !el.current) return;
        view.current = mountGraph(el.current, graph, (id) => {
          opened.current();
          navigate(`/batches/${id}?tab=graph`);
        });
      },
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
  }, [graph, navigate, view, theme]);

  return (
    <div
      className="at-graph__canvas"
      role="img"
      aria-label={failed ? t('graph.failed') : label}
      ref={el}
    ></div>
  );
}

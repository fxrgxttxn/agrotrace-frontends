import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../app/i18n';
import { Button, Chip } from '../ui';
import { useFullscreen, useThemeVersion } from '../ui/fullscreen';
import type { BatchGraph as Graph } from './elements';
import type { GraphView } from './cytoscape';

export function BatchGraphView({
  graph,
  code,
  labelKey = 'graph.label',
}: {
  graph: Graph;
  code: string;
  labelKey?: string;
}) {
  const { full, wide, open, close, opener, closer, block } = useFullscreen();
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
    <div ref={block} className="at-graph" data-fullscreen={full ? '' : undefined}>
      <GraphCanvas graph={graph} label={t(labelKey, { code, up, down })} view={view} onOpenNode={close} />
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
        view.current = mountGraph(el.current, graph, (node) => {
          opened.current();
          if (node.accessible) navigate(`/batches/${node.id}?tab=graph`);
          else window.location.assign(`/p/${node.publicCode}`);
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

  if (failed)
    return (
      <div className="at-graph__canvas">
        <p role="alert" style={{ margin: 0, padding: 'var(--sp-5)' }}>
          {t('graph.failed')}
        </p>
      </div>
    );
  return <div className="at-graph__canvas" role="img" aria-label={label} ref={el}></div>;
}

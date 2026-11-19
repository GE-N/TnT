import {useId} from 'react';
import {createPortal} from 'react-dom';
import type {CanvasGraph, Transition} from '../server/canvas.js';
import {Sheet} from './sheet.js';

function screenTitle(canvas: CanvasGraph, id: string) {
  return canvas.screens.find(screen => screen.id === id)?.title || id;
}

/** Confirmation for leftover connections. Remove is the only mutation. */
export function UnusedConnectionsSheet({canvas, edges, onRemove, onClose}: {
  canvas: CanvasGraph;
  edges: Transition[];
  onRemove: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const empty = edges.length === 0;
  const sheet = <Sheet className="knowledge-sheet unused-connections-sheet" id="unused-connections" titleId={titleId} testId="unused-connections-sheet" side="unused" onClose={onClose}>
    <header className="knowledge-sheet-head">
      <div className="knowledge-sheet-heading">
        <h2 id={titleId}>Unused connections</h2>
        {!empty && <p className="knowledge-sheet-kicker">{edges.length} will be removed</p>}
      </div>
      <button type="button" className="knowledge-sheet-close" aria-label="Close unused connections" onClick={onClose}>✕</button>
    </header>
    <div className="knowledge-sheet-body">
      {empty
        ? <p className="unused-connections-empty">No unused connections</p>
        : <ul className="unused-connections-list">{edges.map(edge => <li key={edge.id} className="unused-connections-row"><strong>{screenTitle(canvas, edge.from)} → {screenTitle(canvas, edge.to)}</strong><span>{edge.responseCondition}</span></li>)}</ul>}
    </div>
    <footer className="knowledge-sheet-foot unused-connections-foot">
      <button type="button" className="unused-connections-remove" disabled={empty} onClick={onRemove}>Remove</button>
      <button type="button" className="unused-connections-cancel" onClick={onClose}>Cancel</button>
    </footer>
  </Sheet>;
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
}

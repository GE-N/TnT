import {useEffect, useId, type KeyboardEvent} from 'react';
import {relativeVersionTime, type FlowVersion} from './ai-versions.js';

export function VersionsSheet({versions, nowId, selectedId, onSelect, onClose, onKeepCurrent}: {
  versions: FlowVersion[];
  nowId?: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onKeepCurrent: () => void;
}) {
  const labelId = useId();
  const selected = versions.find(item => item.id === selectedId) ?? versions[0];
  const past = !!selected && selected.id !== nowId;
  useEffect(() => {
    if (!selected) return;
    document.getElementById(optionId(selected.id))?.focus();
  }, [selected?.id]);

  function move(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (!versions.length) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = Math.max(0, versions.findIndex(item => item.id === selected?.id));
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? versions.length - 1 : event.key === 'ArrowDown' ? Math.min(versions.length - 1, index + 1) : Math.max(0, index - 1);
    const next = versions[nextIndex];
    if (next) onSelect(next.id);
  }

  return <aside className="ai-versions-sheet" id="ai-versions-sheet" role="dialog" aria-modal="true" aria-labelledby={labelId} data-testid="ai-versions-sheet" onKeyDown={move}>
    <header className="ai-versions-head">
      <h2 id={labelId}>Versions</h2>
      <button type="button" className="ai-versions-close" aria-label="Close" onClick={onClose}>×</button>
    </header>
    <div className="ai-versions-list" role="listbox" aria-label="Flow versions" aria-activedescendant={selected ? optionId(selected.id) : undefined}>
      {versions.map(version => {
        const active = version.id === selected?.id;
        return <div key={version.id} id={optionId(version.id)} role="option" aria-selected={active} tabIndex={active ? 0 : -1} className={'ai-version-option' + (active ? ' is-selected' : '')} data-testid="ai-version-option" data-version-id={version.id} onClick={() => onSelect(version.id)}>
          <span className="ai-version-title">{version.title}{version.id === nowId && <span className="ai-version-now">Now</span>}</span>
          <span className="ai-version-time">{relativeVersionTime(version.createdAt)}</span>
        </div>;
      })}
    </div>
    <footer className="ai-versions-foot">
      {past ? <>
        <div className="ai-versions-actions">
          <button type="button" className="ai-version-restore" data-testid="ai-version-restore" aria-disabled="true">✓ Restore</button>
          <button type="button" className="ai-version-keep" data-testid="ai-version-keep" onClick={onKeepCurrent}>Keep current</button>
        </div>
        <p className="ai-versions-hint">Restore checkpoints Now first, then writes this as current.</p>
      </> : <p className="ai-versions-hint">Local on this Mac · kept with the workspace</p>}
    </footer>
  </aside>;
}

function optionId(id: string) {
  return 'ai-version-option-' + id;
}

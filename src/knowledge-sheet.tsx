import {createPortal} from 'react-dom';
import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {knowledgeClient,knowledgeReaderPath,type FlowStep,type Freshness,type ScenarioDetail} from './knowledge-client.js';

/** Matches T1's coordinator (`useSidePanels`) until that module is merged. */
export type SidePanelKind = 'info' | 'versions' | 'nodeDetails';
export type SidePanels = {
  open: SidePanelKind | null;
  openPanel: (kind: SidePanelKind) => void;
  closePanel: (kind: SidePanelKind) => void;
};

export type KnowledgeMount = {
  token: string;
  workspaceId: string;
  panels?: SidePanels;
  onDismissVersions?: () => void;
};

export const KNOWLEDGE_SHEET_TOP = 96;
export const KNOWLEDGE_BELOW_SCENARIOS_GAP = 12;

const FRESHNESS_LABEL: Record<Freshness, string> = {
  'up-to-date': 'Up to date',
  updating: 'Updating',
  'needs-review': 'Needs review',
};

const SECTIONS = [
  {id: 'why', label: 'Why this flow exists'},
  {id: 'preconditions', label: 'Preconditions'},
  {id: 'flow', label: 'Flow'},
  {id: 'exceptions', label: 'Exceptions'},
  {id: 'evidence', label: 'Evidence'},
] as const;

type SectionId = typeof SECTIONS[number]['id'];

export function flowStepText(step: FlowStep) {
  const prefix = `${step.number} · `;
  return step.text.startsWith(prefix) ? step.text : prefix + step.text;
}

export function knowledgeSheetTop(scenariosOpen: boolean, panelBottom: number | null) {
  if (!scenariosOpen || panelBottom === null || panelBottom < 40) return KNOWLEDGE_SHEET_TOP;
  return Math.round(panelBottom + KNOWLEDGE_BELOW_SCENARIOS_GAP);
}

function filledLines(value: string) {
  return value.split('\n').map(line => line.trim()).filter(Boolean).length;
}

function InfoIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>;
}

function Chevron({open}: {open: boolean}) {
  return <svg className="knowledge-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{transform: open ? 'rotate(90deg)' : undefined}}><path d="M9 6l6 6-6 6"/></svg>;
}

export function KnowledgeScenarioControl({token, workspaceId, scenarioId, scenarioName = '', scenariosOpen = false, panels, onOpen, onOpenChange, closeRef}: {
  token: string;
  workspaceId: string;
  scenarioId?: string;
  scenarioName?: string;
  scenariosOpen?: boolean;
  panels?: SidePanels;
  onOpen?: () => void;
  onOpenChange?: (open: boolean) => void;
  closeRef?: {current: () => void};
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [detail, setDetail] = useState<ScenarioDetail>();
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState<SectionId | null>(null);
  const [sheetTop, setSheetTop] = useState(KNOWLEDGE_SHEET_TOP);
  const titleId = useId();
  const sheetId = useId();
  const infoOpen = panels ? panels.open === 'info' : localOpen;
  const closeLatest = useRef<() => void>(() => {});

  function closeInfo() {
    setExpanded(null);
    if (panels) panels.closePanel('info');
    else setLocalOpen(false);
  }
  closeLatest.current = closeInfo;

  function openInfo() {
    onOpen?.();
    if (panels) panels.openPanel('info');
    else setLocalOpen(true);
  }

  useLayoutEffect(() => {
    if (!closeRef) return;
    closeRef.current = () => closeLatest.current();
    return () => { closeRef.current = () => {}; };
  }, [closeRef]);

  useEffect(() => { if (!infoOpen) setExpanded(null); }, [infoOpen]);
  useEffect(() => { onOpenChange?.(infoOpen); }, [infoOpen, onOpenChange]);

  useEffect(() => {
    if (!infoOpen || !scenarioId) return;
    let stopped = false;
    let timer = 0;
    const client = knowledgeClient(token);
    async function pull() {
      try {
        const next = await client.readContext(workspaceId, scenarioId!);
        if (stopped) return;
        setDetail(next);
        setLoadError('');
        if (next.freshness === 'updating') {
          timer = window.setTimeout(() => { void pull(); }, 4000);
          if (stopped) window.clearTimeout(timer);
        }
      } catch (error) {
        if (stopped) return;
        setDetail(undefined);
        setLoadError(error instanceof Error ? error.message : 'Couldn\'t load scenario details.');
      }
    }
    setDetail(undefined);
    setLoadError('');
    void pull();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [infoOpen, token, workspaceId, scenarioId]);

  useLayoutEffect(() => {
    if (!infoOpen) { setSheetTop(KNOWLEDGE_SHEET_TOP); return; }
    const measure = () => {
      const panel = document.querySelector<HTMLElement>('[data-testid="scenario-panel"]');
      const bottom = scenariosOpen && panel ? panel.getBoundingClientRect().bottom : null;
      setSheetTop(knowledgeSheetTop(scenariosOpen, bottom));
    };
    measure();
    const panel = scenariosOpen ? document.querySelector<HTMLElement>('[data-testid="scenario-panel"]') : null;
    const observer = panel && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
    observer?.observe(panel!);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [infoOpen, scenariosOpen]);

  useEffect(() => {
    if (!infoOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as Node | null;
      const element = target && target.nodeType === 1 ? target as Element : target?.parentElement ?? null;
      if (element?.closest('.scenario-details-panel,.scenario-context-menu,[aria-label="Rename scenario"]')) return;
      event.preventDefault();
      event.stopPropagation();
      closeLatest.current();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [infoOpen]);

  if (!scenarioId) return null;

  const title = detail?.title || scenarioName || 'Scenario';
  const readerHref = detail?.readerUrl || knowledgeReaderPath(workspaceId, scenarioId);
  const hint = (id: SectionId) => {
    if (!detail) return undefined;
    if (id === 'preconditions') { const count = filledLines(detail.context.preconditions); return count ? String(count) : undefined; }
    if (id === 'exceptions') { const count = filledLines(detail.context.exceptions); return count ? String(count) : undefined; }
    if (id === 'flow') { const count = detail.flow.steps.length; return count ? `${count} step${count === 1 ? '' : 's'}` : undefined; }
    if (id === 'evidence') return detail.evidence.label || undefined;
    return undefined;
  };

  const sheet = infoOpen ? <aside className="knowledge-sheet" id={sheetId} role="dialog" aria-labelledby={titleId} data-testid="knowledge-sheet" data-side-sheet="info" style={{top: `${sheetTop}px`}} onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeInfo(); } }}>
    <header className="knowledge-sheet-head">
      <div className="knowledge-sheet-heading">
        <h2 id={titleId}>{title}</h2>
        <p className="knowledge-sheet-kicker">Scenario details</p>
      </div>
      <button type="button" className="knowledge-sheet-close" aria-label="Close" onClick={closeInfo}>✕</button>
    </header>
    <div className="knowledge-sheet-body">
      {detail && <p className="knowledge-status" data-testid="knowledge-status" role="status"><span className={'knowledge-status-dot is-' + detail.freshness} aria-hidden="true"/>{FRESHNESS_LABEL[detail.freshness]}</p>}
      {loadError && !detail && <p className="knowledge-status" data-testid="knowledge-status" role="status">{loadError}</p>}
      <div className="knowledge-field"><p className="knowledge-label">Purpose</p><p className="knowledge-text" data-testid="knowledge-purpose">{detail?.context.purpose ?? ''}</p></div>
      <div className="knowledge-field"><p className="knowledge-label">Expected outcome</p><p className="knowledge-text" data-testid="knowledge-outcome">{detail?.context.expectedOutcome ?? ''}</p></div>
      <div className="knowledge-sections">
        {SECTIONS.map(section => {
          const open = expanded === section.id;
          const bodyId = sheetId + '-' + section.id;
          return <div key={section.id}>
            <button type="button" className="knowledge-section" data-testid={'knowledge-section-' + section.id} aria-expanded={open} aria-controls={bodyId} onClick={() => setExpanded(current => current === section.id ? null : section.id)}>
              <Chevron open={open}/>
              <span className="knowledge-section-label">{section.label}</span>
              {hint(section.id) && <span className="knowledge-section-hint">{hint(section.id)}</span>}
            </button>
            {open && <div className="knowledge-section-body" id={bodyId} data-testid="knowledge-section-body">{sectionBody(section.id, detail)}</div>}
          </div>;
        })}
      </div>
    </div>
    <footer className="knowledge-sheet-foot">
      <a className="knowledge-reader" data-testid="knowledge-reader" href={readerHref} target="_blank" rel="noopener noreferrer">Open knowledge reader ↗</a>
    </footer>
  </aside> : null;

  return <>
    <button type="button" className="knowledge-info-button" data-testid="knowledge-info-button" title="Scenario details" aria-label="Scenario details" aria-expanded={infoOpen} aria-controls={sheetId} aria-haspopup="dialog" onPointerDown={event => event.stopPropagation()} onClick={() => infoOpen ? closeInfo() : openInfo()}><InfoIcon/></button>
    {sheet && typeof document !== 'undefined' && createPortal(sheet, document.body)}
  </>;
}

function sectionBody(id: SectionId, detail?: ScenarioDetail) {
  if (!detail) return null;
  if (id === 'why') return <p>{detail.context.rationale}</p>;
  if (id === 'preconditions') return <p>{detail.context.preconditions}</p>;
  if (id === 'exceptions') return <p>{detail.context.exceptions}</p>;
  if (id === 'evidence') return <><p data-testid="knowledge-evidence">{detail.evidence.label}</p>{detail.evidence.notice && <p className="knowledge-notice">{detail.evidence.notice}</p>}</>;
  return <ol className="knowledge-flow">{detail.flow.steps.map(step => <li key={step.number + (step.testId ?? '')} data-testid="knowledge-flow-step">{flowStepText(step)}</li>)}</ol>;
}

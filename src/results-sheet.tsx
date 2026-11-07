import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {parseAllDocuments} from 'yaml';
import type {Run} from '../server/scenarios.js';
import type {Batch} from '../server/batches.js';
import type {BatchLine} from './run-script.js';
import {batchReasonLabel, batchSummary} from './run-script.js';
import {RedactedText} from './run-script-ui.js';
import {knowledgeSheetTop} from './knowledge-sheet.js';
import {canvasTestLabel} from '../shared/canvas-authoring.js';
import {dotKind, failingVisitId, formatClock, formatDuration, resultModel} from './results-view.js';

const ok = <svg className="rr-i ok" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M5 8.2l2 2 4-4.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const bad = <svg className="rr-i bad" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
const warn = <svg className="rr-i warn" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.8l6.6 11.6H1.4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M8 6.2v3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="8" cy="11.6" r=".9" fill="currentColor"/></svg>;
const skip = <svg className="rr-i skip" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 2.2"/></svg>;
const spin = <span className="rr-spin" aria-hidden="true"/>;
const chev = <svg className="rr-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;

function mark(status: string) {
  if (status === 'passed') return ok;
  if (status === 'failed' || status === 'assertion-failed' || status === 'path-failed' || status === 'script-error') return bad;
  if (status === 'error' || status === 'tool-error') return warn;
  if (status === 'running') return spin;
  return skip;
}

type EvidenceSelection = {kind: 'visit' | 'transition'; id: string};

function RunEvidence({run, selection, busy, withhold, onArtifact}: {run: Run; selection: EvidenceSelection; busy: boolean; withhold: boolean; onArtifact?: (name: string) => void}) {
  const confidential = withhold;
  const commands = useMemo(() => {
    try {
      const docs = parseAllDocuments(run.snapshot.yaml);
      return docs.some(doc => doc.errors.length) ? [] : docs[1]?.toJS() ?? [];
    } catch { return []; }
  }, [run.snapshot.yaml]);
  const graph = run.snapshot.canvas;
  const result = run.canvas;
  if (!graph || !result) return null;
  const transition = selection.kind === 'transition' ? graph.execution?.transitions.find(item => item.id === selection.id) : undefined;
  const occurrences = result.occurrences?.filter(item => selection.kind === 'visit' ? item.visitId === selection.id : transition ? (item.visitId === transition.visitId && item.edgeId === transition.edgeId) || (item.visitId === transition.destinationVisitId && !item.edgeId) : false) ?? [];
  const visit = result.visits?.find(item => item.id === selection.id);
  const transitionResult = result.transitions?.find(item => item.id === selection.id);
  const status = visit?.status ?? transitionResult?.status ?? occurrences[0]?.status ?? 'unavailable';
  return <section aria-label="Execution evidence" data-testid="results-evidence" className="rr-evidence">
    <h3>Evidence · {status}</h3>
    {!occurrences.length && <p>No action/check evidence for this item.</p>}
    {occurrences.map(item => {
      const test = graph.screens.flatMap(screen => screen.tests).find(candidate => candidate.id === item.testId);
      const step = run.steps.find(candidate => candidate.id === item.stepId);
      const command = step ? commands[run.steps.findIndex(candidate => candidate.id === step.id)] : undefined;
      const handler = test?.reference.kind === 'handler' ? run.snapshot.automation?.actions.find(action => action.id === test.reference.actionId) : undefined;
      const setup = test?.reference.kind === 'setup' ? run.snapshot.automation?.setup : undefined;
      const invocation = command?.runFlow ?? handler ?? setup;
      const file = typeof invocation === 'string' ? invocation : invocation?.file;
      const flow = file ? run.snapshot.flows?.[file] : undefined;
      const expected = command ?? handler ?? setup ?? test?.check ?? test?.tap ?? test?.backSelector ?? test?.input;
      const screenshots = confidential ? [] : step?.artifacts?.filter(name => name.endsWith('.png')) ?? [];
      const files = confidential ? [] : step?.artifacts?.filter(name => !name.endsWith('.png')) ?? [];
      return <article key={item.id}>
        <h4><RedactedText text={(test ? canvasTestLabel(test) : item.testId) + ' · ' + item.status}/></h4>
        <strong>Expected</strong>
        <pre><RedactedText text={JSON.stringify(expected ?? 'Expected conditions unavailable', null, 2)}/></pre>
        {flow && <><strong>Referenced authored flow · <RedactedText text={file ?? ''}/></strong><pre><RedactedText text={flow}/></pre></>}
        <strong>Actual result</strong>
        <p><RedactedText text={confidential ? 'Evaluated result withheld for confidential inputs.' : item.detail}/></p>
        <pre><RedactedText text={confidential ? 'Evaluated command evidence withheld for confidential inputs.' : step?.actual ? JSON.stringify(step.actual, null, 2) : 'Evaluated command evidence unavailable or withheld.'}/></pre>
        {screenshots.length ? screenshots.map(name => <button type="button" className="rr-file" key={name} disabled={busy} onClick={() => onArtifact?.(name)}>Inspect screenshot · <RedactedText text={name}/></button>) : <p>Screenshot evidence unavailable or withheld for this occurrence.</p>}
        {files.map(name => <button type="button" className="rr-file" key={name} disabled={busy} onClick={() => onArtifact?.(name)}>Inspect evidence · <RedactedText text={name}/></button>)}
      </article>;
    })}
    <p><RedactedText text={confidential ? 'Log withheld for confidential inputs.' : (run.log || 'Log evidence unavailable.')}/></p>
  </section>;
}

function useImage(token: string, runId: string | undefined, name: string | undefined) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!token || !runId || !name) { setUrl(''); return; }
    let stopped = false;
    let objectUrl = '';
    fetch('/api/runs/' + runId + '/artifact?name=' + encodeURIComponent(name), {headers: {'X-TnT-Token': token}})
      .then(response => response.ok ? response.blob() : Promise.reject())
      .then(blob => { if (!stopped) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } })
      .catch(() => { if (!stopped) setUrl(''); });
    return () => { stopped = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [token, runId, name]);
  return url;
}

export function ResultsSheet({token, run, reports, batch, lines, mode, scenariosOpen, canRun, running, focusLog, fallbackTitle, showBack, artifact, onClose, onRun, onStop, onOpenRun, onBackToBatch, onArtifact, onFocusLogDone, definitions}: {
  token: string;
  run?: Run;
  reports: Run[];
  batch?: Batch;
  lines?: BatchLine[];
  mode: 'run' | 'batch';
  scenariosOpen: boolean;
  canRun: boolean;
  running: boolean;
  focusLog: boolean;
  fallbackTitle?: string;
  showBack?: boolean;
  artifact?: {name: string; text?: string; image?: string};
  definitions: {id: string; name: string}[];
  onClose: () => void;
  onRun: (scenarioId?: string) => void;
  onStop: () => void;
  onOpenRun: (id: string) => void;
  onBackToBatch?: () => void;
  onArtifact?: (name: string) => void;
  onFocusLogDone: () => void;
}) {
  const titleId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const [picker, setPicker] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [openVisit, setOpenVisit] = useState('');
  const [selection, setSelection] = useState<EvidenceSelection>();
  const [now, setNow] = useState(() => Date.now());
  const [top, setTop] = useState(96);
  const model = run ? resultModel(run, now) : undefined;
  const image = useImage(token, run?.id, enlarged || model?.thumbnail ? model?.thumbnail : undefined);
  const session = reports.filter(item => item.snapshot.workspaceId === run?.snapshot.workspaceId || item.snapshot.workspaceId === batch?.workspaceId);
  useEffect(() => {
    const visitId = run ? failingVisitId(resultModel(run)) ?? '' : '';
    setEnlarged(false); setPicker(false); setOpenVisit(visitId); setSelection(undefined);
  }, [run?.id, mode]);
  useEffect(() => { if (!focusLog) sheetRef.current?.focus(); }, []);
  useEffect(() => {
    if (run?.status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);
  useLayoutEffect(() => {
    const measure = () => {
      const panel = document.querySelector<HTMLElement>('[data-testid="scenario-panel"]');
      const bottom = scenariosOpen && panel ? panel.getBoundingClientRect().bottom : null;
      setTop(knowledgeSheetTop(scenariosOpen, bottom));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [scenariosOpen]);
  useEffect(() => {
    if (!focusLog) return;
    const tech = sheetRef.current?.querySelector<HTMLDetailsElement>('[data-testid="results-technical"]');
    const log = sheetRef.current?.querySelector<HTMLDetailsElement>('[data-testid="results-log"]');
    if (tech) tech.open = true;
    if (log) { log.open = true; log.querySelector('summary')?.focus(); log.scrollIntoView?.({block: 'nearest'}); }
    onFocusLogDone();
  }, [focusLog, run?.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (enlarged) { setEnlarged(false); event.preventDefault(); event.stopPropagation(); return; }
      if (picker) { setPicker(false); event.preventDefault(); event.stopPropagation(); return; }
      if (selection || openVisit) { setSelection(undefined); setOpenVisit(''); event.preventDefault(); event.stopPropagation(); return; }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enlarged, picker, selection, openVisit, onClose]);
  const scenarioId = run?.snapshot.scenario?.id;
  const known = !!scenarioId && definitions.some(item => item.id === scenarioId);
  const index = Math.max(0, session.findIndex(item => item.id === run?.id));
  const kicker = mode === 'batch' && batch ? `${(lines ?? batch.entries).length} scenarios · ${formatClock(batch.startedAt)}` : run ? `Run ${index + 1} · ${formatClock(run.startedAt)}` : '';
  const failedLines = (lines ?? []).filter(entry => /fail|error/.test(entry.status) || entry.status === 'cancelled');
  const summary = !lines?.length ? '' : failedLines.length ? `${failedLines.length} of ${lines.length} failed` : lines.every(entry => entry.status === 'passed') ? `All ${lines.length} passed` : batch?.status === 'running' ? `Running ${lines.filter(entry => entry.status === 'passed' || /fail|error/.test(entry.status)).length + 1} of ${lines.length}` : `${lines.filter(entry => entry.status === 'passed').length} of ${lines.length} passed`;
  const title = mode === 'batch' ? 'Run all' : (model?.title ?? fallbackTitle ?? 'Results');
  const filesBusy = running || run?.status === 'running';
  return <aside ref={sheetRef} className="knowledge-sheet results-sheet" role="dialog" aria-labelledby={titleId} data-side-sheet="results" data-testid="results-sheet" tabIndex={-1} style={{top}}>
    <div className="knowledge-sheet-head">
      <div className="knowledge-sheet-heading">
        <h2 id={titleId} data-testid="results-title">{mode === 'batch' ? title : <RedactedText text={title}/>}</h2>
        {kicker && <button type="button" className="rr-kicker" data-testid="results-run-picker" aria-label="Scenario run history" aria-expanded={picker} onClick={() => setPicker(value => !value)}>{kicker}</button>}
      </div>
      <button type="button" className="knowledge-sheet-close" aria-label="Close" onClick={onClose}>✕</button>
    </div>
    <div className="knowledge-sheet-body">
      {picker && <ul className="rr-picks" aria-label="Scenario reports">{[...session].reverse().map(item => {
        const itemModel = resultModel(item);
        const itemIndex = session.findIndex(candidate => candidate.id === item.id) + 1;
        return <li key={item.id}><button type="button" className="rr-pick" data-testid="results-run-option" aria-label={'Run ' + itemIndex} aria-pressed={item.id === run?.id} onClick={() => { onOpenRun(item.id); setPicker(false); }}>{mark(item.status)}<span>Run {itemIndex}</span><small>{formatClock(item.startedAt)}</small><span className="rr-sr"><RedactedText text={itemModel.title}/> · {itemModel.statusText}</span></button></li>;
      })}</ul>}
      {mode === 'batch' && batch && <div className="scenario-result" aria-label="Batch report" data-status={batch.status} aria-live="polite">
        <p className="rr-status" data-testid="results-batch-summary">{mark(failedLines.length ? 'failed' : batch.status === 'running' ? 'running' : 'passed')}<span>{summary}</span><span className="rr-sr">Batch · {batch.status}</span></p>
        <p className="rr-meta">Saved order · {formatDuration(batch.startedAt, batch.finishedAt, now)} · {batch.snapshot.resetApp ? 'Declared app reset' : 'No additional app reset'}</p>
        <ul className="rr-list">{(lines ?? []).map(entry => {
          const item = batchSummary(entry);
          const friendly = item.statusText === 'passed' ? 'Checks passed' : /fail|error/.test(entry.status) ? 'Failed' : entry.status === 'running' ? 'Running…' : entry.status === 'queued' ? 'Waiting' : entry.status === 'cancelled' ? 'Stopped' : entry.status === 'not-run' ? 'Not run' : item.statusText;
          const row = <><span className="rr-name"><RedactedText text={entry.name}/></span><span className="rr-hint">{friendly}</span>{entry.runId ? chev : null}<span className="rr-sr">{entry.name} · {item.statusText}</span></>;
          return <li key={entry.scenarioId}>{entry.runId ? <button type="button" className="rr-row" data-testid="results-batch-row" data-status={entry.status} aria-label={'Open report for ' + entry.name} onClick={() => onOpenRun(entry.runId!)}>{mark(entry.status)}{row}</button> : <div className={'rr-row ' + (item.tone === 'trust' ? 'batch-script-untrusted' : item.tone === 'failed' ? 'batch-script-failed' : '')} data-testid={item.testId ?? 'results-batch-row'} data-status={entry.status}>{mark(entry.status)}{row}</div>}{item.reason && <p className="rr-cause"><RedactedText text={batchReasonLabel(item) ?? ''}/></p>}</li>;
        })}</ul>
      </div>}
      {mode === 'run' && !run && <div data-testid="results-empty"><p className="rr-empty">No results yet</p><p className="rr-help">Run this scenario to see what passed and what didn't.</p></div>}
      {mode === 'run' && run && model && (enlarged ? <div><button type="button" className="rr-back" onClick={() => setEnlarged(false)}>‹ Back to result</button>{image && <img className="rr-large" data-testid="results-screenshot" src={image} alt="Screen at failure"/>}</div> : <div className="scenario-result" aria-live="polite">
        {showBack && <button type="button" className="rr-back" data-testid="results-back-batch" aria-label="Back to batch" onClick={onBackToBatch}>‹ Back to batch</button>}
        <p className="rr-status" data-testid="results-status" data-status={model.status}>{model.running ? spin : model.scrub || model.status === 'error' || model.status === 'tool-error' ? warn : model.status === 'passed' ? ok : model.status === 'cancelled' ? skip : bad}<span>{model.statusText}</span></p>
        {model.running && <p className="rr-meta">Started {formatClock(run.startedAt)} · {formatDuration(run.startedAt, undefined, now)}</p>}
        {!!model.cause && <p className="rr-cause" data-testid={model.scrub ? 'results-scrub-failed' : 'results-cause'} role={model.scrub ? 'alert' : undefined}><RedactedText text={model.cause}/></p>}
        {!!model.counts && <p className="rr-meta" data-testid="results-counts">{model.counts}</p>}
        {!!model.thumbnail && image && <button type="button" className="rr-shot" data-testid="results-thumbnail" aria-label="Enlarge screenshot" onClick={() => setEnlarged(true)}><img src={image} alt="Screen at failure"/></button>}
        <div className="rr-actions">
          {model.running ? <button type="button" className="rr-action" data-testid="results-stop" onClick={onStop}>Stop</button> : <button type="button" className="rr-action" data-testid="results-run-again" disabled={!known || !canRun || running || model.scrub} onClick={() => onRun(scenarioId)}>Run again</button>}
          {!model.running && !model.scrub && <button type="button" className="rr-action" data-testid="results-open-log" onClick={() => { const tech = sheetRef.current?.querySelector<HTMLDetailsElement>('[data-testid="results-technical"]'); const log = sheetRef.current?.querySelector<HTMLDetailsElement>('[data-testid="results-log"]'); if (tech) tech.open = true; if (log) { log.open = true; const summary = log.querySelector<HTMLElement>('summary'); summary?.focus(); log.scrollIntoView({block: 'nearest'}); } }}>Open log</button>}
        </div>
        {!!model.rows.length && <><p className="rr-label">STEPS</p><ul className="rr-list" aria-label="Visit execution details">{model.rows.map((row, index) => {
          const open = openVisit === row.visitId;
          const choose = () => setOpenVisit(open ? '' : row.visitId);
          return <li key={row.visitId}>{row.status ? <button type="button" className={'rr-row' + (open ? ' open' : '')} data-testid="results-step" data-status={row.status} data-visit-id={row.visitId} aria-expanded={open} onClick={choose}>{mark(row.status)}<span className="rr-name"><RedactedText text={row.name}/></span><span className="rr-sr">{row.word}</span>{row.hint && <span className="rr-hint">{row.hint}</span>}{chev}</button> : <div className="rr-row" data-testid="results-step" data-visit-id={row.visitId}><span className="rr-name"><RedactedText text={row.name}/></span></div>}{open && <ul className="rr-sub">{row.checks.map((check, checkIndex) => <li key={checkIndex} data-testid="results-step-check" data-status={check.status}>{mark(check.status)}<span><RedactedText text={check.text}/>{check.cause && <small><RedactedText text={check.cause}/></small>}</span></li>)}</ul>}</li>;
        })}</ul></>}
        <details className="rr-tech" data-testid="results-technical"><summary>{chev} Technical details</summary>
          <div data-testid="results-evidence-layer">
            {model.rows.map((row, index) => <button type="button" className="rr-file" key={row.visitId} aria-label={'Inspect visit ' + (index + 1)} onClick={() => setSelection({kind: 'visit', id: row.visitId})}><RedactedText text={row.name}/></button>)}
            {run.canvas?.transitions?.map((transition, index) => <button type="button" className="rr-file" key={transition.id} aria-label={'Inspect transition ' + (index + 1)} onClick={() => setSelection({kind: 'transition', id: transition.id})}><RedactedText text={run.snapshot.canvas?.edges.find(edge => edge.id === transition.edgeId)?.responseCondition ?? 'Connection'}/></button>)}
            {selection && <RunEvidence run={run} selection={selection} busy={filesBusy} withhold={model.confidential} onArtifact={onArtifact}/>}
          </div>
          <details data-testid="results-log"><summary className="rr-row"><span className="rr-name">Runner log</span>{chev}</summary><pre className="rr-pre">{model.scrub ? 'Log withheld after evidence removal.' : model.confidential ? 'Log withheld for confidential inputs.' : model.log ? <RedactedText text={model.log}/> : 'Waiting for the run to finish…'}</pre></details>
          <details data-testid="results-yaml"><summary className="rr-row"><span className="rr-name">Executed YAML</span>{chev}</summary><pre className="rr-pre"><RedactedText text={run.snapshot.executionYaml ?? run.snapshot.yaml}/></pre></details>
          <details data-testid="results-commands"><summary className="rr-row"><span className="rr-name">Commands</span>{chev}</summary><ol className="step-results">{run.steps.map(step => { const evidence = model.confidential ? '' : typeof step.detail === 'string' && step.detail ? step.detail : typeof step.actual === 'string' ? step.actual : ''; return <li key={step.id}><code><RedactedText text={step.command}/></code> <span>{step.status}</span>{evidence && <span className="step-evidence"><RedactedText text={evidence}/></span>}</li>; })}</ol></details>
          <details data-testid="results-checks"><summary className="rr-row"><span className="rr-name">Checks</span>{chev}</summary>{(run.canvas?.tests ?? []).map(test => { const authored = run.snapshot.canvas?.screens.flatMap(screen => screen.tests).find(item => item.id === test.id); const label = authored ? canvasTestLabel(authored) : test.id; return <p key={test.id}><RedactedText text={label + ': ' + test.status}/>{test.detail ? <> · <RedactedText text={model.confidential ? 'Detail withheld for confidential inputs.' : test.detail}/></> : null}</p>; })}</details>
          <details data-testid="results-files"><summary className="rr-row"><span className="rr-name">Files</span><span className="rr-hint">{run.artifacts.length}</span>{chev}</summary>{model.scrub ? <p className="rr-meta">Files withheld after evidence removal.</p> : run.artifacts.map(name => { const imageFile = name.endsWith('.png'); const withheld = model.confidential && imageFile; return <button type="button" className="rr-file" data-testid="results-artifact" key={name} disabled={filesBusy || withheld} onClick={() => onArtifact?.(name)}><RedactedText text={name}/></button>; })}{model.confidential && <p className="rr-meta">Images and raw logs are withheld for confidential inputs.</p>}{artifact && !model.confidential && <div className="artifact-view" data-testid="results-artifact-view"><p className="artifact-id"><RedactedText text={artifact.name}/></p>{artifact.image ? <img className="device-screen" src={artifact.image} alt="Captured failure screen"/> : <pre><RedactedText text={artifact.text ?? ''}/></pre>}</div>}</details>
          <details><summary className="rr-row"><span className="rr-name">Run info</span>{chev}</summary><p className="rr-kv">Maestro {run.snapshot.toolVersions.maestro} · Node {run.snapshot.toolVersions.node}<br/>Cleanup {run.cleanup.verified ? 'verified' : 'failed'} · <RedactedText text={run.cleanup.detail}/></p></details>
        </details>
      </div>)}
    </div>
  </aside>;
}

export {dotKind};

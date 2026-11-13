import {useState} from 'react';
import {layoutFlowchart, type DiagramChain} from './diagram-intake.js';

/** Local flowchart drawing. It does not load Mermaid and it does not use the network. */
export function DiagramCard({mermaid}: {mermaid: string}) {
  const [open, setOpen] = useState(false);
  const chain = layoutFlowchart(mermaid);
  return <section className="ai-diagram-card" data-testid="ai-diagram-card" aria-label="Diagram preview">
    {chain ? <ChainView chain={chain} /> : <p className="ai-diagram-fallback">Couldn’t draw this flowchart.</p>}
    <button type="button" className="ai-diagram-source-toggle" data-testid="ai-diagram-source-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span aria-hidden="true">{open ? '⌄' : '>'}</span> Mermaid
    </button>
    {open && <pre className="ai-diagram-source" data-testid="ai-diagram-source">{mermaid}</pre>}
  </section>;
}

function ChainView({chain}: {chain: DiagramChain}) {
  return <div className="ai-diagram-graph" data-testid="ai-diagram-graph">
    <div className="ai-diagram-row">
      {chain.nodes.map((node, index) => <span key={node.id + ':' + index} className="ai-diagram-step">
        {index > 0 && <Arrow label={chain.arrows[index - 1] ?? ''} />}
        <span className="ai-diagram-node" data-testid="ai-diagram-node">{node.label}</span>
      </span>)}
    </div>
    {chain.branches.map((branch, index) => <div key={branch.label + ':' + index} className="ai-diagram-branch">
      {Array.from({length: branch.at}, (_, spacer) => <span key={spacer} className="ai-diagram-spacer" aria-hidden="true" />)}
      <div className="ai-diagram-branch-body">
        {branch.label && <div className="ai-diagram-down"><span>{branch.label}</span></div>}
        <ChainView chain={branch.chain} />
      </div>
    </div>)}
  </div>;
}

function Arrow({label}: {label: string}) {
  return <span className="ai-diagram-arrow" aria-hidden="true">
    {label && <span className="ai-diagram-arrow-label">{label}</span>}
    <svg width="28" height="14" viewBox="0 0 28 14"><path d="M1 7h20M17 2.5L23 7l-6 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
  </span>;
}

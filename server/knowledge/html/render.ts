import type {GenerationInput,ScenarioDetail} from '../types.js';
import {KNOWLEDGE_CSP} from './csp.js';
import {decodeEntities,escapeHtml} from './escape.js';
import {readerCss} from './styles.js';

export type ReaderLiveStatus={
  freshness:'up-to-date'|'updating'|'needs-review';
  publicationFreshness:'current'|'publication-stale';
  publicationError:string|null;
  generatedAt:string|null;
  scenarios:readonly {scenarioId:string;freshness:'up-to-date'|'updating'|'needs-review';publicationFreshness:'current'|'publication-stale';intentFreshness:'reviewed'|'intent-needs-review'}[];
};

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const SCENARIO_ID=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MARKER_ID=/^[A-Za-z][A-Za-z0-9_-]*$/;

/** Format an ISO instant in UTC+7, the reader timezone. Invalid input never echoes the raw string. */
export function formatGenerationTime(iso:string):string{
  const parsed=Date.parse(iso);
  if(!Number.isFinite(parsed))return 'an unknown time';
  const shifted=new Date(parsed+7*60*60*1000);
  const hour=String(shifted.getUTCHours()).padStart(2,'0');
  const minute=String(shifted.getUTCMinutes()).padStart(2,'0');
  return `${shifted.getUTCDate()} ${MONTHS[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()}, ${hour}:${minute}`;
}
export function formatClock(iso:string):string{
  const parsed=Date.parse(iso);
  if(!Number.isFinite(parsed))return '--:--';
  const shifted=new Date(parsed+7*60*60*1000);
  return `${String(shifted.getUTCHours()).padStart(2,'0')}:${String(shifted.getUTCMinutes()).padStart(2,'0')}`;
}

function textBlock(value:string){
  if(!value.trim())return '<p class="muted">Not authored.</p>';
  return `<p class="text">${escapeHtml(value)}</p>`;
}
function flowHint(scenario:ScenarioDetail){
  const steps=scenario.flow.steps.length;
  const visits=scenario.flow.visits.length;
  const parts=[`${steps} step${steps===1?'':'s'}`];
  if(visits)parts.push(`${visits} visit${visits===1?'':'s'}`);
  return parts.join(' · ');
}
function flowBody(scenario:ScenarioDetail){
  const visits=scenario.flow.visits.map(visit=>`<p class="facts">Visit ${visit.number} · ${escapeHtml(visit.title)}</p>`).join('');
  const steps=scenario.flow.steps.length?`<ol class="numflow">${scenario.flow.steps.map(step=>`<li>${escapeHtml(step.text)}</li>`).join('')}</ol>`:'<p class="muted">No steps in the saved scenario.</p>';
  const diagnostics=scenario.flow.diagnostics.map(item=>`<p class="facts">${escapeHtml(item)}</p>`).join('');
  return visits+steps+diagnostics;
}
function sections(scenario:ScenarioDetail){
  const name=escapeHtml(scenario.scenarioId);
  const rows:[string,string,string][]=[
    ['Why this flow exists','',textBlock(scenario.context.rationale)],
    ['Preconditions','',textBlock(scenario.context.preconditions)],
    ['Flow',flowHint(scenario),flowBody(scenario)],
    ['Exceptions','',textBlock(scenario.context.exceptions)],
    ['Scope','',textBlock(scenario.context.scope)],
    ['Evidence','',`<p class="text">${escapeHtml(scenario.evidence.label)}</p><p class="notice">${escapeHtml(scenario.evidence.notice)}</p>`],
  ];
  return rows.map(([title,hint,body])=>`<details name="sc-${name}"><summary>${title}${hint?` <em>${escapeHtml(hint)}</em>`:'<em></em>'}</summary><div class="body">${body}</div></details>`).join('');
}
function article(scenario:ScenarioDetail){
  const id=escapeHtml(scenario.scenarioId);
  const flag=SCENARIO_ID.test(scenario.scenarioId)?`<span id="knowledge-flag-${scenario.scenarioId}"></span>`:'';
  return `<article class="card" id="scenario-${id}"><div class="sc-head"><h2>${escapeHtml(scenario.title)}</h2><span class="id">${id}</span>${flag}</div><div class="fields"><div><p class="fl">Purpose</p>${textBlock(scenario.context.purpose)}</div><div><p class="fl">Expected outcome</p>${textBlock(scenario.context.expectedOutcome)}</div></div><div class="secs">${sections(scenario)}</div></article>`;
}
function documentPage(input:GenerationInput){
  const title=escapeHtml(input.workspaceTitle);
  const when=formatGenerationTime(input.generatedAt);
  const toc=input.scenarios.map(scenario=>`<a href="#scenario-${escapeHtml(scenario.scenarioId)}">${escapeHtml(scenario.title)}</a>`).join('');
  const articles=input.scenarios.length?input.scenarios.map(article).join(''):'<p class="muted">No scenarios in this workspace.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${KNOWLEDGE_CSP}"><meta name="tnt-workspace-title" content="${title}"><meta name="tnt-knowledge-generation" content="${escapeHtml(input.generationId)}"><meta name="tnt-generated-at" content="${escapeHtml(input.generatedAt)}"><title>${title} · Knowledge</title><style>${readerCss}</style></head><body><header class="rhead"><span class="brand">tnt<b>.</b></span><span class="crumb">Knowledge · <strong>${title}</strong></span><span class="ro">Read-only</span><div class="status"><div id="knowledge-status"><span class="asof"><i class="dot grey"></i>As of ${when} (UTC+7)</span></div></div></header><div id="knowledge-banner"><p class="banner">This copy can't check freshness. Status describes generation time only.</p></div><main><section class="card ws"><h1>${title}</h1><p class="label">Scenarios</p><nav class="toc" aria-label="Scenarios in this workspace">${toc}</nav></section>${articles}</main><footer class="meta"><span>Generation <code>${escapeHtml(input.generationId)}</code></span><span>Generated ${when} (UTC+7)</span><span>Same generation as the LLM text index</span></footer></body></html>`;
}

/** Generation HTML. Both files are the offline reader: status is generation time, never a live freshness label. */
export function renderKnowledgeHtml(input:GenerationInput):Record<string,string>{
  const page=documentPage(input);
  return {'index.html':page,['workspaces/'+input.workspaceId+'.html']:page};
}

function replaceBlock(html:string,id:string,tag:'div'|'span',inner:string){
  if(!MARKER_ID.test(id))return html;
  const open=`<${tag} id="${id}">`;
  const from=html.indexOf(open);
  if(from<0)return html;
  const start=from+open.length;
  const to=html.indexOf(`</${tag}>`,start);
  if(to<0)return html;
  return html.slice(0,start)+inner+html.slice(to);
}
function needsReviewHtml(status:ReaderLiveStatus,checkedAt:Date){
  const intentDrift=status.scenarios.some(item=>item.intentFreshness==='intent-needs-review');
  const cause=intentDrift?'The saved flow changed after this context was reviewed. Confirm or update the context in TnT.':'This knowledge needs review before it can be treated as current.';
  const clock=formatClock(checkedAt.toISOString());
  const checked=`${formatGenerationTime(checkedAt.toISOString())} (UTC+7)`;
  const error=status.publicationError?`<p class="cause">${escapeHtml(status.publicationError)}</p>`:'';
  const publication=status.publicationFreshness==='current'?'current · this generation matches the saved workspace':'publication-stale · this page shows the last complete generation';
  const rows=status.scenarios.filter(item=>SCENARIO_ID.test(item.scenarioId)).map(item=>`<dt>${escapeHtml(item.scenarioId)}</dt><dd>${escapeHtml(item.intentFreshness)} · ${escapeHtml(item.publicationFreshness)}</dd>`).join('');
  return `<details class="review" open><summary><i class="dot warn"></i>Needs review <small>· checked live ${clock}</small></summary><div class="pop" role="dialog" aria-label="Status details"><h4>Needs review</h4><p class="cause">${cause}</p>${error}<dl><dt>Intent</dt><dd>${intentDrift?'intent-needs-review':'reviewed'}</dd><dt>Publication</dt><dd>${publication}</dd>${rows}<dt>Checked</dt><dd>Live by the local runner, ${checked}</dd></dl></div></details>`;
}
function bannerHtml(status:ReaderLiveStatus){
  if(status.freshness==='up-to-date')return '';
  if(status.freshness==='needs-review'){
    const when=status.generatedAt?formatGenerationTime(status.generatedAt):'the last complete generation';
    if(status.publicationFreshness==='publication-stale')return `<p class="banner warn">Showing the last complete generation (${escapeHtml(when)} UTC+7). Saved changes aren't published yet.</p>`;
    return '<p class="banner warn">This knowledge needs review. The page shows the latest complete generation.</p>';
  }
  return '<p class="banner">Saved changes are waiting to be published. This page shows the last complete generation.</p>';
}

/** Apply a successful live check. A null status leaves the generation-time "As of" text untouched. */
export function applyLiveStatus(html:string,status:ReaderLiveStatus|null,checkedAt=new Date()){
  if(!status)return html;
  const clock=formatClock(checkedAt.toISOString());
  const statusHtml=status.freshness==='up-to-date'?`<span class="live"><i class="dot"></i>Up to date <small>· checked live ${clock}</small></span>`:status.freshness==='updating'?`<span class="live"><i class="dot updating"></i>Updating <small>· checked live ${clock}</small></span>`:needsReviewHtml(status,checkedAt);
  let next=replaceBlock(html,'knowledge-status','div',statusHtml);
  next=replaceBlock(next,'knowledge-banner','div',bannerHtml(status));
  for(const scenario of status.scenarios){
    if(!SCENARIO_ID.test(scenario.scenarioId))continue;
    const flag=scenario.freshness==='needs-review'?'<span class="flag">Needs review</span>':'';
    next=replaceBlock(next,'knowledge-flag-'+scenario.scenarioId,'span',flag);
  }
  return next;
}

export function embeddedWorkspaceTitle(html:string,fallback:string){
  const match=/<meta name="tnt-workspace-title" content="([^"]*)">/.exec(html);
  return match?.[1]?escapeHtml(decodeEntities(match[1])):escapeHtml(fallback);
}
export function embeddedAsOf(html:string){
  const block=/<div id="knowledge-status">([\s\S]*?)<\/div>/.exec(html);
  const phrase=block&&/As of [^<]{0,80}\(UTC\+7\)/.exec(block[1]);
  return phrase?.[0]??'As of the last complete generation (UTC+7)';
}
export function renderLiveIndex(entries:readonly {href:string;titleHtml:string;detailHtml:string}[]){
  for(const entry of entries)if(!/^\/knowledge\/workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/.test(entry.href))throw new Error('Unsafe reader link.');
  const items=entries.length?`<ul class="index">${entries.map(entry=>`<li><a href="${entry.href}">${entry.titleHtml}</a> ${entry.detailHtml}</li>`).join('')}</ul>`:'<p class="muted">No published knowledge is available.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${KNOWLEDGE_CSP}"><title>Knowledge</title><style>${readerCss}</style></head><body><header class="rhead"><span class="brand">tnt<b>.</b></span><span class="crumb">Knowledge</span><span class="ro">Read-only</span></header><main><section class="card ws"><h1>Knowledge</h1><p class="label">Workspaces</p>${items}</section></main></body></html>`;
}
export function indexDetail(live:ReaderLiveStatus|null,asOf:string){
  if(!live)return `<span class="asof">${escapeHtml(asOf)}</span>`;
  if(live.freshness==='up-to-date')return '<span class="live">Up to date</span>';
  if(live.freshness==='needs-review')return '<span class="live">Needs review</span>';
  return '<span class="live">Updating</span>';
}

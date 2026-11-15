import {useEffect, useState, type Dispatch, type SetStateAction} from 'react';
import type {DraftPositions} from './draft-placement.js';
import type {AiDraft, PersistedAiDraft} from './ai-flow.js';
import {UNDO_WINDOW_MS} from './ai-versions.js';

export type UndoOffer = {
  receiptId: string;
  revision: number;
  workspaceId: string;
  pops?: number;
  knowledge?: {scenarioId: string; contextRevision: number};
};

function readPositions(value: unknown): DraftPositions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const positions: DraftPositions = {};
  for (const [key, point] of Object.entries(value)) {
    if (!key || !point || typeof point !== 'object' || Array.isArray(point)) continue;
    const x = (point as {x?: unknown}).x;
    const y = (point as {y?: unknown}).y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    positions[key] = {x: Math.max(0, Math.min(2400, x)), y: Math.max(0, Math.min(1400, y))};
  }
  return Object.keys(positions).length ? positions : undefined;
}

export function viewDraft(draft: AiDraft): PersistedAiDraft | null {
  if (!draft.jobId) return null;
  const positions = readPositions(draft.positions);
  return {
    jobId: draft.jobId,
    prompt: draft.prompt,
    ...(draft.previewId ? {previewId: draft.previewId} : {}),
    ...(typeof draft.baseRevision === 'number' ? {baseRevision: draft.baseRevision} : {}),
    ...(positions ? {positions} : {}),
  };
}

export function persistedAiDraft(view: Record<string, unknown> | null | undefined): PersistedAiDraft | undefined {
  const raw = view?.aiDraft;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const item = raw as Record<string, unknown>;
  if (typeof item.jobId !== 'string' || !item.jobId || typeof item.prompt !== 'string') return;
  const positions = readPositions(item.positions);
  return {
    jobId: item.jobId,
    prompt: item.prompt,
    ...(typeof item.previewId === 'string' ? {previewId: item.previewId} : {}),
    ...(typeof item.baseRevision === 'number' ? {baseRevision: item.baseRevision} : {}),
    ...(positions ? {positions} : {}),
  };
}

/** The 10 second Undo window. A workspace revision that is not the offer's revision drops the offer. */
export function useUndoWindow(undoOffer: UndoOffer | undefined, revision: number, setUndoOffer: Dispatch<SetStateAction<UndoOffer | undefined>>, setUndoVisible: Dispatch<SetStateAction<boolean>>) {
  useEffect(() => {
    setUndoOffer(current => current && revision !== current.revision ? undefined : current);
  }, [revision]);
  useEffect(() => {
    if (!undoOffer) { setUndoVisible(false); return; }
    setUndoVisible(true);
    const timer = setTimeout(() => setUndoVisible(false), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [undoOffer]);
}

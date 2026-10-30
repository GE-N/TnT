import {useSyncExternalStore} from 'react';

/**
 * Which of the mutually exclusive side panels is open.
 * The Scenarios panel is not one of these: it may stay open beside them,
 * and ND-11 still hides Node details while Scenarios is open.
 * T3 opens `info` through `useSidePanels()` the same way Versions and Node details do.
 * A right sheet should set `data-side-sheet` so canvas placement treats it as an obstacle.
 */
export type SidePanel = 'info' | 'versions' | 'nodeDetails';

let current: SidePanel | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getSidePanel(): SidePanel | null {
  return current;
}

export function openPanel(kind: SidePanel) {
  if (current === kind) return;
  current = kind;
  emit();
}

export function closePanel(kind: SidePanel) {
  if (current !== kind) return;
  current = null;
  emit();
}

/** Test helper. Clears whichever panel is open. */
export function resetSidePanels() {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSidePanels() {
  const open = useSyncExternalStore(subscribe, getSidePanel, () => null);
  return {open, openPanel, closePanel};
}

import {useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref} from 'react';

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type EscapeDecision = boolean | 'ignore' | void;

export type SheetEscapeEvent = {
  key: string;
  target: EventTarget | null;
  defaultPrevented: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};

/**
 * Right-docked dialog. The element is the existing sheet root, so layout classes stay on it.
 * `onEscape` returns true when a nested layer consumed Escape, or `'ignore'` when another
 * surface (rename, scenario menu) owns the key and this sheet must stay open.
 */
export function Sheet({id, className, testId, side, titleId, style, tabIndex = -1, onClose, onEscape, onKeyDown, onPointerDown, sheetRef, children}: {
  id?: string;
  className?: string;
  testId?: string;
  side: string;
  titleId: string;
  style?: CSSProperties;
  tabIndex?: number;
  onClose: () => void;
  onEscape?: (event: SheetEscapeEvent) => EscapeDecision;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  sheetRef?: Ref<HTMLElement | null>;
  children?: ReactNode;
}) {
  const localRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const onEscapeRef = useRef(onEscape);
  onCloseRef.current = onClose;
  onEscapeRef.current = onEscape;

  function setNode(node: HTMLElement | null) {
    localRef.current = node;
    if (!sheetRef) return;
    if (typeof sheetRef === 'function') sheetRef(node);
    else sheetRef.current = node;
  }

  useLayoutEffect(() => {
    const root = localRef.current;
    const active = document.activeElement;
    if (isFocusable(active) && active !== document.body && active !== document.documentElement && root && !root.contains(active)) {
      triggerRef.current = active;
    }
    if (root && active !== root && !(isDomNode(active) && root.contains(active))) root.focus();
    return () => {
      const current = document.activeElement;
      const stillInside = !!root && (current === root || (isDomNode(current) && root.contains(current)));
      const lost = !current || current === document.body || current === document.documentElement;
      if (!stillInside && !lost) return;
      const back = triggerRef.current;
      if (back?.isConnected) back.focus();
    };
  }, []);

  useEffect(() => {
    function onDoc(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const root = localRef.current;
      if (!root) return;
      const target = event.target;
      if (isDomNode(target) && (target === root || root.contains(target))) return;
      const decision = onEscapeRef.current?.(event);
      if (decision === true || decision === 'ignore') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    }
    document.addEventListener('keydown', onDoc);
    return () => document.removeEventListener('keydown', onDoc);
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const root = localRef.current;
    if (!root) return;
    if (event.key === 'Tab') {
      const items = tabbables(root);
      if (!items.length) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active === root || (isDomNode(active) && root.contains(active));
      if (!inside) return;
      if (event.shiftKey) {
        if (active === first || active === root) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || active === root) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key !== 'Escape') return;
    const decision = onEscapeRef.current?.(event);
    if (decision === 'ignore') return;
    event.preventDefault();
    event.stopPropagation();
    if (decision === true) return;
    onCloseRef.current();
  }

  return <aside ref={setNode} id={id} className={className} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} data-side-sheet={side} tabIndex={tabIndex} style={style} onPointerDown={onPointerDown} onKeyDown={handleKeyDown}>{children}</aside>;
}

function isDomNode(value: EventTarget | null): value is Node {
  return !!value && typeof (value as Node).nodeType === 'number';
}

function isFocusable(value: EventTarget | null): value is HTMLElement {
  return !!value && (value as Node).nodeType === 1 && typeof (value as HTMLElement).focus === 'function';
}

function tabbables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(node => {
    if (node.tabIndex < 0) return false;
    if (node.closest('[hidden]')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    return true;
  });
}

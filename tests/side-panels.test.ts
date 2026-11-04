import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {closePanel, getSidePanel, openPanel, resetSidePanels, useSidePanels, type SidePanel} from '../src/side-panels.js';

test('one side panel is open at a time', () => {
  resetSidePanels();
  assert.equal(getSidePanel(), null);
  openPanel('info');
  assert.equal(getSidePanel(), 'info');
  openPanel('info');
  assert.equal(getSidePanel(), 'info');
  openPanel('versions');
  assert.equal(getSidePanel(), 'versions');
  openPanel('nodeDetails');
  assert.equal(getSidePanel(), 'nodeDetails');
  closePanel('versions');
  assert.equal(getSidePanel(), 'nodeDetails');
  closePanel('nodeDetails');
  assert.equal(getSidePanel(), null);
  resetSidePanels();
});

test('useSidePanels reports the shared panel and closes the previous one', async () => {
  resetSidePanels();
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys) Object.defineProperty(globalThis, key, {value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key), configurable: true});
  const root = createRoot(dom.window.document.getElementById('root')!);
  function Probe() {
    const panels = useSidePanels();
    return createElement('div', null,
      createElement('span', {'data-testid': 'open'}, panels.open ?? 'none'),
      createElement('button', {type: 'button', onClick: () => panels.openPanel('versions')}, 'versions'),
      createElement('button', {type: 'button', onClick: () => panels.openPanel('nodeDetails')}, 'node'),
      createElement('button', {type: 'button', onClick: () => panels.openPanel('info')}, 'info'),
      createElement('button', {type: 'button', onClick: () => panels.closePanel(panels.open as SidePanel)}, 'close'),
    );
  }
  try {
    await act(async () => { root.render(createElement(Probe)); });
    const text = () => dom.window.document.querySelector('[data-testid="open"]')!.textContent;
    const click = (label: string) => act(async () => {
      const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label);
      button!.click();
    });
    assert.equal(text(), 'none');
    await click('versions');
    assert.equal(text(), 'versions');
    assert.equal(getSidePanel(), 'versions');
    await click('node');
    assert.equal(text(), 'nodeDetails');
    await click('info');
    assert.equal(text(), 'info');
    await click('close');
    assert.equal(text(), 'none');
    assert.equal(getSidePanel(), null);
  } finally {
    await act(async () => { root.unmount(); });
    resetSidePanels();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

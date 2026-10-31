import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('Versions is a right-docked sheet and opening it does not shift the AI field', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.equal(css.includes('is-sheet-clear'), false, 'the sheet-clear shift moves the AI field');
  const rule = css.match(/\.ai-versions-sheet\{([^}]+)\}/)?.[1] ?? '';
  assert.match(rule, /position:fixed/);
  assert.match(rule, /right:24px/);
  assert.match(rule, /top:96px/);
  assert.match(rule, /bottom:152px/);
  assert.match(rule, /width:300px/);
  assert.match(css, /\.ai-flow\{[^}]*left:50%/);
  assert.match(css, /\.ai-flow\{[^}]*transform:translateX\(-50%\)/);
});

test('the Versions and Undo controls show their fill and underline only for keyboard focus', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  for (const rule of css.matchAll(/([^{}]*\.ai-(?:versions-toggle|capsule-undo):focus[^{}]*)\{([^}]*)\}/g)) {
    if (!/background|box-shadow/.test(rule[2])) continue;
    for (const selector of rule[1].split(',')) assert.match(selector.trim(), /:focus-visible$/, `mouse focus must not fill: ${selector.trim()}`);
  }
  assert.match(css, /\.ai-flow \.ai-versions-toggle:focus-visible[^{]*\{[^}]*background:#eef4fd/);
});

test('Versions and Node details share the 16px panel inset and close alignment', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const rule = (selector: string) => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]+)\\}'))?.[1] ?? '';
  assert.match(rule('.ai-versions-sheet'), /padding:0 16px/);
  assert.match(rule('.ai-versions-head'), /padding:16px 0 8px/);
  assert.match(rule('.ai-versions-sheet .ai-versions-close'), /margin:-12px -16px 0 auto/);
  assert.match(rule('.ai-versions-list'), /margin:0 -8px/);
  assert.match(rule('.ai-version-option'), /padding:8px;/);
  assert.match(rule('.ai-versions-foot'), /padding:12px 0 16px/);
  assert.match(rule('.floating-inspector'), /padding:0 16px 16px/);
  assert.match(rule('.floating-inspector-header'), /margin:0;padding:16px 0 12px/);
  assert.match(rule('.floating-inspector-close'), /margin:-10px -16px -10px 0/);
  assert.match(rule('.inspector-bottom-fade'), /bottom:-16px;height:28px;margin:-28px -16px -16px/);
  assert.match(rule('.floating-inspector'), /width:300px/, 'popup width (and so its 12px gap) is unchanged');
});

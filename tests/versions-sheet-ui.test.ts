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

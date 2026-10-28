import {openScenarioPanel, showLegacyCanvasControls} from './workspace-ui-helpers.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {act, createElement} from 'react';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Scenarios} from '../src/scenarios.js';
import {restoreBlockReason} from '../src/ai-flow.js';
import {createScenarios} from '../server/scenarios.js';
import {createRunner} from '../server/runner.js';
import type {FlowDraft, Preview} from '../server/authoring/types.js';
import {UNDO_WINDOW_MS} from '../src/ai-versions.js';
import type {GenerationView} from '../server/ai/store.js';

const SECRET = 'sk-test-secret-value';

test('AI flow authoring UI', async t => {
  await t.test('prompt, generating, and confirm yield a scenario that edits, saves, and reopens', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.status() === 'generating', 'generating');
      await h.until(() => h.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent === '✦ Draft', 'pending overlay');
      assert.equal(h.document.querySelector('[data-testid="ai-meta"]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-usage"]'), null);
      assert.ok(h.document.querySelector('[data-testid="ai-capsule"]'));
      assert.equal(h.document.querySelector('[data-draft-screen][data-screen-id]'), null);
      await h.until(() => h.confirmEnabled(), 'confirm');
      await h.click('[data-testid="ai-confirm"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-provenance"]'), 'provenance');
      assert.match(h.document.querySelector('[data-testid="ai-provenance"]')!.textContent ?? '', /Applied as/);
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      const workspace = await h.saved();
      assert.equal(workspace.scenarios?.some(item => item.name === 'Pay a bill' && item.authoring === 'canvas'), true);
      await h.fill('Screen title for Home', 'Home desk');
      await act(async () => h.document.querySelector('[aria-label="Screen title for Home"]')!.dispatchEvent(new h.dom.window.FocusEvent('focusout', {bubbles: true})));
      await h.until(async () => (await h.saved()).canvas?.screens.some(screen => screen.title === 'Home desk') === true, 'saved title');
      await h.remount();
      await h.until(() => !!h.document.querySelector('[aria-label="Screen title for Home desk"]'), 'reopened title');
      await openScenarioPanel(h.document, act);
      assert.ok([...h.document.querySelectorAll('button')].some(button => button.textContent === 'Pay a bill'));
      assert.equal(h.ai.generations, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('apply is enabled immediately and an untargeted step stays plain', async () => {
    const h = await harness('needs');
    try {
      await h.render();
      await h.generate('Pay a bill that still needs a target');
      await h.until(() => h.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent === '✦ Draft', 'draft label');
      const step = h.document.querySelector('[data-testid="ai-draft-step"]');
      assert.equal(step?.textContent, '1 · Tap');
      assert.equal(step?.classList.contains('is-specified'), false);
      assert.equal(h.document.querySelector('.ai-check'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-review"]'), null);
      assert.equal(h.document.querySelector('[aria-label="Paid means the confirmation screen."]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-flow"] input[type="checkbox"]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-meta"]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-usage"]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-confirm-reason"]'), null);
      assert.equal(h.confirmEnabled(), true);
      const shown = [
        h.document.querySelector('[data-testid="ai-capsule"]')?.textContent ?? '',
        h.document.querySelector('[data-testid="ai-draft-zone"]')?.textContent ?? '',
        h.document.querySelector('[data-testid="ai-flow"]')?.textContent ?? '',
      ].join('\n');
      assert.doesNotMatch(shown, /Needs a target|not run yet|screens ·|tokens|Open OpenRouter account|preflight|Confirm is unavailable|assumption is acknowledged|Flow ready/);
      const ask = h.document.querySelector<HTMLInputElement>('[aria-label="Ask for changes"]');
      assert.ok(ask);
      assert.equal(ask.placeholder, 'Ask for changes');
      assert.equal(ask.closest('[data-testid="ai-capsule"]'), h.document.querySelector('[data-testid="ai-capsule"]'));
      assert.equal(h.document.querySelector('[data-testid="ai-confirm"]')?.textContent, '✓ Apply');
      assert.equal(h.document.querySelector('[data-testid="ai-discard"]')?.getAttribute('aria-label'), 'Dismiss draft');
      const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
      const rules = [...css.matchAll(/([^{}]*ai-capsule-(?:input|apply)[^{}]*)\{([^{}]*)\}/g)];
      assert.ok(rules.length >= 4, 'capsule input and apply rules');
      for (const [, , body] of rules) {
        assert.doesNotMatch(body, /inset 0 -2px|text-decoration:\s*underline/);
        assert.doesNotMatch(body, /border-bottom:\s*(?!0(?:;|\}|$))/);
      }
      assert.ok(rules.some(([, selector, body]) => selector.trim().startsWith('.ai-flow .ai-capsule-input:focus') && body.includes('box-shadow:0 0 0 2px')));
      assert.ok(rules.some(([, selector, body]) => selector.trim().startsWith('.ai-flow .ai-capsule-apply:focus') && body.includes('box-shadow:0 0 0 3px')));
      assert.equal(h.ai.generations, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('one undo after confirm restores the pre-apply workspace', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      const before = h.documentOf(await h.saved());
      await h.until(() => h.confirmEnabled(), 'confirm');
      await h.click('[data-testid="ai-confirm"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-undo"]'), 'undo');
      assert.notEqual(h.documentOf(await h.saved()), before);
      await h.click('[data-testid="ai-undo"]');
      await h.until(async () => h.documentOf(await h.saved()) === before, 'restored');
      assert.equal((await h.saved()).scenarios?.length ?? 0, 0);
      assert.equal(h.ai.undos, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('discard leaves the workspace byte-identical', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      const before = JSON.stringify(await h.saved());
      await h.click('[data-testid="ai-discard"]');
      await h.until(() => h.status() === 'idle', 'idle');
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      assert.equal(JSON.stringify(await h.saved()), before);
      assert.equal(h.ai.cancels, 0);
    } finally { await h.cleanup(); }
  });

  await t.test('reload keeps a pending draft and re-previews an expired preview', async () => {
    const h = await harness('expired');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      assert.equal(h.ai.previews, 0);
      await h.until(async () => {
        const detail = await h.service.workspaceDetail(h.workspaceId);
        const stored = detail.view && typeof detail.view === 'object' ? (detail.view as {aiDraft?: {jobId?: string}}).aiDraft : undefined;
        return !!stored?.jobId;
      }, 'persisted job');
      assert.equal(h.ai.generations, 1);
      await h.remount();
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'reloaded overlay');
      assert.equal(h.ai.generations, 1);
      assert.equal(h.ai.previews, 1);
      assert.equal(h.status(), 'pending');
    } finally { await h.cleanup(); }
  });

  await t.test('editing during generation marks the draft stale and refresh re-previews', async () => {
    const h = await harness('hold');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.status() === 'generating', 'generating');
      await h.until(() => h.ai.inflight > 0, 'poll');
      await h.addNode();
      await h.until(() => /workspace changed/.test(h.document.body.textContent ?? ''), 'stale');
      const placed = h.positions();
      assert.ok(placed);
      await h.until(() => h.ai.inflight > 0, 'stale poll');
      h.ai.release();
      await h.until(() => h.status() === 'stale' && !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'stale draft');
      assert.equal(h.ai.generations, 1);
      const previews = h.ai.previews;
      await h.click('[data-testid="ai-refresh"]');
      await h.until(() => h.status() === 'pending', 'refreshed');
      assert.equal(h.ai.generations, 1);
      assert.equal(h.ai.previews, previews + 1);
      assert.equal(h.positions(), placed);
      assert.ok(h.document.querySelector('[data-testid="ai-draft-chip"]'));
    } finally { await h.cleanup(); }
  });

  await t.test('a late job result is ignored after cancel', async () => {
    const h = await harness('hold');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.status() === 'generating', 'generating');
      await h.until(() => h.ai.inflight > 0, 'poll');
      await h.click('[data-testid="ai-cancel"]');
      await h.until(() => h.status() === 'prompting', 'prompt restored');
      h.ai.release();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      assert.equal(h.status(), 'prompting');
      assert.equal((h.document.querySelector('[aria-label="Flow description"]') as HTMLTextAreaElement).value, 'Pay the electric bill');
      assert.equal(h.ai.generations, 1);
      assert.equal(h.ai.cancels, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('confirm is blocked while a run is active', async () => {
    const h = await harness('ready', {deviceId: 'E5C92F6E-40DC-493C-93B4-469E67193736'});
    try {
      await h.render();
      await openScenarioPanel(h.document, act);
      await h.click('[aria-label="New scenario"]');
      await h.until(() => !!h.document.querySelector('[aria-label="Run scenario"]'), 'runnable scenario');
      await h.click('[aria-label="Run scenario"]');
      await h.until(() => h.document.querySelector('.result-tag')?.textContent === 'running', 'running');
      await h.generate('Pay the electric bill');
      await h.until(() => /run is active/.test(h.reason()), 'run block');
      assert.equal(h.document.querySelector('[data-testid="ai-confirm"]')?.getAttribute('aria-disabled'), 'true');
      await h.click('[data-testid="ai-confirm"]');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
      assert.equal(h.ai.applies, 0);
    } finally { await h.cleanup(); }
  });

  await t.test('provider settings never show a saved key', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.openSettings();
      await h.until(() => h.document.querySelector('[data-testid="ai-has-key"]')?.textContent?.startsWith('API key saved') === true, 'has key');
      const key = h.document.querySelector('[data-testid="ai-api-key"]') as HTMLInputElement;
      assert.equal(key.value, '');
      assert.equal(key.type, 'password');
      assert.equal(h.document.body.innerHTML.includes(SECRET), false);
      const settings = h.document.querySelector('[data-testid="ai-settings"]')?.textContent ?? '';
      assert.match(settings, /OpenRouter/);
      assert.match(settings, /OpenAI-compatible/);
      assert.doesNotMatch(h.document.body.textContent ?? '', /ollama|lm studio/i);
    } finally { await h.cleanup(); }
  });

  await t.test('a failed save does not start a generation', async () => {
    const h = await harness('ready', {failSave: true});
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-error"]'), 'save error');
      assert.match(h.document.querySelector('[data-testid="ai-error"]')!.textContent ?? '', /workspace was changed/);
      assert.equal(h.ai.generations, 0);
      assert.ok(h.document.querySelector('[data-testid="ai-retry"]'));
    } finally { await h.cleanup(); }
  });

  // Pre-fix (2f67ffe ProviderSettings.save(thenCheck)): Test connection called save(true),
  // which PUT /api/ai/config and then setApiKey(''). The typed key disappeared and a save was sent.
  await t.test('typing a key and testing the connection does not save or clear it', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.openSettings();
      await h.until(() => !!h.document.querySelector('[data-testid="ai-api-key"]'), 'key field');
      await h.fill('API key', 'sk-typed-key');
      h.ai.holdNextTest();
      await h.click('[data-testid="ai-test-connection"]');
      await h.until(() => /Testing connection/.test(h.document.body.textContent ?? ''), 'testing');
      const field = () => h.document.querySelector('[data-testid="ai-api-key"]') as HTMLInputElement;
      assert.equal(field().value, 'sk-typed-key');
      assert.equal(h.ai.puts.length, 0);
      await h.fill('API key', 'sk-typed-key-edited');
      h.ai.releaseTest();
      await h.until(() => !/Testing connection/.test(h.document.body.textContent ?? ''), 'test finished');
      assert.equal(field().value, 'sk-typed-key-edited');
      assert.equal(h.ai.puts.length, 0);
      assert.doesNotMatch(h.document.querySelector('[data-testid="ai-settings"]')?.textContent ?? '', /Connected to OpenRouter/);
      assert.equal(JSON.stringify(h.ai.tests[0]).includes('sk-typed-key-edited'), false);
      assert.equal((h.ai.tests[0] as {source?: string}).source, 'replacement');
    } finally { await h.cleanup(); }
  });

  await t.test('a failed save keeps the typed key and never sends an empty apiKey', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.openSettings();
      await h.until(() => h.document.querySelector('[data-testid="ai-save"]')?.hasAttribute('disabled') === false, 'save ready');
      await h.click('[data-testid="ai-save"]');
      await h.until(() => h.ai.puts.length === 1, 'keep save');
      assert.equal((h.ai.puts[0] as {credential?: {action?: string; apiKey?: string}}).credential?.action, 'keep');
      assert.equal(JSON.stringify(h.ai.puts[0]).includes('apiKey'), false);
      h.ai.failNextPut();
      await h.fill('API key', 'sk-keep-me');
      await h.click('[data-testid="ai-save"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-save-error"]'), 'save failed');
      assert.equal((h.document.querySelector('[data-testid="ai-api-key"]') as HTMLInputElement).value, 'sk-keep-me');
      const sent = h.ai.puts[1] as {credential?: {action?: string; apiKey?: string}};
      assert.equal(sent.credential?.action, 'replace');
      assert.equal(sent.credential?.apiKey, 'sk-keep-me');
    } finally { await h.cleanup(); }
  });

  await t.test('a pending draft survives a workspace switch and back', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      const origin = h.workspaceId;
      await h.service.save({name: 'Other workspace', yaml: 'appId: com.example.HybridApp\n---\n- launchApp\n'});
      await h.click('[aria-label="Manage workspace"]');
      await h.clickText('View all workspaces');
      await h.until(() => !!h.document.querySelector('button[aria-label^="Open Other workspace"]'), 'library');
      await h.click('button[aria-label^="Open Other workspace"]');
      await h.until(() => (h.document.body.textContent ?? '').includes('Other workspace') && h.document.querySelector('[data-testid="ai-draft-chip"]') === null, 'switched away');
      assert.equal(h.ai.cancels, 0);
      await h.click('[aria-label="Manage workspace"]');
      await h.clickText('View all workspaces');
      await h.until(() => !!h.document.querySelector('button[aria-label^="Open Untitled workspace"]'), 'origin listed');
      await h.click('button[aria-label^="Open Untitled workspace"]');
      await h.until(() => (h.document.body.textContent ?? '').includes('Untitled workspace') && h.workspaceId === origin && !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'draft returned');
      assert.equal(h.document.querySelector('[data-testid="ai-confirm"]')?.getAttribute('aria-disabled') ?? null, null);
    } finally { await h.cleanup(); }
  });

  await t.test('the composer has no model field and does not send a provider or model', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.click('[data-testid="ai-flow-button"]');
      assert.equal(h.document.querySelector('[data-testid="ai-request-model"]'), null);
      assert.equal(h.document.querySelector('[aria-label="Model for the next request"]'), null);
      assert.doesNotMatch(h.document.body.textContent ?? '', /Model for the next request|Applies to the next request/);
      await h.until(() => /OpenRouter · vendor\/model/.test(h.document.querySelector('[data-testid="ai-provider-chip"]')?.textContent ?? ''), 'saved model line');
      await h.click('[data-testid="ai-provider-chip"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-settings"]'), 'settings from the model line');
      assert.equal(h.document.querySelector('.workspace-advanced [data-testid="ai-settings"]'), null);
      await h.click('[data-testid="ai-settings-close"]');
      await h.until(() => !h.document.querySelector('[data-testid="ai-settings"]'), 'settings closed');
      await h.fill('Flow description', 'Pay the electric bill');
      await h.click('[data-testid="ai-generate"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-disclosure-continue"]') || h.status() === 'generating', 'disclosure or start');
      if (h.document.querySelector('[data-testid="ai-disclosure-continue"]')) await h.click('[data-testid="ai-disclosure-continue"]');
      await h.until(() => h.ai.generations === 1, 'generation started');
      const sent = h.ai.generationBodies[0] as Record<string, unknown>;
      assert.equal('provider' in sent, false);
      assert.equal('model' in sent, false);
      assert.equal(h.ai.puts.length, 0);
    } finally { await h.cleanup(); }
  });

  await t.test('AI settings are their own surface and guard an unsaved key', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.click('.workspace-advanced > summary');
      assert.equal(h.document.querySelector('[data-testid="ai-settings"]'), null);
      assert.match(h.document.querySelector('.workspace-advanced')?.textContent ?? '', /Show legacy canvas controls/);
      assert.doesNotMatch(h.document.querySelector('.workspace-advanced')?.textContent ?? '', /Replace key|Model ID/);
      await h.click('[data-testid="ai-flow-button"]');
      const chip = h.document.querySelector<HTMLButtonElement>('[data-testid="ai-provider-chip"]');
      assert.ok(chip);
      await h.click('[data-testid="ai-provider-chip"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-settings"]'), 'settings');
      const sheet = h.document.querySelector('[data-testid="ai-settings"]');
      assert.ok(sheet);
      assert.doesNotMatch(sheet.textContent ?? '', /Show legacy canvas controls|Scenarios over shared screens/);
      assert.equal(h.document.activeElement, h.document.querySelector('[data-testid="ai-api-key"]'));
      await h.fill('API key', 'sk-unsaved');
      await h.click('[data-testid="ai-settings-close"]');
      assert.ok(h.document.querySelector('[data-testid="ai-unsaved-guard"]'));
      assert.ok(h.document.querySelector('[data-testid="ai-settings"]'));
      await h.clickText('Keep editing');
      assert.equal(h.document.querySelector('[data-testid="ai-unsaved-guard"]'), null);
      await act(async () => { h.document.querySelector('[data-testid="ai-settings"]')!.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})); });
      assert.ok(h.document.querySelector('[data-testid="ai-unsaved-guard"]'));
      assert.ok(h.document.querySelector('[data-testid="ai-settings"]'));
      await h.click('[data-testid="ai-discard-key"]');
      await h.until(() => !h.document.querySelector('[data-testid="ai-settings"]'), 'discard closed settings');
      assert.equal(h.document.activeElement, chip);
      await h.click('[data-testid="ai-provider-chip"]');
      await h.until(() => h.document.activeElement === h.document.querySelector('[data-testid="ai-api-key"]'), 'key focused again');
      await act(async () => { h.document.querySelector('[data-testid="ai-settings"]')!.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})); });
      await h.until(() => !h.document.querySelector('[data-testid="ai-settings"]'), 'escape closed settings');
      assert.equal(h.document.activeElement, chip);
    } finally { await h.cleanup(); }
  });

  await t.test('provider choices are visible radios and an unsaved key blocks the switch', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.openSettings();
      await h.until(() => /API key saved/.test(h.document.querySelector('[data-testid="ai-has-key"]')?.textContent ?? ''), 'settings loaded');
      const radios = [...h.document.querySelectorAll<HTMLInputElement>('#ai-settings input[type="radio"]')];
      assert.deepEqual(radios.map(radio => radio.name), ['ai-provider', 'ai-provider']);
      assert.deepEqual(radios.map(radio => radio.value), ['openrouter', 'openai-compatible']);
      for (const radio of radios) {
        assert.equal(radio.hidden, false);
        assert.doesNotMatch(radio.getAttribute('style') ?? '', /display:\s*none|opacity:\s*0/);
      }
      const rule = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8').match(/\.ai-settings \.ai-provider-option input\[type="radio"\]\{([^}]*)\}/)?.[1] ?? '';
      assert.match(rule, /appearance:auto/);
      assert.match(rule, /opacity:1/);
      assert.doesNotMatch(rule, /display:\s*none|opacity:\s*0/);
      await h.click('#ai-settings input[value="openai-compatible"]');
      await h.until(() => (h.document.querySelector('#ai-settings input[value="openai-compatible"]') as HTMLInputElement).checked, 'radio selects openai-compatible');
      assert.ok(h.document.querySelector('[aria-label="Base URL"]'));
      await act(async () => { h.document.querySelector('#ai-settings input[value="openai-compatible"]')!.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true, cancelable: true})); });
      await h.until(() => (h.document.querySelector('#ai-settings input[value="openrouter"]') as HTMLInputElement).checked, 'arrow selects openrouter');
      assert.equal(h.document.querySelector('[aria-label="Base URL"]'), null);
      await h.fill('API key', 'sk-unsaved-provider');
      await h.click('#ai-settings input[value="openai-compatible"]');
      assert.ok(h.document.querySelector('[data-testid="ai-unsaved-guard"]'));
      assert.equal((h.document.querySelector('#ai-settings input[value="openrouter"]') as HTMLInputElement).checked, true);
      await act(async () => { h.document.querySelector('#ai-settings [role="radiogroup"]')!.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true})); });
      assert.equal((h.document.querySelector('#ai-settings input[value="openrouter"]') as HTMLInputElement).checked, true);
      assert.ok(h.document.querySelector('[data-testid="ai-unsaved-guard"]'));
      await h.click('[data-testid="ai-discard-key"]');
      await h.until(() => (h.document.querySelector('#ai-settings input[value="openai-compatible"]') as HTMLInputElement).checked, 'discard switches provider');
    } finally { await h.cleanup(); }
  });

  await t.test('browse searches the full catalog by id or name without replacing the typed model', async () => {
    const saved = 'deepseek/deepseek-v4.1-flash-1017';
    const models = wideCatalog();
    const h = await harness('ready', {savedModel: saved, catalog: models});
    try {
      await h.render();
      await h.openSettings();
      await h.until(() => (h.document.querySelector('[aria-label="Model"]') as HTMLInputElement).value === saved, 'saved model loaded');
      await h.click('[aria-label="Browse models"]');
      await h.until(() => h.document.querySelectorAll('.ai-catalog-row').length > 8, 'browse lists the catalog');
      assert.equal((h.document.querySelector('[aria-label="Model"]') as HTMLInputElement).value, saved);
      assert.match(h.ai.modelQueries[0] ?? '', /provider=openrouter/);
      assert.equal(catalogTotal(h.document), models.length);
      const gpt = models.filter(item => item.id.startsWith('openai/gpt-')).map(item => item.id);
      await h.fill('Search models', 'gpt');
      await h.until(() => gpt.every(id => h.document.querySelector(`[data-model-id="${id}"]`)), 'gpt matches');
      assert.deepEqual(catalogIds(h.document).filter(id => id.startsWith('openai/gpt-')).sort(), [...gpt].sort());
      assert.equal(catalogTotal(h.document), gpt.length);
      await h.fill('Search models', 'GPT');
      await h.until(() => catalogIds(h.document).includes('openai/gpt-4.0'), 'case-insensitive id');
      await h.fill('Search models', 'claude');
      await h.until(() => catalogIds(h.document).includes('custom/writer'), 'name match');
      assert.ok(catalogIds(h.document).includes('anthropic/claude-sonnet-4.5'));
      assert.ok(catalogIds(h.document).includes('anthropic/claude-haiku-4.5'));
      await h.fill('Search models', 'ClAuDe');
      await h.until(() => catalogIds(h.document).includes('custom/writer'), 'case-insensitive name');
      assert.equal((h.document.querySelector('[aria-label="Model"]') as HTMLInputElement).value, saved);
      await h.click('[data-testid="ai-save"]');
      await h.until(() => h.ai.puts.length === 1, 'model saved');
      assert.equal((h.ai.puts[0] as {model?: string}).model, saved);
    } finally { await h.cleanup(); }
  });

  await t.test('a failed catalog keeps the typed model id', async () => {
    const h = await harness('ready', {failCatalog: true});
    try {
      await h.render();
      await h.openSettings();
      await h.until(() => (h.document.querySelector('[aria-label="Model"]') as HTMLInputElement).value === 'vendor/model', 'model field');
      await h.click('[aria-label="Browse models"]');
      await h.until(() => /Couldn.t load the model list/.test(h.document.querySelector('[data-testid="ai-catalog-failed"]')?.textContent ?? ''), 'catalog failed');
      assert.match(h.document.querySelector('[data-testid="ai-catalog-failed"]')?.textContent ?? '', /Try again/);
      assert.match(h.document.querySelector('[data-testid="ai-catalog-failed"]')?.textContent ?? '', /used exactly as typed/);
      await h.fill('Model', 'vendor/x/experimental-model');
      assert.equal(h.document.querySelector('.ai-catalog-row'), null);
      await h.click('[data-testid="ai-save"]');
      await h.until(() => h.ai.puts.length === 1, 'typed model saved');
      assert.equal((h.ai.puts[0] as {model?: string}).model, 'vendor/x/experimental-model');
    } finally { await h.cleanup(); }
  });

  await t.test('a valid preview opens the dashed draft and the AI capsule', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent === '✦ Draft', 'overlay');
      assert.doesNotMatch(h.document.body.textContent ?? '', /Flow ready\. Use this flow\?/);
      assert.equal(h.document.querySelector('[data-testid="ai-confirm"]')?.textContent, '✓ Apply');
      assert.ok(h.document.querySelector('[aria-label="Ask for changes"]'));
      assert.equal(h.document.querySelector('[data-testid="ai-discard"]')?.getAttribute('aria-label'), 'Dismiss draft');
      assert.equal(h.document.querySelector('[aria-label="Flow description"]'), null);
    } finally { await h.cleanup(); }
  });

  await t.test('a non-applicable INVALID_DRAFT preview keeps the composer open with the issues', async () => {
    const h = await harness('invalid');
    const prompt = 'create flow to start from "home" should see Coordinator';
    try {
      await h.render();
      await h.generate(prompt);
      await h.until(() => !!h.document.querySelector('[data-testid="ai-composer-issues"]'), 'issues stay visible');
      assert.equal(h.status(), 'failed');
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      assert.equal((h.document.querySelector('[aria-label="Flow description"]') as HTMLTextAreaElement).value, prompt);
      const issues = h.document.querySelector('[data-testid="ai-composer-issues"]')?.textContent ?? '';
      assert.match(issues, /must have required property 'setup'/);
      assert.match(issues, /must have required property 'key'/);
      assert.ok(h.document.querySelector('[data-testid="ai-refine"]'));
    } finally { await h.cleanup(); }
  });

  await t.test('a failed AUTHORING_INVALID job keeps the prompt and lists preview diagnostics', async () => {
    const h = await harness('authoring-failed');
    const prompt = 'Guest adds Running shoes to the cart';
    try {
      await h.render();
      await h.generate(prompt);
      await h.until(() => !!h.document.querySelector('[data-testid="ai-composer-issues"]'), 'authoring issues');
      assert.equal(h.status(), 'failed');
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      assert.equal((h.document.querySelector('[aria-label="Flow description"]') as HTMLTextAreaElement).value, prompt);
      assert.match(h.document.querySelector('[data-testid="ai-composer-issues"]')?.textContent ?? '', /swipe/);
      assert.match(h.document.body.textContent ?? '', /Couldn.t build a flow/);
      assert.ok(h.document.querySelector('[data-testid="ai-refine"]'));
      const failedJobId = await h.untilJobId();
      await h.click('[data-testid="ai-refine"]');
      await h.fill('Flow description', 'Use a tap instead of swipe');
      await h.click('[data-testid="ai-generate"]');
      await h.until(() => h.ai.generationBodies.length >= 2, 'refine sent');
      const sent = h.ai.generationBodies[1] as {previousJobId?: string};
      assert.equal(sent.previousJobId, failedJobId);
      assert.equal('provider' in sent, false);
      assert.equal('model' in sent, false);
    } finally { await h.cleanup(); }
  });

  await t.test('saving a key then generating uses the new settings without a reload', async () => {
    const h = await harness('ready', {unconfigured: true});
    try {
      await h.render();
      await h.openSettings();
      await h.until(() => !!h.document.querySelector('[data-testid="ai-api-key"]'), 'key field');
      await h.fill('Model', 'vendor/model');
      await h.fill('API key', 'sk-fresh-key');
      await h.click('[data-testid="ai-save"]');
      await h.until(() => /API key saved/.test(h.document.querySelector('[data-testid="ai-has-key"]')?.textContent ?? ''), 'key saved');
      await h.click('[data-testid="ai-settings-close"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-generate"]'), 'generate enabled');
      await h.fill('Flow description', 'Pay the electric bill');
      await h.click('[data-testid="ai-generate"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-disclosure-continue"]') || h.ai.generations === 1, 'disclosure or start');
      if (h.document.querySelector('[data-testid="ai-disclosure-continue"]')) await h.click('[data-testid="ai-disclosure-continue"]');
      await h.until(() => h.ai.generations === 1, 'generation started');
      assert.equal((h.ai.generationBodies.at(-1) as {expectedSettingsRevision?: number}).expectedSettingsRevision, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('refresh after settings changed sends the new revision', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      h.ai.rejectNextGeneration();
      await h.generate('Pay the electric bill');
      await h.until(() => /Refresh and generate again/.test(h.document.body.textContent ?? ''), 'refresh offered');
      const first = h.ai.generationBodies[0] as {expectedSettingsRevision?: number};
      await h.click('[data-testid="ai-retry"]');
      await h.until(() => h.ai.generationBodies.length >= 2, 'retried');
      const second = h.ai.generationBodies[1] as {expectedSettingsRevision?: number};
      assert.equal(second.expectedSettingsRevision, (first.expectedSettingsRevision ?? 0) + 1);
      await h.until(() => h.ai.generations === 1, 'generation started');
    } finally { await h.cleanup(); }
  });

  await t.test('switching workspace during refine keeps the previous draft and ignores the late result', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-draft-chip"]'), 'overlay');
      const origin = h.workspaceId;
      const previousJobId = await h.untilJobId();
      await h.fill('Ask for changes', 'Add a receipt');
      h.ai.holdNextJob();
      await act(async () => {
        const field = h.document.querySelector<HTMLInputElement>('[aria-label="Ask for changes"]');
        assert.ok(field);
        field.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      });
      await h.until(() => h.status() === 'generating', 'refining');
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent, '✦ Draft');
      assert.equal(h.document.querySelectorAll('[data-testid="ai-draft-zone"]').length, 1);
      assert.equal(h.document.body.textContent?.includes('Previous draft'), false);
      assert.equal((h.ai.generationBodies.at(-1) as {previousJobId?: string}).previousJobId, previousJobId);
      await h.service.save({name: 'Other workspace', yaml: 'appId: com.example.HybridApp\n---\n- launchApp\n'});
      await h.click('[aria-label="Manage workspace"]');
      await h.clickText('View all workspaces');
      await h.until(() => !!h.document.querySelector('button[aria-label^="Open Other workspace"]'), 'library');
      await h.click('button[aria-label^="Open Other workspace"]');
      await h.until(() => (h.document.body.textContent ?? '').includes('Other workspace') && h.document.querySelector('[data-testid="ai-draft-chip"]') === null, 'switched away');
      assert.equal(h.ai.cancels, 1);
      await h.click('[aria-label="Manage workspace"]');
      await h.clickText('View all workspaces');
      await h.until(() => !!h.document.querySelector('button[aria-label^="Open Untitled workspace"]'), 'origin listed');
      await h.click('button[aria-label^="Open Untitled workspace"]');
      await h.until(() => (h.document.body.textContent ?? '').includes('Untitled workspace') && h.workspaceId === origin && h.status() === 'pending' && h.confirmEnabled(), 'draft returned');
      assert.equal(h.status(), 'pending');
      assert.equal(h.document.querySelector('[data-testid="ai-confirm"]')?.getAttribute('aria-disabled') ?? null, null);
      h.ai.release();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
      assert.equal(h.status(), 'pending');
      assert.equal(h.document.body.textContent?.includes('Late refine'), false);
      assert.ok(h.document.querySelector('[data-testid="ai-draft-chip"]'));
    } finally { await h.cleanup(); }
  });

  await t.test('a new draft sits in empty chrome-free space, stays above the pills, and can be dragged', async () => {
    const h = await harness('ready');
    const proto = h.dom.window.HTMLElement.prototype;
    const originalRect = proto.getBoundingClientRect;
    const box = (left: number, top: number, width: number, height: number) => ({x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() { return {}; }});
    const chrome = [
      ['workspace-manager', box(24, 24, 340, 76)],
      ['scenario-sequence-bar', box(390, 24, 610, 72)],
      ['canvas-toolbar', box(24, 724, 220, 52)],
      ['ai-launch', box(1212, 676, 44, 44)],
      ['workspace-advanced', box(340, 732, 280, 44)],
      ['canvas-viewport', box(0, 0, 1280, 800)],
      ['canvas-surface', box(0, 0, 2295, 1402.5)],
    ] as const;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      for (const [name, value] of chrome) if (this.classList?.contains(name)) return value;
      return originalRect.call(this);
    } as typeof proto.getBoundingClientRect;
    Object.defineProperty(h.dom.window, 'innerWidth', {configurable: true, value: 1280});
    Object.defineProperty(h.dom.window, 'innerHeight', {configurable: true, value: 800});
    const overlaps = (a: {left: number; top: number; right: number; bottom: number}, b: {left: number; top: number; right: number; bottom: number}) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
    try {
      await h.render();
      const viewport = h.document.querySelector<HTMLElement>('.canvas-viewport')!;
      Object.defineProperty(viewport, 'clientWidth', {configurable: true, value: 1280});
      Object.defineProperty(viewport, 'clientHeight', {configurable: true, value: 800});
      const zoomLabel = [...h.document.querySelectorAll('.canvas-toolbar span')].map(node => node.textContent?.trim() ?? '').find(text => /^\d+%$/.test(text));
      const zoom = Number.parseInt(zoomLabel ?? '85', 10) / 100;
      await act(async () => h.document.querySelector('.canvas-surface')!.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 40 * zoom, clientY: 40 * zoom})));
      await h.clickText('Add node');
      await h.until(() => {
        const node = h.document.querySelector<HTMLElement>('[data-screen-id]');
        return !!node && Math.abs(parseFloat(node.style.left) - 40) < 1 && Math.abs(parseFloat(node.style.top) - 40) < 1;
      }, 'existing screen at the old draft origin');
      await h.until(async () => {
        if (!h.workspaceId) return false;
        const saved = await h.saved();
        return saved.canvas?.screens.some(screen => screen.x === 40 && screen.y === 40) === true;
      }, 'existing screen saved');
      const savedBefore = JSON.stringify((await h.saved()).canvas);
      const existingBefore = h.positions();
      await h.generate('Pay the electric bill');
      await h.until(() => h.document.querySelectorAll('[data-testid="ai-draft-screen"]').length === 3 && !!h.document.querySelector('[data-testid="ai-capsule"]'), 'placed draft');
      const origin = viewport.getBoundingClientRect();
      const scroll = {left: viewport.scrollLeft || 0, top: viewport.scrollTop || 0};
      const obstacles = chrome.filter(([name]) => name !== 'canvas-viewport' && name !== 'canvas-surface').map(([, value]) => value);
      const draftNodes = [...h.document.querySelectorAll<HTMLElement>('[data-testid="ai-draft-screen"]')];
      const existing = h.document.querySelector<HTMLElement>('[data-screen-id]')!;
      const existingBox = {left: parseFloat(existing.style.left), top: parseFloat(existing.style.top), right: parseFloat(existing.style.left) + 250, bottom: parseFloat(existing.style.top) + 120};
      for (const node of draftNodes) {
        const x = parseFloat(node.style.left);
        const y = parseFloat(node.style.top);
        const canvasBox = {left: x, top: y, right: x + 250, bottom: y + 120};
        assert.equal(overlaps(canvasBox, existingBox), false, node.dataset.draftScreen + ' overlaps an existing screen');
        const screenBox = {left: origin.left + x * zoom - scroll.left, top: origin.top + y * zoom - scroll.top, right: 0, bottom: 0};
        screenBox.right = screenBox.left + 250 * zoom;
        screenBox.bottom = screenBox.top + 92 * zoom;
        assert.ok(screenBox.left >= origin.left - 1 && screenBox.top >= origin.top - 1 && screenBox.right <= origin.right + 1 && screenBox.bottom <= origin.bottom + 1, node.dataset.draftScreen + ' is outside the viewport');
        for (const obstacle of obstacles) assert.equal(overlaps(screenBox, obstacle), false, node.dataset.draftScreen + ' is under floating chrome');
      }
      const capsule = h.document.querySelector<HTMLElement>('[data-testid="ai-capsule"]')!;
      assert.ok(capsule);
      const ask = h.document.querySelector<HTMLElement>('[aria-label="Ask for changes"]');
      assert.ok(ask);
      assert.equal(ask.closest('[data-testid="ai-capsule"]'), capsule);
      for (const id of ['ai-confirm', 'ai-discard']) {
        const button = h.document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        assert.ok(button, id);
        assert.equal(button.closest('[data-testid="ai-capsule"]'), capsule);
        assert.notEqual(button.getAttribute('aria-hidden'), 'true');
        assert.equal(button.hidden, false);
      }
      const home = h.document.querySelector<HTMLElement>('[data-draft-screen="home"]')!;
      const startX = parseFloat(home.style.left);
      const startY = parseFloat(home.style.top);
      const pointer = (type: string, x: number, y: number) => home.dispatchEvent(new h.dom.window.PointerEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1}));
      await act(async () => { pointer('pointerdown', 0, 0); pointer('pointermove', 100 * zoom, 0); pointer('pointerup', 100 * zoom, 0); });
      assert.ok(Math.abs(parseFloat(home.style.left) - (startX + 100)) < 1, 'pointer drag moves the draft screen');
      home.focus();
      await act(async () => home.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true})));
      assert.ok(Math.abs(parseFloat(home.style.top) - (startY + 10)) < 1, 'arrow key moves the draft screen');
      assert.equal(h.positions(), existingBefore);
      assert.equal(JSON.stringify((await h.saved()).canvas), savedBefore);
      const left = home.style.left;
      const top = home.style.top;
      await h.until(async () => {
        const detail = await h.service.workspaceDetail(h.workspaceId);
        const stored = detail.view && typeof detail.view === 'object' ? (detail.view as {aiDraft?: {positions?: Record<string, {x: number; y: number}>}}).aiDraft : undefined;
        const point = stored?.positions?.home;
        return !!point && Math.abs(point.x - parseFloat(left)) < 0.5 && Math.abs(point.y - parseFloat(top)) < 0.5;
      }, 'dragged position persisted');
      await h.remount();
      await h.until(() => {
        const node = h.document.querySelector<HTMLElement>('[data-draft-screen="home"]');
        return !!node && Math.abs(parseFloat(node.style.left) - parseFloat(left)) < 0.5 && Math.abs(parseFloat(node.style.top) - parseFloat(top)) < 0.5;
      }, 'position restored');
      assert.equal(h.positions(), existingBefore);
    } finally {
      proto.getBoundingClientRect = originalRect;
      await h.cleanup();
    }
  });

  await t.test('apply puts new screens where the draft was drawn and re-previews only after a drag', async () => {
    const kept = await harness('ready');
    try {
      await kept.render();
      sizeViewport(kept.document);
      await kept.addNode();
      await kept.until(async () => {
        if (!kept.workspaceId) return false;
        return ((await kept.saved()).canvas?.screens.length ?? 0) === 1;
      }, 'existing screen saved');
      const existing = kept.document.querySelector<HTMLElement>('[data-screen-id]');
      assert.ok(existing?.dataset.screenId);
      const existingId = existing.dataset.screenId;
      const existingAt = {x: parseFloat(existing.style.left), y: parseFloat(existing.style.top)};
      await kept.generate('Pay the electric bill');
      await kept.until(() => kept.document.querySelectorAll('[data-testid="ai-draft-screen"]').length === 3, 'three draft cards');
      await untilPlacements(kept);
      assert.equal(kept.ai.previews, 1);
      const sent = (kept.ai.previewBodies[0] as {placements?: Record<string, {x: number; y: number}>}).placements;
      assert.ok(sent);
      assert.deepEqual(Object.keys(sent).sort(), ['bills', 'done', 'home']);
      const drawn = drawnDraft(kept.document);
      for (const key of Object.keys(drawn)) samePoint(sent[key], drawn[key]);
      const previewId = kept.ai.lastPreviewId;
      await kept.click('[data-testid="ai-confirm"]');
      await kept.until(() => !!kept.document.querySelector('[data-testid="ai-provenance"]'), 'applied without another preview');
      assert.equal(kept.ai.previews, 1);
      assert.equal((kept.ai.applyBodies.at(-1) as {previewId?: string}).previewId, previewId);
      const saved = await kept.saved();
      for (const [key, title] of [['home', 'Home'], ['bills', 'Bills'], ['done', 'Done']] as const) {
        const screen = saved.canvas?.screens.find(item => item.title === title);
        assert.ok(screen, title);
        samePoint(screen, drawn[key]);
      }
      const stayed = saved.canvas?.screens.find(item => item.id === existingId);
      assert.ok(stayed);
      samePoint(stayed, existingAt);
    } finally { await kept.cleanup(); }

    const dragged = await harness('ready');
    try {
      await dragged.render();
      sizeViewport(dragged.document);
      await dragged.generate('Pay the electric bill');
      await dragged.until(() => dragged.document.querySelectorAll('[data-testid="ai-draft-screen"]').length === 3, 'draft before drag');
      await untilPlacements(dragged);
      const before = dragged.ai.previews;
      const firstPreview = dragged.ai.lastPreviewId;
      const home = dragged.document.querySelector<HTMLElement>('[data-draft-screen="home"]');
      assert.ok(home);
      const startX = parseFloat(home.style.left);
      const startY = parseFloat(home.style.top);
      const zoomLabel = [...dragged.document.querySelectorAll('.canvas-toolbar span')].map(node => node.textContent?.trim() ?? '').find(text => /^\d+%$/.test(text));
      const zoom = Number.parseInt(zoomLabel ?? '85', 10) / 100;
      const pointer = (type: string, x: number, y: number) => home.dispatchEvent(new dragged.dom.window.PointerEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1}));
      await act(async () => { pointer('pointerdown', 0, 0); pointer('pointermove', 80 * zoom, 40 * zoom); pointer('pointerup', 80 * zoom, 40 * zoom); });
      assert.ok(Math.abs(parseFloat(home.style.left) - (startX + 80)) < 1, 'draft card moved');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
      assert.equal(dragged.ai.previews, before, 'dragging does not preview');
      const moved = drawnDraft(dragged.document);
      await dragged.click('[data-testid="ai-confirm"]');
      await dragged.until(() => dragged.ai.previews === before + 1 && !!dragged.document.querySelector('[data-testid="ai-provenance"]'), 're-previewed then applied');
      const again = (dragged.ai.previewBodies.at(-1) as {placements?: Record<string, {x: number; y: number}>}).placements;
      assert.ok(again);
      for (const key of Object.keys(moved)) samePoint(again[key], moved[key]);
      assert.notEqual(dragged.ai.lastPreviewId, firstPreview);
      assert.equal((dragged.ai.applyBodies.at(-1) as {previewId?: string}).previewId, dragged.ai.lastPreviewId);
      const saved = await dragged.saved();
      for (const [key, title] of [['home', 'Home'], ['bills', 'Bills'], ['done', 'Done']] as const) {
        samePoint(saved.canvas?.screens.find(item => item.title === title), moved[key]);
      }
    } finally { await dragged.cleanup(); }

    const existing = await harness('on-existing');
    try {
      await existing.render();
      sizeViewport(existing.document);
      await existing.addNode();
      await existing.until(async () => {
        if (!existing.workspaceId) return false;
        return ((await existing.saved()).canvas?.screens.length ?? 0) === 1;
      }, 'host screen saved');
      await existing.generate('Add a pay step on this screen');
      await existing.until(() => !!existing.document.querySelector('[data-draft-screen="done"]'), 'create screen drawn');
      await untilPlacements(existing);
      const sent = (existing.ai.previewBodies.at(-1) as {placements?: Record<string, {x: number; y: number}>}).placements;
      assert.ok(sent);
      assert.deepEqual(Object.keys(sent), ['done']);
      assert.equal('home' in sent, false);
      samePoint(sent.done, drawnDraft(existing.document).done);
    } finally { await existing.cleanup(); }

    const failed = await harness('ready');
    try {
      await failed.render();
      sizeViewport(failed.document);
      await failed.generate('Pay the electric bill');
      await failed.until(() => failed.document.querySelectorAll('[data-testid="ai-draft-screen"]').length === 3, 'draft before a failed re-preview');
      await untilPlacements(failed);
      const home = failed.document.querySelector<HTMLElement>('[data-draft-screen="home"]');
      assert.ok(home);
      const zoomLabel = [...failed.document.querySelectorAll('.canvas-toolbar span')].map(node => node.textContent?.trim() ?? '').find(text => /^\d+%$/.test(text));
      const zoom = Number.parseInt(zoomLabel ?? '85', 10) / 100;
      const pointer = (type: string, x: number, y: number) => home.dispatchEvent(new failed.dom.window.PointerEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1}));
      await act(async () => { pointer('pointerdown', 0, 0); pointer('pointermove', 60 * zoom, 0); pointer('pointerup', 60 * zoom, 0); });
      failed.ai.failNextPreview();
      await failed.click('[data-testid="ai-confirm"]');
      await failed.until(() => /could not be previewed/i.test(failed.document.querySelector('[data-testid="ai-capsule-error"]')?.textContent ?? ''), 'preview error in the capsule');
      assert.equal(failed.ai.applies, 0);
      assert.equal(failed.document.querySelector('[data-testid="ai-provenance"]'), null);
      assert.ok(failed.document.querySelector('[data-draft-screen="home"]'));
      assert.equal(failed.status(), 'pending');
    } finally { await failed.cleanup(); }
  });

  await t.test('a needsInfo question lives in the capsule and one answer replaces the same draft', async () => {
    const h = await harness('asks');
    try {
      await h.render();
      await h.generate('Pay a bill that needs a title');
      await h.until(() => h.document.querySelectorAll('[data-testid="ai-question"]').length === 2 && h.status() === 'needsInfo', 'questions');
      const questions = [...h.document.querySelectorAll<HTMLElement>('[data-testid="ai-question"]')];
      assert.match(questions[0]?.textContent ?? '', /Which title should the first step use/);
      assert.match(questions[1]?.textContent ?? '', /Which control is Pay/);
      assert.deepEqual([...questions[0].querySelectorAll('[data-testid="ai-question-option"]')].map(button => button.textContent), ['Home', 'Start', 'Welcome']);
      assert.deepEqual([...questions[1].querySelectorAll('[data-testid="ai-question-option"]')].map(button => button.textContent), ['Pay', 'Confirm']);
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent, '✦ Draft');
      assert.equal(h.confirmEnabled(), true);
      const jobId = await h.untilJobId();
      await h.click('[data-testid="ai-question-option"][data-question-key="payTarget"]');
      await h.until(() => h.ai.generationBodies.length >= 2, 'answer sent');
      const sent = h.ai.generationBodies[1] as {previousJobId?: string; prompt?: string; answers?: {key: string; answer: string}[]};
      assert.equal(sent.previousJobId, jobId);
      assert.equal(sent.prompt, 'Pay');
      assert.deepEqual(sent.answers, [{key: 'payTarget', answer: 'Pay'}]);
      await h.until(() => h.document.querySelector('[data-testid="ai-question"]') === null && h.document.querySelector('[data-testid="ai-draft-step"]')?.textContent === '1 · Tap Home', 'draft replaced');
      assert.equal(h.document.querySelectorAll('[data-testid="ai-draft-zone"]').length, 1);
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent, '✦ Draft');
      assert.equal(h.document.body.textContent?.includes('Previous draft'), false);
      assert.equal(h.status(), 'pending');
    } finally { await h.cleanup(); }
  });

  await t.test('a typed reply answers the first question and updates the same draft', async () => {
    const h = await harness('asks');
    try {
      await h.render();
      await h.generate('Pay a bill that needs a title');
      await h.until(() => h.status() === 'needsInfo' && !!h.document.querySelector('[aria-label="Ask for changes"]'), 'reply field');
      const jobId = await h.untilJobId();
      await h.fill('Ask for changes', 'Start screen');
      await act(async () => {
        const field = h.document.querySelector<HTMLInputElement>('[aria-label="Ask for changes"]');
        assert.ok(field);
        field.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      });
      await h.until(() => h.ai.generationBodies.length >= 2, 'reply sent');
      const sent = h.ai.generationBodies[1] as {previousJobId?: string; prompt?: string; answers?: {key: string; answer: string}[]};
      assert.equal(sent.previousJobId, jobId);
      assert.equal(sent.prompt, 'Start screen');
      assert.deepEqual(sent.answers, [{key: 'homeVisible', answer: 'Start screen'}]);
      await h.until(() => h.status() === 'pending' && h.document.querySelector('[data-testid="ai-question"]') === null, 'questions cleared');
      assert.equal(h.document.querySelectorAll('[data-testid="ai-draft-zone"]').length, 1);
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent, '✦ Draft');
      assert.equal(h.document.body.textContent?.includes('Previous draft'), false);
    } finally { await h.cleanup(); }
  });

  await t.test('Apply on a needsInfo draft calls apply and succeeds', async () => {
    const h = await harness('asks');
    try {
      await h.render();
      await h.generate('Pay a bill that needs a title');
      await h.until(() => h.status() === 'needsInfo' && h.confirmEnabled(), 'apply ready');
      assert.equal(h.document.querySelector('[data-testid="ai-confirm-reason"]'), null);
      await h.click('[data-testid="ai-confirm"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-provenance"]'), 'applied');
      assert.equal(h.ai.applies, 1);
      assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-question"]'), null);
      assert.equal(h.status(), 'idle');
    } finally { await h.cleanup(); }
  });

  await t.test('a refine replaces the same draft and a failure keeps it', async () => {
    const held = await harness('ready');
    try {
      await held.render();
      await held.generate('Pay the electric bill');
      await held.until(() => held.document.querySelector('[data-draft-screen="home"]') !== null, 'original draft');
      held.ai.holdNextJob();
      await held.fill('Ask for changes', 'Rename the last screen');
      await act(async () => {
        held.document.querySelector<HTMLInputElement>('[aria-label="Ask for changes"]')!.dispatchEvent(new held.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      });
      await held.until(() => held.status() === 'generating', 'refining');
      assert.equal(held.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent, '✦ Draft');
      assert.equal(held.document.querySelectorAll('[data-testid="ai-draft-zone"]').length, 1);
      assert.ok(held.document.querySelector('[data-draft-screen="home"]'));
      assert.equal(held.document.body.textContent?.includes('Previous draft'), false);
      assert.equal(held.document.body.textContent?.includes('Late refine'), false);
      held.ai.release();
      await held.until(() => !!held.document.querySelector('[data-draft-screen="late"]'), 'replaced in place');
      assert.equal(held.document.querySelector('[data-draft-screen="home"]'), null);
      assert.equal(held.document.querySelectorAll('[data-testid="ai-draft-zone"]').length, 1);
      assert.equal(held.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent, '✦ Draft');
      assert.equal(held.document.body.textContent?.includes('Previous draft'), false);
      assert.equal(held.status(), 'pending');
    } finally { await held.cleanup(); }

    const failed = await harness('ready');
    try {
      await failed.render();
      await failed.generate('Pay the electric bill');
      await failed.until(() => !!failed.document.querySelector('[data-draft-screen="home"]'), 'draft before failed refine');
      failed.ai.rejectNextGeneration();
      await failed.fill('Ask for changes', 'Add a receipt');
      await act(async () => {
        failed.document.querySelector<HTMLInputElement>('[aria-label="Ask for changes"]')!.dispatchEvent(new failed.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      });
      await failed.until(() => !!failed.document.querySelector('[data-testid="ai-capsule-error"]'), 'capsule error');
      assert.match(failed.document.querySelector('[data-testid="ai-capsule-error"]')?.textContent ?? '', /Settings changed/);
      assert.ok(failed.document.querySelector('[data-draft-screen="home"]'));
      await applyKeptDraft(failed);
    } finally { await failed.cleanup(); }

    const cancelled = await harness('ready');
    try {
      await cancelled.render();
      await cancelled.generate('Pay the electric bill');
      await cancelled.until(() => !!cancelled.document.querySelector('[data-draft-screen="home"]'), 'draft before cancelled refine');
      cancelled.ai.holdNextJob();
      await cancelled.fill('Ask for changes', 'Rename the last screen');
      await act(async () => {
        cancelled.document.querySelector<HTMLInputElement>('[aria-label="Ask for changes"]')!.dispatchEvent(new cancelled.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      });
      await cancelled.until(() => cancelled.status() === 'generating', 'refining before cancel');
      await cancelled.click('[data-testid="ai-cancel"]');
      await applyKeptDraft(cancelled);
    } finally { await cancelled.cleanup(); }
  });

  await t.test('steps added to an existing screen use the draft style until dismiss or apply', async () => {
    const dismissed = await harness('on-existing');
    try {
      await dismissed.render();
      await dismissed.addNode();
      await dismissed.until(async () => {
        if (!dismissed.workspaceId) return false;
        const saved = await dismissed.saved();
        return (saved.canvas?.screens.length ?? 0) === 1;
      }, 'existing screen saved');
      const placed = dismissed.positions();
      await dismissed.generate('Add a pay step on this screen');
      await dismissed.until(() => !!dismissed.document.querySelector('[data-testid="ai-draft-existing-steps"]'), 'steps on the existing screen');
      const host = dismissed.document.querySelector<HTMLElement>('[data-screen-id].has-ai-draft-steps');
      assert.ok(host);
      assert.equal(host.querySelector('[data-testid="ai-draft-existing-steps"]')?.textContent, '1 · Go to Done');
      assert.equal(host.querySelector('[data-testid="ai-draft-screen"]'), null);
      assert.equal(dismissed.document.querySelectorAll('[data-testid="ai-draft-screen"]').length, 1);
      assert.equal(dismissed.document.querySelector('[data-draft-screen="done"] p')?.textContent, 'Done');
      assert.equal(dismissed.document.querySelector('[data-draft-screen="home"]'), null);
      assert.equal(dismissed.positions(), placed);
      await dismissed.click('[data-testid="ai-discard"]');
      await dismissed.until(() => dismissed.status() === 'idle', 'dismissed');
      assert.equal(dismissed.document.querySelector('.has-ai-draft-steps'), null);
      assert.equal(dismissed.document.querySelector('[data-testid="ai-draft-existing-steps"]'), null);
      assert.equal(dismissed.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      assert.equal(dismissed.positions(), placed);
    } finally { await dismissed.cleanup(); }

    const applied = await harness('on-existing');
    try {
      await applied.render();
      await applied.addNode();
      await applied.until(async () => {
        if (!applied.workspaceId) return false;
        return ((await applied.saved()).canvas?.screens.length ?? 0) === 1;
      }, 'existing screen saved');
      await applied.generate('Add a pay step on this screen');
      await applied.until(() => !!applied.document.querySelector('.has-ai-draft-steps') && applied.confirmEnabled(), 'draft steps ready');
      await applied.click('[data-testid="ai-confirm"]');
      await applied.until(() => !!applied.document.querySelector('[data-testid="ai-provenance"]'), 'applied');
      assert.equal(applied.ai.applies, 1);
      assert.equal(applied.document.querySelector('.has-ai-draft-steps'), null);
      assert.equal(applied.document.querySelector('[data-testid="ai-draft-existing-steps"]'), null);
      assert.equal(applied.document.querySelector('[data-testid="ai-draft-chip"]'), null);
      assert.ok(applied.document.querySelector('[data-screen-id]'));
    } finally { await applied.cleanup(); }
  });

  await t.test('the describe-a-flow button stays labeled and quiet at rest', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      const button = h.document.querySelector<HTMLButtonElement>('[data-testid="ai-flow-button"]');
      assert.ok(button);
      assert.equal(button.classList.contains('ai-launch'), true);
      assert.match(button.textContent ?? '', /✦\s*Describe a flow/);
      assert.equal(button.getAttribute('aria-label'), 'Describe a flow');
      assert.equal(h.document.querySelector('[data-testid="ai-flow-choice"]'), null);
      const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
      const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      const launch = blocks.filter(([, selector]) => selector.includes('.ai-launch') && !selector.includes('ai-launch-dot'));
      const rest = launch.filter(([, selector]) => !selector.includes('focus-visible'));
      assert.ok(rest.length >= 1, 'at-rest launch rule');
      for (const [, , body] of rest) {
        assert.match(body, /#e7f3ff/);
        assert.match(body, /#0a63d1/);
        assert.match(body, /border:\s*0/);
        assert.match(body, /box-shadow:\s*none/);
        assert.match(body, /outline:\s*none/);
        assert.doesNotMatch(body, /box-shadow:\s*(?!none)/);
      }
      const focus = launch.filter(([, selector]) => selector.includes('focus-visible'));
      assert.ok(focus.some(([, , body]) => /box-shadow:\s*0 0 0 3px/.test(body)), 'keyboard ring');
    } finally { await h.cleanup(); }
  });

  await t.test('generating while a flow is applied never undoes and never offers New or Replace', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.confirmEnabled(), 'confirm');
      await h.click('[data-testid="ai-confirm"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-undo"]'), 'undo offer');
      assert.equal(h.document.querySelector('[data-testid="ai-flow-choice"]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-flow-choice-new"]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-flow-choice-replace"]'), null);
      assert.doesNotMatch(h.document.body.textContent ?? '', /Replace this flow/);
      assert.equal((h.ai.applyBodies.at(-1) as {replaceScenarioId?: string}).replaceScenarioId, undefined);
      await h.fill('Ask for changes', 'Send a receipt');
      const ask = h.document.querySelector('[aria-label="Ask for changes"]');
      assert.ok(ask);
      await act(async () => { ask.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})); });
      await h.until(() => h.ai.generations === 2, 'second flow generated');
      assert.equal(h.ai.undos, 0);
      assert.equal(h.ai.calls.includes('undo'), false);
      assert.deepEqual(h.ai.calls.filter(call => call === 'undo' || call === 'generate'), ['generate', 'generate']);
      assert.equal((h.ai.generationBodies.at(-1) as {previousJobId?: string; prompt?: string}).previousJobId, undefined);
      assert.equal((h.ai.generationBodies.at(-1) as {prompt?: string}).prompt, 'Send a receipt');
      assert.equal((await h.saved()).scenarios?.length ?? 0, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('undo is visible for 10 seconds after apply, then Versions remains', async () => {
    const h = await harness('ready');
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let undoTimer: (() => void) | undefined;
    let parked: ReturnType<typeof setTimeout> | undefined;
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (typeof fn === 'function' && ms === UNDO_WINDOW_MS) {
        undoTimer = () => fn(...args);
        parked = realSetTimeout(() => undefined, 60_000);
        return parked;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout;
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.confirmEnabled(), 'confirm');
      await h.click('[data-testid="ai-confirm"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-undo"]'), 'undo during the window');
      const capsule = h.document.querySelector('[data-testid="ai-capsule"]');
      assert.equal(h.document.querySelector<HTMLInputElement>('[aria-label="Ask for changes"]')?.placeholder, 'Ask for changes');
      assert.match(capsule?.textContent ?? '', /↶ Undo/);
      assert.equal(h.document.querySelector('[data-testid="ai-versions"]'), null);
      assert.doesNotMatch(capsule?.textContent ?? '', /Versions/);
      assert.equal(typeof undoTimer, 'function');
      await act(async () => { undoTimer?.(); });
      assert.equal(h.document.querySelector('[data-testid="ai-undo"]'), null);
      assert.ok(h.document.querySelector('[data-testid="ai-versions"]'));
      await h.click('[data-testid="ai-versions"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions-sheet"]'), 'sheet after the window');
      assert.equal(h.ai.undos, 0);
      assert.equal(h.ai.calls.includes('undo'), false);
    } finally {
      if (parked) realClearTimeout(parked);
      globalThis.setTimeout = realSetTimeout;
      await h.cleanup();
    }
  });

  await t.test('apply pushes one version and undo pops it', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.confirmEnabled(), 'confirm');
      await h.click('[data-testid="ai-confirm"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-undo"]'), 'undo offer');
      let stored: StoredVersions | undefined;
      await h.until(async () => { stored = await readVersions(h); return stored?.format === 1 && !!stored.current && (stored.flows?.[stored.current]?.length ?? 0) === 1; }, 'version stored');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
      stored = await readVersions(h);
      const flowId = stored?.current ?? '';
      const version = stored?.flows?.[flowId]?.[0];
      const saved = await h.saved();
      assert.equal(flowId, saved.scenarios?.[0]?.id);
      assert.equal(version?.title, 'Pay a bill');
      assert.equal(version?.draft.screens.every(screen => screen.kind === 'create'), true);
      assert.ok((version?.projection.screens.length ?? 0) >= 1);
      assert.equal((h.ai.applyBodies.at(-1) as {replaceScenarioId?: string}).replaceScenarioId, undefined);
      await h.click('[data-testid="ai-undo"]');
      await h.until(async () => { const next = await readVersions(h); return !next?.current && Object.keys(next?.flows ?? {}).length === 0; }, 'version popped');
      await h.until(() => !h.document.querySelector('[data-testid="ai-undo"]') && !h.document.querySelector('[data-testid="ai-versions"]'), 'neither undo nor versions');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
      const popped = await readVersions(h);
      assert.equal(popped?.current, undefined);
      assert.equal(Object.keys(popped?.flows ?? {}).length, 0);
      assert.equal((await h.saved()).scenarios?.length ?? 0, 0);
    } finally { await h.cleanup(); }
  });

  await t.test('the versions sheet previews a past row without writing and keeps Restore disabled', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.confirmEnabled(), 'confirm');
      await h.click('[data-testid="ai-confirm"]');
      await h.until(async () => (await readVersions(h))?.current !== undefined, 'version stored');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
      await h.unmount();
      const detail = await h.service.workspaceDetail(h.workspaceId);
      const view = detail.view as {aiVersions: StoredVersions};
      const flowId = view.aiVersions.current ?? '';
      const now = view.aiVersions.flows?.[flowId]?.at(-1);
      assert.ok(now);
      const older = structuredClone(now);
      older.id = 'older-version';
      older.title = 'First AI draft';
      older.createdAt = new Date(Date.now() - (2 * 60_000 + 1000)).toISOString();
      older.projection = {screens: [{key: 'home', title: 'Coordinator', x: 104, y: 200, steps: ['1 · Tap Coordinator']}], edges: []};
      await h.service.saveView(h.workspaceId, {aiVersions: {...view.aiVersions, flows: {...view.aiVersions.flows, [flowId]: [older, now]}}});
      await h.remount();
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions"]'), 'versions survive reload');
      await h.until(() => !!h.document.querySelector('[aria-label="Select screen Home"]'), 'home screen');
      await h.click('[aria-label="Select screen Home"]');
      await h.until(() => !!h.document.querySelector('.floating-inspector'), 'inspector');
      const before = h.documentOf(await h.saved());
      const revision = (await h.saved()).metadata?.revision ?? 0;
      await h.click('[data-testid="ai-versions"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions-sheet"]'), 'sheet');
      assert.equal(h.document.querySelector('.floating-inspector'), null);
      const sheet = h.document.querySelector('[data-testid="ai-versions-sheet"]');
      assert.equal(sheet?.getAttribute('role'), 'dialog');
      assert.equal(sheet?.getAttribute('aria-modal'), 'true');
      assert.ok(sheet?.getAttribute('aria-labelledby'));
      const list = h.document.querySelector('[role="listbox"]');
      assert.equal(list?.getAttribute('aria-label'), 'Flow versions');
      const options = [...h.document.querySelectorAll<HTMLElement>('[data-testid="ai-version-option"]')];
      assert.equal(options.length, 2);
      assert.match(options[0]?.textContent ?? '', /Pay a bill/);
      assert.match(options[0]?.textContent ?? '', /Now/);
      assert.match(options[0]?.textContent ?? '', /Just now/);
      assert.match(options[1]?.textContent ?? '', /First AI draft/);
      assert.match(options[1]?.textContent ?? '', /2 min ago/);
      assert.equal(h.document.activeElement, options[0]);
      assert.equal(list?.getAttribute('aria-activedescendant'), options[0]?.id);
      const viewport = h.document.querySelector<HTMLElement>('.canvas-viewport');
      assert.ok(viewport);
      const scroll = {left: viewport.scrollLeft, top: viewport.scrollTop};
      await act(async () => { sheet?.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true})); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-preview"]'), 'past preview');
      const previewScreen = h.document.querySelector<HTMLElement>('[data-testid="ai-version-screen"]');
      assert.match(previewScreen?.textContent ?? '', /Coordinator/);
      assert.equal(previewScreen?.style.left, '104px');
      assert.equal(previewScreen?.style.top, '200px');
      const pill = h.document.querySelector('[data-testid="ai-version-viewing"]');
      assert.match(pill?.textContent ?? '', /Viewing · 2 min ago/);
      assert.equal(pill?.closest('[data-testid="ai-version-preview"]'), null);
      assert.match(h.document.querySelector('[data-testid="sequence-scenario-name"]')?.textContent ?? '', /First AI draft · viewing earlier/);
      assert.equal(h.document.querySelector('[data-screen-id]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-draft-screen"]'), null);
      const restore = h.document.querySelector('[data-testid="ai-version-restore"]');
      assert.equal(restore?.getAttribute('aria-disabled'), null);
      assert.equal(restore?.hasAttribute('disabled'), false);
      assert.match(restore?.textContent ?? '', /✓ Restore/);
      assert.ok(h.document.querySelector('[data-testid="ai-version-keep"]'));
      assert.match(h.document.querySelector('.ai-versions-hint')?.textContent ?? '', /Restore checkpoints Now first/);
      assert.equal(viewport.scrollLeft, scroll.left);
      assert.equal(viewport.scrollTop, scroll.top);
      assert.equal((await h.saved()).metadata?.revision ?? 0, revision);
      assert.equal(h.documentOf(await h.saved()), before);
      await h.click('[data-testid="ai-version-keep"]');
      await h.until(() => !h.document.querySelector('[data-testid="ai-version-preview"]') && !!h.document.querySelector('[data-screen-id]'), 'back to now');
      assert.doesNotMatch(h.document.querySelector('[data-testid="sequence-scenario-name"]')?.textContent ?? '', /viewing earlier/);
      assert.match(h.document.querySelector('[aria-selected="true"]')?.textContent ?? '', /Now/);
      assert.match(h.document.querySelector('.ai-versions-hint')?.textContent ?? '', /Local on this Mac/);
      assert.equal((await h.saved()).metadata?.revision ?? 0, revision);
      await act(async () => { h.document.querySelector('[data-testid="ai-versions-sheet"]')?.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true})); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-preview"]'), 'preview again');
      const openSheet = h.document.querySelector('[data-testid="ai-versions-sheet"]');
      await act(async () => { openSheet?.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})); });
      await h.until(() => !h.document.querySelector('[data-testid="ai-versions-sheet"]') && !h.document.querySelector('[data-testid="ai-version-preview"]'), 'sheet closed');
      assert.equal(h.document.activeElement, h.document.querySelector('[data-testid="ai-versions"]'));
      assert.equal((await h.saved()).metadata?.revision ?? 0, revision);
      assert.equal(h.documentOf(await h.saved()), before);
    } finally { await h.cleanup(); }
  });

  await t.test('dismissing a pending draft keeps the applied flow, the stack, and the revision', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.confirmEnabled(), 'confirm');
      await h.click('[data-testid="ai-confirm"]');
      await h.until(async () => (await readVersions(h))?.current !== undefined, 'version stored');
      await h.fill('Ask for changes', 'Send a receipt');
      const ask = h.document.querySelector('[aria-label="Ask for changes"]');
      assert.ok(ask);
      await act(async () => { ask.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-discard"]'), 'pending draft');
      const revision = (await h.saved()).metadata?.revision ?? 0;
      const before = h.documentOf(await h.saved());
      const stack = JSON.stringify(await readVersions(h));
      assert.equal(h.ai.undos, 0);
      await h.click('[data-testid="ai-discard"]');
      await h.until(() => !h.document.querySelector('[data-testid="ai-discard"]') && h.status() === 'idle', 'draft dismissed');
      assert.equal(h.ai.undos, 0);
      assert.equal(h.ai.calls.includes('undo'), false);
      assert.equal((await h.saved()).metadata?.revision ?? 0, revision);
      assert.equal(h.documentOf(await h.saved()), before);
      assert.equal((await h.saved()).scenarios?.length ?? 0, 1);
      assert.equal(JSON.stringify(await readVersions(h)), stack);
    } finally { await h.cleanup(); }
  });

  await t.test('a second apply overwrites the same scenario and pushes one version', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await describeAndApply(h, 'Pay the electric bill');
      const first = await h.saved();
      const id = first.scenarios?.[0]?.id ?? '';
      const count = first.scenarios?.length ?? 0;
      assert.equal(count, 1);
      assert.equal(h.ai.undos, 0);
      await describeAndApply(h, 'Send a receipt');
      const saved = await h.saved();
      assert.equal(saved.scenarios?.length, count);
      assert.equal(saved.scenarios?.[0]?.id, id);
      assert.equal(saved.scenarios?.[0]?.name, 'Send a receipt');
      assert.equal(saved.canvas?.screens?.some(screen => screen.title === 'Receipt'), true);
      const previews = h.ai.previewBodies as {replaceScenarioId?: string}[];
      assert.equal(previews.some(body => body.replaceScenarioId === id), true);
      assert.equal(previews[0]?.replaceScenarioId, undefined);
      await h.until(async () => (await readVersions(h))?.flows?.[id]?.length === 2, 'both versions stored');
      const stack = await readVersions(h);
      assert.equal(stack?.current, id);
      assert.deepEqual(stack?.flows?.[id]?.map(item => item.title), ['Pay a bill', 'Send a receipt']);
      assert.equal(h.ai.undos, 0);
      assert.equal(h.ai.calls.includes('undo'), false);
    } finally { await h.cleanup(); }
  });

  await t.test('restore checkpoints before preview and settles the past version as Now', async () => {
    const h = await harness('ready');
    const undoWindow = captureUndoWindow();
    try {
      await h.render();
      await describeAndApply(h, 'Pay the electric bill');
      await describeAndApply(h, 'Send a receipt');
      const id = (await h.saved()).scenarios?.[0]?.id ?? '';
      await h.until(async () => (await readVersions(h))?.flows?.[id]?.length === 2, 'two versions');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
      const beforeStack = await readVersions(h);
      const mark = h.requests.length;
      await act(async () => { undoWindow.flush(); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions"]') && !h.document.querySelector('[data-testid="ai-undo"]'), 'versions after the undo window');
      await h.click('[data-testid="ai-versions"]');
      await h.until(() => h.document.querySelectorAll('[data-testid="ai-version-option"]').length === 2, 'rows');
      const past = h.document.querySelectorAll<HTMLElement>('[data-testid="ai-version-option"]')[1];
      assert.ok(past);
      await act(async () => { past.click(); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-preview"]'), 'past preview');
      await h.click('[data-testid="ai-version-restore"]');
      await h.until(async () => {
        const next = await readVersions(h);
        const list = next?.flows?.[id] ?? [];
        return list.length === 3 && list[0]?.title === 'Pay a bill' && list[1]?.title === 'Send a receipt' && list[2]?.title === 'Pay a bill';
      }, 'stack is v1, v2, v1 now');
      const slice = h.requests.slice(mark);
      const previewAt = slice.findIndex(item => item.path === '/api/authoring/preview');
      const applyAt = slice.findIndex(item => item.path === '/api/authoring/apply');
      const viewAt = slice.findIndex(item => item.path.endsWith('/view') && ((item.body?.aiVersions as StoredVersions | undefined)?.flows?.[id]?.length ?? 0) === 3);
      assert.ok(viewAt >= 0 && previewAt > viewAt && applyAt > previewAt, 'checkpoint view write before preview and apply');
      const checkpoint = ((slice[viewAt]?.body?.aiVersions as StoredVersions).flows?.[id] ?? []);
      assert.equal(checkpoint.at(-1)?.title, 'Send a receipt');
      assert.notEqual(checkpoint.at(-1)?.id, beforeStack?.flows?.[id]?.[1]?.id);
      const previewBody = slice[previewAt]?.body as {replaceScenarioId?: string; draft?: FlowDraft; placements?: Record<string, {x: number; y: number}>};
      assert.equal(previewBody.replaceScenarioId, id);
      assert.equal(previewBody.draft?.name, 'Pay a bill');
      assert.ok(previewBody.placements && Object.keys(previewBody.placements).length > 0);
      const final = await readVersions(h);
      assert.equal(final?.flows?.[id]?.[0]?.id, beforeStack?.flows?.[id]?.[0]?.id);
      assert.equal(final?.flows?.[id]?.[1]?.id, beforeStack?.flows?.[id]?.[1]?.id);
      assert.notEqual(final?.flows?.[id]?.at(-1)?.id, checkpoint.at(-1)?.id);
      const saved = await h.saved();
      assert.equal(saved.scenarios?.length, 1);
      assert.equal(saved.scenarios?.[0]?.id, id);
      assert.equal(saved.scenarios?.[0]?.name, 'Pay a bill');
      assert.equal(saved.canvas?.screens?.some(screen => screen.title === 'Receipt'), false);
      assert.ok(h.document.querySelector('[data-testid="ai-versions-sheet"]'));
      assert.equal(h.document.querySelector('[data-testid="ai-version-preview"]'), null);
      assert.match(h.document.querySelector('[aria-selected="true"]')?.textContent ?? '', /Now/);
      assert.match(h.document.querySelector('[aria-selected="true"]')?.textContent ?? '', /Pay a bill/);
      await h.click('[data-testid="ai-undo"]');
      await h.until(async () => (await readVersions(h))?.flows?.[id]?.length === 2, 'undo popped the restored entry');
      const undone = await h.saved();
      assert.equal(undone.scenarios?.[0]?.id, id);
      assert.equal(undone.scenarios?.[0]?.name, 'Send a receipt');
      assert.equal(undone.canvas?.screens?.some(screen => screen.title === 'Receipt'), true);
      assert.equal(h.ai.calls.filter(call => call === 'undo').length, 1);
    } finally { undoWindow.restore(); await h.cleanup(); }
  });

  await t.test('restoring a later version still works after its screens were overwritten', async () => {
    const h = await harness('ready');
    const undoWindow = captureUndoWindow();
    try {
      await h.render();
      await describeAndApply(h, 'Pay the electric bill');
      await describeAndApply(h, 'Send a receipt');
      const id = (await h.saved()).scenarios?.[0]?.id ?? '';
      await h.until(async () => (await readVersions(h))?.flows?.[id]?.length === 2, 'two versions');
      const before = await readVersions(h);
      const receipt = before?.flows?.[id]?.[1];
      assert.ok(receipt);
      assert.equal(receipt.draft.screens.every(screen => screen.kind === 'create'), true);
      await act(async () => { undoWindow.flush(); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions"]') && !h.document.querySelector('[data-testid="ai-undo"]'), 'versions after the undo window');
      await h.click('[data-testid="ai-versions"]');
      await h.until(() => h.document.querySelectorAll('[data-testid="ai-version-option"]').length === 2, 'rows');
      await act(async () => { h.document.querySelectorAll<HTMLElement>('[data-testid="ai-version-option"]')[1]?.click(); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-restore"]'), 'restore v1');
      await h.click('[data-testid="ai-version-restore"]');
      await h.until(async () => (await readVersions(h))?.flows?.[id]?.at(-1)?.title === 'Pay a bill' && (await readVersions(h))?.flows?.[id]?.length === 3, 'v1 restored');
      const option = [...h.document.querySelectorAll<HTMLElement>('[data-testid="ai-version-option"]')].find(item => item.dataset.versionId === receipt.id);
      assert.ok(option);
      const calls = h.requests.length;
      await act(async () => { option.click(); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-preview"]'), 'v2 preview');
      await h.click('[data-testid="ai-version-restore"]');
      await h.until(async () => (await readVersions(h))?.flows?.[id]?.at(-1)?.title === 'Send a receipt', 'v2 restored');
      const preview = h.requests.slice(calls).find(item => item.path === '/api/authoring/preview')?.body as {draft?: FlowDraft; replaceScenarioId?: string} | undefined;
      assert.equal(preview?.replaceScenarioId, id);
      assert.equal(preview?.draft?.screens.every(screen => screen.kind === 'create'), true);
      const saved = await h.saved();
      assert.equal(saved.scenarios?.length, 1);
      assert.equal(saved.scenarios?.[0]?.id, id);
      assert.equal(saved.scenarios?.[0]?.name, 'Send a receipt');
      assert.equal(saved.canvas?.screens?.some(screen => screen.title === 'Receipt'), true);
      assert.equal(h.ai.calls.includes('undo'), false);
    } finally { undoWindow.restore(); await h.cleanup(); }
  });

  await t.test('a failed restore leaves the stack and the workspace unchanged', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await describeAndApply(h, 'Pay the electric bill');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
      const detail = await h.service.workspaceDetail(h.workspaceId);
      const view = detail.view as {aiVersions: StoredVersions};
      const flowId = view.aiVersions.current ?? '';
      const now = view.aiVersions.flows?.[flowId]?.at(-1);
      assert.ok(now);
      const older = structuredClone(now);
      older.id = 'older-version';
      older.title = 'First AI draft';
      older.createdAt = new Date(Date.now() - 120_000).toISOString();
      await h.service.saveView(h.workspaceId, {aiVersions: {...view.aiVersions, flows: {...view.aiVersions.flows, [flowId]: [older, now]}}});
      await h.remount();
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions"]'), 'versions');
      const revision = (await h.saved()).metadata?.revision ?? 0;
      const before = h.documentOf(await h.saved());
      const stack = JSON.stringify(await readVersions(h));
      await h.click('[data-testid="ai-versions"]');
      await h.until(() => h.document.querySelectorAll('[data-testid="ai-version-option"]').length === 2, 'rows');
      await act(async () => { h.document.querySelector('[data-testid="ai-versions-sheet"]')?.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true})); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-restore"]'), 'restore');
      h.ai.failNextApply();
      await h.click('[data-testid="ai-version-restore"]');
      await h.until(() => /revision does not match/.test(h.document.querySelector('[data-testid="ai-version-restore-error"]')?.textContent ?? ''), 'inline error');
      const error = h.document.querySelector('[data-testid="ai-version-restore-error"]');
      assert.equal(error?.closest('[data-testid="ai-versions-sheet"]'), h.document.querySelector('[data-testid="ai-versions-sheet"]'));
      assert.equal((await h.saved()).metadata?.revision ?? 0, revision);
      assert.equal(h.documentOf(await h.saved()), before);
      assert.equal(JSON.stringify(await readVersions(h)), stack);
      assert.equal((await h.saved()).scenarios?.length ?? 0, 1);
    } finally { await h.cleanup(); }
  });

  await t.test('restore stays disabled while a draft is pending or a run is active', async () => {
    const h = await harness('ready', {deviceId: 'E5C92F6E-40DC-493C-93B4-469E67193736'});
    try {
      await h.render();
      await describeAndApply(h, 'Pay the electric bill');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
      const detail = await h.service.workspaceDetail(h.workspaceId);
      const view = detail.view as {aiVersions: StoredVersions};
      const flowId = view.aiVersions.current ?? '';
      const now = view.aiVersions.flows?.[flowId]?.at(-1);
      assert.ok(now);
      const older = structuredClone(now);
      older.id = 'older-version';
      older.title = 'First AI draft';
      await h.service.saveView(h.workspaceId, {aiVersions: {...view.aiVersions, flows: {...view.aiVersions.flows, [flowId]: [older, now]}}});
      await h.remount();
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions"]'), 'versions after reload');
      await h.click('[data-testid="ai-versions"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions-sheet"]'), 'sheet');
      await act(async () => { h.document.querySelector('[data-testid="ai-versions-sheet"]')?.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true})); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-restore"]'), 'restore');
      assert.equal(h.document.querySelector('[data-testid="ai-version-restore"]')?.getAttribute('aria-disabled'), null);
      assert.match(h.document.querySelector('.ai-versions-hint')?.textContent ?? '', /Restore checkpoints Now first/);
      await h.fill('Ask for changes', 'Send a receipt');
      const ask = h.document.querySelector('[aria-label="Ask for changes"]');
      assert.ok(ask);
      await act(async () => { ask.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})); });
      for (let attempt = 0; attempt < 20; attempt++) {
        if (h.document.querySelector('[data-testid="ai-disclosure-continue"]')) { await h.click('[data-testid="ai-disclosure-continue"]'); break; }
        if (h.status() === 'generating' || h.status() === 'pending' || h.status() === 'needsInfo') break;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
      }
      await h.until(() => h.confirmEnabled(), 'pending draft');
      assert.equal(h.document.querySelector('[data-testid="ai-versions-sheet"]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-versions"]'), null);
      assert.ok(h.document.querySelector('[data-testid="ai-confirm"]'));
      assert.ok(h.document.querySelector('[data-testid="ai-discard"]'));
      assert.match(restoreBlockReason(false, {status: 'pending', prompt: 'Send a receipt', draft: {schemaVersion: 1} as FlowDraft}, false) ?? '', /draft is pending/);
      const revision = (await h.saved()).metadata?.revision ?? 0;
      const applies = h.ai.applies;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
      assert.equal(h.ai.applies, applies);
      assert.equal((await h.saved()).metadata?.revision ?? 0, revision);
      await h.click('[data-testid="ai-discard"]');
      await h.until(() => h.status() === 'idle', 'dismissed');
      await openScenarioPanel(h.document, act);
      await h.click('[aria-label="Run scenario"]');
      await h.until(() => h.document.querySelector('.result-tag')?.textContent === 'running', 'running');
      if (!h.document.querySelector('[data-testid="ai-versions-sheet"]')) await h.click('[data-testid="ai-versions"]');
      if (!h.document.querySelector('[data-testid="ai-version-restore"]')) {
        await act(async () => { h.document.querySelector('[data-testid="ai-versions-sheet"]')?.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true})); });
      }
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-restore"]'), 'restore during run');
      assert.equal(h.document.querySelector('[data-testid="ai-version-restore"]')?.getAttribute('aria-disabled'), 'true');
      assert.match(h.document.querySelector('.ai-versions-hint')?.textContent ?? '', /run is active/);
    } finally { await h.cleanup(); }
  });

  await t.test('undo click leaves Versions only while history remains', async () => {
    const h = await harness('ready');
    const undoWindow = captureUndoWindow();
    try {
      await h.render();
      await describeAndApply(h, 'Pay the electric bill');
      assert.equal(h.document.querySelector('[data-testid="ai-versions"]'), null);
      await h.click('[data-testid="ai-undo"]');
      await h.until(() => !h.document.querySelector('[data-testid="ai-undo"]') && !h.document.querySelector('[data-testid="ai-versions"]'), 'only version popped');
      await describeAndApply(h, 'Pay the electric bill');
      await describeAndApply(h, 'Send a receipt');
      assert.ok(h.document.querySelector('[data-testid="ai-undo"]'));
      assert.equal(h.document.querySelector('[data-testid="ai-versions"]'), null);
      await h.click('[data-testid="ai-undo"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions"]') && !h.document.querySelector('[data-testid="ai-undo"]'), 'versions after a partial undo');
    } finally { undoWindow.restore(); await h.cleanup(); }
  });

  await t.test('a draft capsule never shows Versions', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await h.generate('Pay the electric bill');
      await h.until(() => h.confirmEnabled(), 'first draft');
      assert.ok(h.document.querySelector('[data-testid="ai-confirm"]'));
      assert.ok(h.document.querySelector('[data-testid="ai-discard"]'));
      assert.equal(h.document.querySelector('[data-testid="ai-versions"]'), null);
      await h.click('[data-testid="ai-confirm"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-undo"]'), 'applied');
      await h.until(async () => (await readVersions(h))?.current !== undefined, 'history');
      await h.fill('Ask for changes', 'Send a receipt');
      const ask = h.document.querySelector('[aria-label="Ask for changes"]');
      assert.ok(ask);
      await act(async () => { ask.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})); });
      for (let attempt = 0; attempt < 20; attempt++) {
        if (h.document.querySelector('[data-testid="ai-disclosure-continue"]')) { await h.click('[data-testid="ai-disclosure-continue"]'); break; }
        if (h.status() === 'generating' || h.status() === 'pending' || h.status() === 'needsInfo' || h.status() === 'stale' || h.status() === 'failed') break;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
      }
      await h.until(() => h.confirmEnabled(), 'refine draft');
      assert.ok(h.document.querySelector('[data-testid="ai-confirm"]'));
      assert.ok(h.document.querySelector('[data-testid="ai-discard"]'));
      assert.equal(h.document.querySelector('[data-testid="ai-versions"]'), null);
      assert.equal(h.document.querySelector('[data-testid="ai-undo"]'), null);
    } finally { await h.cleanup(); }
  });

  await t.test('restore shows Undo only beside the open sheet and Esc focuses that control', async () => {
    const h = await harness('ready');
    const undoWindow = captureUndoWindow();
    try {
      await h.render();
      await describeAndApply(h, 'Pay the electric bill');
      await describeAndApply(h, 'Send a receipt');
      await act(async () => { undoWindow.flush(); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions"]') && !h.document.querySelector('[data-testid="ai-undo"]'), 'versions after the window');
      await h.click('[data-testid="ai-versions"]');
      await h.until(() => h.document.querySelectorAll('[data-testid="ai-version-option"]').length === 2, 'rows');
      const past = h.document.querySelectorAll<HTMLElement>('[data-testid="ai-version-option"]')[1];
      assert.ok(past);
      await act(async () => { past.click(); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-restore"]'), 'restore');
      await h.click('[data-testid="ai-version-restore"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions-sheet"]') && !!h.document.querySelector('[data-testid="ai-undo"]') && !h.document.querySelector('[data-testid="ai-versions"]'), 'undo only beside the open sheet');
      const sheet = h.document.querySelector('[data-testid="ai-versions-sheet"]');
      await act(async () => { sheet?.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})); });
      await h.until(() => !h.document.querySelector('[data-testid="ai-versions-sheet"]'), 'sheet closed');
      assert.notEqual(h.document.activeElement, h.document.body);
      assert.equal(h.document.activeElement, h.document.querySelector('[data-testid="ai-undo"]'));
    } finally { undoWindow.restore(); await h.cleanup(); }
  });

  await t.test('undo while the versions sheet is open focuses a mounted capsule control', async () => {
    const h = await harness('ready');
    const undoWindow = captureUndoWindow();
    try {
      await h.render();
      await describeAndApply(h, 'Pay the electric bill');
      await describeAndApply(h, 'Send a receipt');
      await act(async () => { undoWindow.flush(); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions"]') && !h.document.querySelector('[data-testid="ai-undo"]'), 'versions after the window');
      await h.click('[data-testid="ai-versions"]');
      await h.until(() => h.document.querySelectorAll('[data-testid="ai-version-option"]').length === 2, 'rows');
      const past = h.document.querySelectorAll<HTMLElement>('[data-testid="ai-version-option"]')[1];
      assert.ok(past);
      await act(async () => { past.click(); });
      await h.until(() => !!h.document.querySelector('[data-testid="ai-version-restore"]'), 'restore');
      await h.click('[data-testid="ai-version-restore"]');
      await h.until(() => !!h.document.querySelector('[data-testid="ai-versions-sheet"]') && !!h.document.querySelector('[data-testid="ai-undo"]') && !h.document.querySelector('[data-testid="ai-versions"]'), 'undo only beside the open sheet');
      await h.click('[data-testid="ai-undo"]');
      await h.until(() => !h.document.querySelector('[data-testid="ai-versions-sheet"]') && !!h.document.querySelector('[data-testid="ai-versions"]') && !h.document.querySelector('[data-testid="ai-undo"]'), 'sheet closed onto Versions');
      const versions = h.document.querySelector<HTMLElement>('[data-testid="ai-versions"]');
      assert.ok(versions?.isConnected);
      assert.notEqual(h.document.activeElement, h.document.body);
      assert.equal(h.document.activeElement, versions);
    } finally { undoWindow.restore(); await h.cleanup(); }
  });

  await t.test('a deleted AI flow is created again instead of replaced', async () => {
    const h = await harness('ready');
    try {
      await h.render();
      await describeAndApply(h, 'Pay the electric bill');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
      const saved = await h.saved();
      const gone = saved.scenarios?.[0]?.id ?? '';
      await h.service.save({
        id: saved.id, name: saved.name, yaml: saved.yaml, flows: saved.flows, mock: saved.mock, automation: saved.automation,
        canvas: {screens: [], edges: [], paths: []}, scenarios: [], expectedRevision: saved.metadata?.revision ?? 0,
      });
      await h.remount();
      await h.until(() => h.status() === 'idle' || !!h.document.querySelector('[data-testid="ai-flow-button"]') || !!h.document.querySelector('[aria-label="Ask for changes"]'), 'reloaded');
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
      const mark = h.ai.previewBodies.length;
      await describeAndApply(h, 'Send a receipt');
      const next = await h.saved();
      assert.equal(next.scenarios?.length, 1);
      assert.notEqual(next.scenarios?.[0]?.id, gone);
      const later = (h.ai.previewBodies as {replaceScenarioId?: string}[]).slice(mark);
      assert.ok(later.length >= 1);
      assert.equal(later.every(body => body.replaceScenarioId === undefined), true);
      const created = next.scenarios?.[0]?.id;
      await h.until(async () => (await readVersions(h))?.current === created, 'current follows the new scenario');
    } finally { await h.cleanup(); }
  });
});

type StoredVersions = {
  format?: number;
  current?: string;
  flows?: Record<string, {id: string; title: string; createdAt: string; draft: FlowDraft; placements: Record<string, {x: number; y: number}>; projection: {screens: {key: string; title: string; x: number; y: number; steps: string[]}[]; edges: {from: string; to: string; label: string}[]}}[]>;
};

function captureUndoWindow() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let undoTimer: (() => void) | undefined;
  const parked: ReturnType<typeof setTimeout>[] = [];
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof fn === 'function' && ms === UNDO_WINDOW_MS) {
      undoTimer = () => fn(...args);
      const id = realSetTimeout(() => undefined, 60_000);
      parked.push(id);
      return id;
    }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  return {
    flush() {
      const run = undoTimer;
      undoTimer = undefined;
      run?.();
    },
    restore() {
      for (const id of parked) realClearTimeout(id);
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

async function describeAndApply(h: Awaited<ReturnType<typeof harness>>, prompt: string) {
  sizeViewport(h.document);
  const asking = h.document.querySelector('[aria-label="Ask for changes"]');
  if (asking) {
    await h.fill('Ask for changes', prompt);
    await act(async () => { asking.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true})); });
  } else await h.generate(prompt);
  for (let attempt = 0; attempt < 20; attempt++) {
    const disclosure = h.document.querySelector('[data-testid="ai-disclosure-continue"]');
    if (disclosure) { await h.click('[data-testid="ai-disclosure-continue"]'); break; }
    const status = h.status();
    if (status === 'generating' || status === 'pending' || status === 'needsInfo' || status === 'stale' || status === 'failed') break;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  }
  if (h.status() === 'stale' && h.document.querySelector('[data-testid="ai-refresh"]')) await h.click('[data-testid="ai-refresh"]');
  await h.until(() => h.confirmEnabled(), 'confirm ' + prompt);
  await h.until(() => {
    const nodes = [...h.document.querySelectorAll<HTMLElement>('[data-draft-screen]')];
    return nodes.length > 0 && nodes.every(node => Number.isFinite(parseFloat(node.style.left)) && Number.isFinite(parseFloat(node.style.top)));
  }, 'draft cards ' + prompt);
  await untilPlacements(h);
  await h.click('[data-testid="ai-confirm"]');
  await h.until(() => !!h.document.querySelector('[data-testid="ai-undo"]'), 'undo after ' + prompt);
}

async function readVersions(h: {workspaceId: string; service: {workspaceDetail: (id: string) => Promise<{view?: unknown}>}}): Promise<StoredVersions | undefined> {
  const detail = await h.service.workspaceDetail(h.workspaceId);
  const view = detail.view && typeof detail.view === 'object' ? detail.view as {aiVersions?: StoredVersions} : {};
  return view.aiVersions;
}

type Mode = 'ready' | 'hold' | 'expired' | 'needs' | 'invalid' | 'authoring-failed' | 'asks' | 'on-existing';
type StoredPreview = {preview: Preview; placements?: Record<string, {x: number; y: number}>; draft?: FlowDraft; replaceScenarioId?: string};

function placementRecord(value: unknown): Record<string, {x: number; y: number}> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const placements: Record<string, {x: number; y: number}> = {};
  for (const [key, point] of Object.entries(value)) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) return;
    const x = (point as {x?: unknown}).x;
    const y = (point as {y?: unknown}).y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    placements[key] = {x, y};
  }
  return Object.keys(placements).length ? placements : undefined;
}

function placedScreens(stored: StoredPreview | undefined, stamp: string) {
  const placements = stored?.placements;
  const draft = stored?.draft;
  if (!placements || !draft?.screens) return [];
  return draft.screens.flatMap(screen => {
    if (screen.kind !== 'create') return [];
    const point = placements[screen.key];
    if (!point) return [];
    return [{id: 'screen' + stamp + screen.key, title: screen.title, x: point.x, y: point.y, tests: []}];
  });
}

function sizeViewport(document: Document) {
  const viewport = document.querySelector<HTMLElement>('.canvas-viewport');
  assert.ok(viewport, 'canvas viewport');
  Object.defineProperty(viewport, 'clientWidth', {configurable: true, value: 1280});
  Object.defineProperty(viewport, 'clientHeight', {configurable: true, value: 800});
}

function drawnDraft(document: Document) {
  const points: Record<string, {x: number; y: number}> = {};
  for (const node of document.querySelectorAll<HTMLElement>('[data-draft-screen]')) {
    const key = node.dataset.draftScreen ?? '';
    points[key] = {x: parseFloat(node.style.left), y: parseFloat(node.style.top)};
  }
  return points;
}

async function untilPlacements(h: Awaited<ReturnType<typeof harness>>) {
  await h.until(() => {
    const body = h.ai.previewBodies.at(-1) as {placements?: Record<string, {x: number; y: number}>} | undefined;
    const drawn = drawnDraft(h.document);
    const placements = body?.placements;
    const drawnKeys = Object.keys(drawn);
    if (!placements || !drawnKeys.length) return false;
    const keys = Object.keys(placements);
    return keys.length === drawnKeys.length && keys.every(key => {
      const point = drawn[key];
      const sent = placements[key];
      return !!point && !!sent && Math.abs(point.x - sent.x) < 0.001 && Math.abs(point.y - sent.y) < 0.001;
    });
  }, 'preview placements match the drawn cards');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

function samePoint(left: {x: number; y: number} | undefined, right: {x: number; y: number} | undefined) {
  assert.ok(left && right);
  assert.ok(Math.abs(left.x - right.x) < 0.001 && Math.abs(left.y - right.y) < 0.001, JSON.stringify(left) + ' vs ' + JSON.stringify(right));
}
type AskedQuestion = {key: string; about?: string; text: string; options: string[]};
type Job = {id: string; workspaceId: string; baseRevision: number; state: 'running' | 'pending' | 'needsInfo' | 'failed' | 'cancelled'; phase: GenerationView['phase']; draft?: FlowDraft | Record<string, unknown>; preview?: Preview; model?: string; upstreamProvider?: string; questions?: AskedQuestion[]; error?: {code: string; message: string; retryable: boolean}};
type ScenarioService = ReturnType<typeof createScenarios>;

type CatalogFixture = {id: string; name?: string};
type HarnessOptions = {deviceId?: string; failSave?: boolean; unconfigured?: boolean; savedModel?: string; catalog?: CatalogFixture[]; failCatalog?: boolean};

function wideCatalog(): CatalogFixture[] {
  const models: CatalogFixture[] = [];
  for (let index = 0; index < 300; index++) models.push({id: `other/model-${index}`, name: `Other ${index}`});
  for (let index = 0; index < 12; index++) models.push({id: `openai/gpt-4.${index}`, name: `GPT ${index}`});
  models.push({id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet'});
  models.push({id: 'anthropic/claude-haiku-4.5'});
  models.push({id: 'custom/writer', name: 'House Claude draft'});
  return models;
}

function catalogIds(document: Document) {
  return [...document.querySelectorAll<HTMLElement>('.ai-catalog-row')].map(row => row.dataset.modelId ?? '');
}

function catalogTotal(document: Document) {
  const more = Number(/^(\d+) more/.exec(document.querySelector('[data-testid="ai-catalog-more"]')?.textContent ?? '')?.[1] ?? 0);
  return document.querySelectorAll('.ai-catalog-row').length + more;
}

async function harness(mode: Mode, options: HarnessOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-ai-flow-ui-'));
  const service = createScenarios({
    root: directory,
    trustDirectory: join(directory, 'trust'),
    runner: createRunner({artifactDirectory: directory, execute: async () => ({stdout: '', stderr: ''})}),
    maestro: {version: async () => '0', run: async () => ({code: 0, log: '', cleanup: {verified: true, detail: 'ok'}})},
  });
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'];
  const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class ResizeObserver { observe() {} disconnect() {} }
  const ai = createFake(mode, service, options);
  let workspaceId = '';
  const runs = new Map<string, unknown>();
  const requests: {method: string; path: string; body?: Record<string, unknown>}[] = [];
  const fetchImpl = async (path: string, init?: {method?: string; body?: string}) => {
    const url = new URL(path, 'http://tnt.local');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({method, path: url.pathname, ...(body ? {body: structuredClone(body)} : {})});
    try {
      if (method === 'GET' && url.pathname === '/api/workspaces') return Response.json(await service.listWorkspaces(url.searchParams.get('q') ?? ''));
      const opened = /^\/api\/workspaces\/([0-9a-f-]{36})\/open$/.exec(url.pathname);
      if (method === 'POST' && opened) return Response.json(await service.openWorkspace(opened[1]));
      if (url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/api/authoring/')) {
        const result = await ai.route(method, url.pathname + url.search, body);
        if (method === 'POST' && url.pathname === '/api/ai/generations' && body && typeof body.workspaceId === 'string') workspaceId = body.workspaceId;
        return Response.json(result.body, {status: result.status});
      }
      if (method === 'POST' && url.pathname === '/api/workspaces') {
        if (options.failSave) return Response.json({error: 'The workspace was changed.', code: 'REVISION_CONFLICT'}, {status: 409});
        const saved = await service.save(body as never);
        workspaceId = saved.id;
        return Response.json(saved);
      }
      if (method === 'GET' && url.pathname === '/api/session') return Response.json(await service.session());
      if (method === 'POST' && url.pathname === '/api/canvas/references') return Response.json(await service.references(body as never));
      if (method === 'GET' && url.pathname === '/api/scripts/trust') return Response.json({scripts: []});
      if (method === 'POST' && url.pathname === '/api/runs') {
        const id = '11111111-1111-4111-8111-111111111111';
        const run = runningRun(id, String(body?.workspaceId ?? ''), String(body?.deviceId ?? ''));
        runs.set(id, run);
        return Response.json(run, {status: 202});
      }
      const run = /^\/api\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (method === 'GET' && run) return Response.json(runs.get(run[1]) ?? {error: 'Missing run.'}, {status: runs.has(run[1]) ? 200 : 404});
      const workspace = /^\/api\/workspaces\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (method === 'GET' && workspace) return Response.json(await service.workspaceDetail(workspace[1]));
      const view = /^\/api\/workspaces\/([0-9a-f-]{36})\/view$/.exec(url.pathname);
      if (method === 'POST' && view) return Response.json(await service.saveView(view[1], body));
      return Response.json({error: 'Unknown ' + method + ' ' + url.pathname}, {status: 404});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : 'Request failed.'}, {status: 400});
    }
  };
  for (const key of keys) Object.defineProperty(globalThis, key, {value: key === 'fetch' ? fetchImpl : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'ResizeObserver' ? ResizeObserver : Reflect.get(dom.window, key), configurable: true});
  const {createRoot} = await import('react-dom/client');
  const document = dom.window.document;
  let root = createRoot(document.getElementById('root')!);
  let mounted = true;
  const render = (recover = false) => act(async () => { root.render(createElement(Scenarios, {token: 'local', deviceId: options.deviceId ?? '', bundleId: 'com.example.HybridApp', launchBusy: false, onRunning: () => {}, recoverSession: recover})); });
  const click = async (selector: string) => act(async () => { const node = document.querySelector<HTMLElement>(selector); assert.ok(node, selector); node.click(); });
  const clickText = async (text: string) => act(async () => { const node = [...document.querySelectorAll('button')].find(button => button.textContent === text); assert.ok(node, text); node.click(); });
  const fill = async (label: string, value: string) => act(async () => {
    const node = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
    assert.ok(node, label);
    const proto = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
  });
  const until = async (read: () => boolean | Promise<boolean>, label: string) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await read()) return;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    }
    assert.fail(label + ' — status ' + (document.querySelector('[data-testid="ai-flow"]')?.getAttribute('data-ai-status') ?? 'missing') + ' — ' + (document.body.textContent ?? '').slice(0, 400));
  };
  return {
    dom, document, service, ai, requests,
    get workspaceId() { return workspaceId; },
    status: () => document.querySelector('[data-testid="ai-flow"]')?.getAttribute('data-ai-status') ?? '',
    reason: () => document.querySelector('[data-testid="ai-confirm-reason"]')?.textContent ?? '',
    confirmEnabled: () => { const button = document.querySelector('[data-testid="ai-confirm"]'); return !!button && button.getAttribute('aria-disabled') !== 'true'; },
    positions: () => [...document.querySelectorAll<HTMLElement>('[data-screen-id]')].map(node => node.dataset.screenId + ':' + node.style.left + ':' + node.style.top).join('|'),
    saved: () => service.workspace(workspaceId),
    documentOf: (workspace: {name: string; yaml: string; flows?: unknown; scenarios?: unknown; canvas?: unknown; automation?: unknown; mock?: unknown}) => JSON.stringify({name: workspace.name, yaml: workspace.yaml, flows: workspace.flows ?? {}, scenarios: workspace.scenarios ?? [], canvas: workspace.canvas ?? null, automation: workspace.automation ?? null, mock: workspace.mock ?? null}),
    render, click, clickText, fill, until,
    untilJobId: async () => {
      let jobId = '';
      await until(async () => {
        const detail = await service.workspaceDetail(workspaceId);
        const stored = detail.view && typeof detail.view === 'object' ? (detail.view as {aiDraft?: {jobId?: string}}).aiDraft : undefined;
        jobId = stored?.jobId ?? '';
        return jobId.length > 0;
      }, 'persisted job id');
      return jobId;
    },
    openSettings: async () => {
      if (!document.querySelector('[data-testid="ai-settings"]')) {
        if (!document.querySelector('[aria-label="Flow description"]')) await click('[data-testid="ai-flow-button"]');
        await click('[data-testid="ai-provider-chip"]');
      }
      await until(() => !!document.querySelector('[data-testid="ai-api-key"]'), 'ai settings');
    },
    generate: async (prompt: string) => {
      await click('[data-testid="ai-flow-button"]');
      await fill('Flow description', prompt);
      await click('[data-testid="ai-generate"]');
      for (let attempt = 0; attempt < 20; attempt++) {
        if (document.querySelector('[data-testid="ai-disclosure-continue"]')) {
          await click('[data-testid="ai-disclosure-continue"]');
          return;
        }
        const status = document.querySelector('[data-testid="ai-flow"]')?.getAttribute('data-ai-status');
        if (status === 'generating' || status === 'failed' || document.querySelector('[data-testid="ai-error"]')) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
      }
    },
    addNode: async () => {
      await act(async () => document.querySelector('.canvas-surface')!.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 120, clientY: 120})));
      await clickText('Add node');
    },
    unmount: async () => { if (!mounted) return; mounted = false; await act(async () => root.unmount()); },
    remount: async () => {
      if (mounted) { mounted = false; await act(async () => root.unmount()); }
      root = createRoot(document.getElementById('root')!);
      mounted = true;
      await render(true);
    },
    cleanup: async () => {
      if (mounted) { mounted = false; await act(async () => root.unmount()); }
      dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
      await rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
    },
  };
}

type FakeConfig = {
  settingsRevision: number;
  selected: 'openrouter' | 'openai-compatible';
  providers: Record<'openrouter' | 'openai-compatible', {model: string; baseUrl?: string; configured: boolean; keySource?: 'keychain' | 'session'; credentialRevision: number; storageAvailable: boolean}>;
};

function unconfiguredConfig(): FakeConfig {
  return {
    settingsRevision: 0,
    selected: 'openrouter',
    providers: {
      openrouter: {model: '', configured: false, credentialRevision: 0, storageAvailable: true},
      'openai-compatible': {model: '', baseUrl: 'https://api.openai.com/v1', configured: false, credentialRevision: 0, storageAvailable: true},
    },
  };
}

function applyPut(config: FakeConfig, body: Record<string, unknown> | undefined) {
  const id = body?.provider === 'openai-compatible' ? 'openai-compatible' : 'openrouter';
  const entry = config.providers[id];
  if (typeof body?.model === 'string') entry.model = body.model;
  if (typeof body?.baseUrl === 'string' && id === 'openai-compatible') entry.baseUrl = body.baseUrl;
  if (body?.selected === 'openrouter' || body?.selected === 'openai-compatible') config.selected = body.selected;
  const credential = body?.credential as {action?: string; apiKey?: string; storage?: string} | undefined;
  if (credential?.action === 'replace' && credential.apiKey) {
    entry.configured = true;
    entry.keySource = credential.storage === 'session' ? 'session' : 'keychain';
    entry.credentialRevision += 1;
  } else if (credential?.action === 'remove') {
    entry.configured = false;
    entry.keySource = undefined;
  }
  config.settingsRevision += 1;
  return structuredClone(config);
}

function savedConfig(model = 'vendor/model'): FakeConfig {
  return {
    settingsRevision: 2,
    selected: 'openrouter' as const,
    providers: {
      openrouter: {model, configured: true, keySource: 'keychain' as const, credentialRevision: 1, storageAvailable: true},
      'openai-compatible': {model: 'gpt-test', baseUrl: 'https://api.openai.com/v1', configured: true, keySource: 'keychain' as const, credentialRevision: 1, storageAvailable: true},
    },
  };
}

/** Clicks Apply on a kept draft, refreshing first when the draft is stale. */
async function applyKeptDraft(h: Awaited<ReturnType<typeof harness>>) {
  await h.until(() => h.confirmEnabled() || h.status() === 'stale', 'kept draft ready');
  if (!h.confirmEnabled()) {
    assert.equal(h.status(), 'stale');
    assert.ok(h.document.querySelector('[data-testid="ai-refresh"]'));
    await h.click('[data-testid="ai-refresh"]');
    await h.until(() => h.confirmEnabled(), 'refreshed draft');
  }
  assert.ok(h.document.querySelector('[data-draft-screen="home"]'));
  assert.equal(h.document.querySelectorAll('[data-testid="ai-draft-zone"]').length, 1);
  assert.equal(h.document.querySelector('[data-testid="ai-draft-chip"]')?.textContent, '✦ Draft');
  assert.equal(h.document.body.textContent?.includes('Previous draft'), false);
  await h.click('[data-testid="ai-confirm"]');
  await h.until(() => !!h.document.querySelector('[data-testid="ai-provenance"]'), 'applied');
  assert.equal(h.ai.applies, 1);
}

function createFake(mode: Mode, service: ScenarioService, options: HarnessOptions = {}) {
  const jobs = new Map<string, Job>();
  const previews = new Map<string, StoredPreview>();
  const applied = new Map<string, unknown>();
  const snapshots = new Map<string, Awaited<ReturnType<ScenarioService['workspace']>>>();
  const waiters: Array<() => void> = [];
  const testWaiters: Array<() => void> = [];
  const puts: unknown[] = [];
  const tests: unknown[] = [];
  const generationBodies: unknown[] = [];
  const previewBodies: unknown[] = [];
  const applyBodies: unknown[] = [];
  let lastPreviewId = '';
  let failPreview = false;
  let failApply = false;
  const modelQueries: string[] = [];
  const heldJobs = new Set<string>();
  let config: FakeConfig = options.unconfigured ? unconfiguredConfig() : savedConfig(options.savedModel);
  let released = false;
  let holdTest = false;
  let holdNext = false;
  let failPut = false;
  let rejectGeneration = false;
  const counts = {generations: 0, previews: 0, applies: 0, cancels: 0, undos: 0, inflight: 0};
  const calls: string[] = [];
  let failUndo = false;
  return {
    get generations() { return counts.generations; },
    get previews() { return counts.previews; },
    get applies() { return counts.applies; },
    get cancels() { return counts.cancels; },
    get undos() { return counts.undos; },
    get calls() { return calls; },
    failNextUndo() { failUndo = true; },
    get inflight() { return counts.inflight; },
    get puts() { return puts; },
    get tests() { return tests; },
    get generationBodies() { return generationBodies; },
    get previewBodies() { return previewBodies; },
    get applyBodies() { return applyBodies; },
    get lastPreviewId() { return lastPreviewId; },
    failNextPreview() { failPreview = true; },
    failNextApply() { failApply = true; },
    get modelQueries() { return modelQueries; },
    holdNextTest() { holdTest = true; },
    holdNextJob() { holdNext = true; },
    rejectNextGeneration() { rejectGeneration = true; },
    releaseTest() { holdTest = false; for (const resolve of testWaiters.splice(0)) resolve(); },
    failNextPut() { failPut = true; },
    release() {
      released = true;
      for (const job of jobs.values()) {
        if (heldJobs.has(job.id) && job.state === 'running') job.draft = lateDraft();
        finish(job, mode);
        if (job.preview) previews.set(job.preview.previewId, {preview: job.preview});
      }
      for (const resolve of waiters.splice(0)) resolve();
    },
    async route(method: string, pathname: string, body?: Record<string, unknown>) {
      const path = pathname.split('?')[0];
      if (method === 'GET' && path === '/api/ai/config') return {status: 200, body: structuredClone(config)};
      if (method === 'GET' && path === '/api/ai/models') {
        modelQueries.push(pathname);
        if (options.failCatalog) return {status: 502, body: {error: 'The model catalog is unavailable.', code: 'PROVIDER_UNAVAILABLE'}};
        const provider = new URL(pathname, 'http://tnt.local').searchParams.get('provider') ?? 'openrouter';
        return {status: 200, body: {provider, models: options.catalog ?? [{id: 'vendor/model'}, {id: 'openai/gpt-test'}]}};
      }
      if (method === 'PUT' && path === '/api/ai/config') {
        puts.push(body);
        if (failPut) { failPut = false; return {status: 500, body: {error: 'The settings service did not answer.', code: 'REQUEST_FAILED'}}; }
        return {status: 200, body: applyPut(config, body)};
      }
      if (method === 'POST' && path === '/api/ai/config/test') {
        tests.push(body);
        if (holdTest) await new Promise<void>(resolve => testWaiters.push(resolve));
        return {status: 200, body: {testId: body?.testId, ok: true, message: "Connected to OpenRouter. The model hasn't been tested yet."}};
      }
      if (method === 'POST' && path === '/api/ai/generations') {
        calls.push('generate');
        generationBodies.push(structuredClone(body));
        if (rejectGeneration) {
          rejectGeneration = false;
          config = {...config, settingsRevision: config.settingsRevision + 1};
          return {status: 409, body: {error: 'Settings changed in another session. Refresh and try again.', code: 'SETTINGS_CHANGED'}};
        }
        counts.generations++;
        const previousJobId = typeof body?.previousJobId === 'string' ? body.previousJobId : '';
        const answering = Array.isArray(body?.answers) && body.answers.length > 0;
        let draft: FlowDraft = mode === 'needs' || mode === 'asks' ? needsDraft() : happyDraft();
        if (mode === 'on-existing') {
          const workspace = await service.workspace(String(body?.workspaceId));
          const screen = workspace.canvas?.screens[0];
          draft = screen ? existingScreenDraft(screen.id) : happyDraft();
        }
        if (mode === 'asks' && previousJobId) draft = answeredDraft();
        if (typeof body?.prompt === 'string' && body.prompt === 'Send a receipt') {
          const workspace = await service.workspace(String(body.workspaceId));
          draft = receiptDraft(workspace.canvas?.screens[0]?.id);
        }
        const questions = mode === 'asks' && !previousJobId && !answering ? askedQuestions() : undefined;
        const job: Job = {id: crypto.randomUUID(), workspaceId: String(body?.workspaceId), baseRevision: Number(body?.expectedRevision), state: 'running', phase: 'model', draft, ...(questions ? {questions} : {}), ...(typeof body?.model === 'string' ? {model: body.model} : {}), ...(body?.provider === 'openrouter' ? {upstreamProvider: 'openrouter-upstream'} : {})};
        if (holdNext) { heldJobs.add(job.id); holdNext = false; }
        jobs.set(job.id, job);
        return {status: 202, body: viewOf(job, mode)};
      }
      const generation = /^\/api\/ai\/generations\/([^/]+)(?:\/(cancel))?$/.exec(path);
      if (generation && method === 'GET') {
        const job = jobs.get(generation[1]);
        if (!job) return {status: 404, body: {error: 'Missing job.', code: 'NOT_FOUND'}};
        counts.inflight++;
        try {
          const parked = mode === 'hold' || heldJobs.has(job.id);
          if (parked && job.state === 'running' && !released) await new Promise<void>(resolve => waiters.push(resolve));
          const view = viewOf(job, mode);
          if (!parked && job.state === 'running') finish(job, mode);
          if (job.preview) previews.set(job.preview.previewId, {preview: job.preview});
          return {status: 200, body: view};
        } finally { counts.inflight--; }
      }
      if (generation && method === 'POST' && generation[2] === 'cancel') {
        counts.cancels++;
        const job = jobs.get(generation[1]);
        if (job) job.state = 'cancelled';
        return {status: 200, body: job ? viewOf(job, mode) : {error: 'Missing job.', code: 'NOT_FOUND'}};
      }
      if (method === 'POST' && path === '/api/authoring/context') return {status: 200, body: {contextId: crypto.randomUUID(), workspaceId: body?.workspaceId, revision: body?.expectedRevision, expiresAt: new Date(Date.now() + 60_000).toISOString()}};
      if (method === 'POST' && path === '/api/authoring/preview') {
        counts.previews++;
        previewBodies.push(structuredClone(body));
        if (failPreview) {
          failPreview = false;
          return {status: 500, body: {error: 'The draft could not be previewed.', code: 'REQUEST_FAILED'}};
        }
        const preview = previewFor(String(body?.workspaceId), Number(body?.expectedRevision), body?.draft as FlowDraft);
        const placements = placementRecord(body?.placements);
        const replaceScenarioId = typeof body?.replaceScenarioId === 'string' && body.replaceScenarioId ? body.replaceScenarioId : undefined;
        previews.set(preview.previewId, {preview, placements, draft: body?.draft as FlowDraft | undefined, ...(replaceScenarioId ? {replaceScenarioId} : {})});
        lastPreviewId = preview.previewId;
        return {status: 200, body: preview};
      }
      if (method === 'POST' && path === '/api/authoring/apply') {
        const workspace = await service.workspace(String(body?.workspaceId));
        const currentRevision = workspace.metadata?.revision ?? 0;
        const expected = Number(body?.expectedRevision);
        if (failApply) {
          failApply = false;
          return {status: 409, body: {error: 'The workspace revision does not match expectedRevision.', code: 'REVISION_CONFLICT'}};
        }
        if (expected !== currentRevision) return {status: 409, body: {error: 'The workspace revision does not match expectedRevision.', code: 'REVISION_CONFLICT'}};
        const stored = previews.get(String(body?.previewId));
        if (!stored || stored.preview.baseRevision !== expected) return {status: 409, body: {error: 'The preview was created for a different revision or compiler version.', code: 'PREVIEW_STALE'}};
        applyBodies.push(structuredClone(body));
        return {status: 200, body: await applyDraft(service, counts, applied, snapshots, body ?? {}, stored)};
      }
      if (method === 'POST' && path === '/api/authoring/undo') {
        calls.push('undo');
        if (failUndo) {
          failUndo = false;
          return {status: 409, body: {error: 'The workspace changed, so this flow can’t be replaced.', code: 'UNDO_CONFLICT'}};
        }
        return {status: 200, body: await undoDraft(service, counts, snapshots, body ?? {})};
      }
      return {status: 404, body: {error: 'Unknown authoring route.', code: 'NOT_FOUND'}};
    },
  };
}

function flowTitle(stored: StoredPreview | undefined) {
  const name = stored?.draft?.name?.trim();
  return name || 'Pay a bill';
}

async function applyDraft(service: ScenarioService, counts: {applies: number}, applied: Map<string, unknown>, snapshots: Map<string, Awaited<ReturnType<ScenarioService['workspace']>>>, body: Record<string, unknown>, stored?: StoredPreview) {
  counts.applies++;
  const key = String(body.idempotencyKey);
  const existing = applied.get(key);
  if (existing) return existing;
  const current = await service.workspace(String(body.workspaceId));
  const replaceId = stored?.replaceScenarioId ?? '';
  const replacing = replaceId ? current.scenarios?.find(item => item.id === replaceId) : undefined;
  if (replaceId && (!replacing || replacing.authoring !== 'canvas' || !replacing.pathId)) {
    throw new Error('replaceScenarioId must name a canvas scenario with a path.');
  }
  const known = new Set((current.canvas?.screens ?? []).map(screen => screen.id));
  for (const screen of stored?.draft?.screens ?? []) {
    if (screen.kind === 'existing' && !known.has(screen.screenId)) throw new Error('This version refers to a screen that is no longer on the canvas.');
  }
  const stamp = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const name = flowTitle(stored);
  const placed = placedScreens(stored, stamp);
  const createdId = placed[0]?.id ?? ('screen' + stamp);
  snapshots.set('pending:' + key, structuredClone(current));
  let scenarioId = 'scenario' + stamp;
  let pathId = 'path' + stamp;
  let screens = [...(current.canvas?.screens ?? []), ...(placed.length ? placed : [{id: createdId, title: 'Home', x: 40, y: 40, tests: [] as never[]}])];
  let paths = [...(current.canvas?.paths ?? []), {id: pathId, name, screenId: createdId, scenarioId, edgeIds: [] as string[]}];
  let scenarios = [...(current.scenarios ?? []), {id: scenarioId, name, authoring: 'canvas' as const, pathId, steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}];
  if (replacing?.pathId) {
    scenarioId = replacing.id;
    pathId = replacing.pathId;
    const referenced = new Set((stored?.draft?.screens ?? []).flatMap(screen => screen.kind === 'existing' ? [screen.screenId] : []));
    const kept = (current.canvas?.screens ?? []).filter(screen => referenced.has(screen.id));
    screens = [...kept, ...placed];
    if (!screens.length) screens = [{id: createdId, title: 'Home', x: 40, y: 40, tests: []}];
    const screenId = screens[0]?.id ?? createdId;
    paths = (current.canvas?.paths ?? []).map(path => path.id === pathId ? {...path, name, screenId, scenarioId} : path);
    scenarios = (current.scenarios ?? []).map(item => item.id === scenarioId ? {...item, name} : item);
  }
  const saved = await service.save({
    id: current.id, name: current.name, yaml: current.yaml, flows: current.flows, mock: current.mock, automation: current.automation,
    canvas: {screens, edges: [...(current.canvas?.edges ?? [])], paths},
    scenarios,
    expectedRevision: Number(body.expectedRevision),
  });
  const receiptId = crypto.randomUUID();
  snapshots.set(receiptId, snapshots.get('pending:' + key)!);
  const result = {workspaceId: saved.id, revision: saved.metadata?.revision ?? 0, scenarioId, pathId, identityMap: {}, runReadiness: 'requires-preflight' as const, diagnostics: [], authoring: 'external' as const, receiptId};
  applied.set(key, result);
  return result;
}

async function undoDraft(service: ScenarioService, counts: {undos: number}, snapshots: Map<string, Awaited<ReturnType<ScenarioService['workspace']>>>, body: Record<string, unknown>) {
  const snapshot = snapshots.get(String(body.receiptId));
  if (!snapshot) throw new Error('Missing undo receipt.');
  const saved = await service.save({
    id: snapshot.id, name: snapshot.name, yaml: snapshot.yaml, flows: snapshot.flows, mock: snapshot.mock, automation: snapshot.automation,
    canvas: snapshot.canvas, scenarios: snapshot.scenarios, expectedRevision: Number(body.expectedRevision),
  });
  counts.undos++;
  return {workspaceId: saved.id, revision: saved.metadata?.revision ?? 0, receiptId: String(body.receiptId), scenarioId: snapshot.scenarios?.[0]?.id ?? '', undone: true as const};
}

function receiptDraft(existingId?: string): FlowDraft {
  const tap = (key: string, value: string, visitKey: string): FlowDraft['visits'][number]['operations'][number] => ({key, kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value}}, destination: {kind: 'visit', visitKey}});
  const home = existingId ? {key: 'home', kind: 'existing' as const, screenId: existingId} : {key: 'home', kind: 'create' as const, title: 'Home'};
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'Send a receipt', appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [home, {key: 'receipt', kind: 'create', title: 'Receipt'}],
    visits: [
      {key: 'v1', screenKey: 'home', operations: [tap('open', 'Receipt', 'v2')]},
      {key: 'v2', screenKey: 'receipt', operations: [{key: 'see', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Receipt'}}}]},
    ],
    scripts: [], assumptions: [],
  };
}

function happyDraft(): FlowDraft {
  const tap = (key: string, value: string, visitKey: string): FlowDraft['visits'][number]['operations'][number] => ({key, kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value}}, destination: {kind: 'visit', visitKey}});
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'Pay a bill', appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [{key: 'home', kind: 'create', title: 'Home'}, {key: 'bills', kind: 'create', title: 'Bills'}, {key: 'done', kind: 'create', title: 'Done'}],
    visits: [
      {key: 'v1', screenKey: 'home', operations: [tap('open', 'Bills', 'v2')]},
      {key: 'v2', screenKey: 'bills', operations: [tap('pay', 'Pay', 'v3')]},
      {key: 'v3', screenKey: 'done', operations: [{key: 'see', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Done'}}}]},
    ],
    scripts: [], assumptions: [],
  };
}

function needsDraft(): FlowDraft {
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'Pay a bill', appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [{key: 'home', kind: 'create', title: 'Home'}],
    visits: [{key: 'v1', screenKey: 'home', operations: [{key: 'open', kind: 'tap', target: {kind: 'unresolved', description: 'the bills button'}, destination: {kind: 'stay'}}]}],
    scripts: [],
    assumptions: [{key: 'paid', message: 'Paid means the confirmation screen.', about: ['open'], requiresConfirmation: true}],
  };
}

function diagnose(draft: FlowDraft) {
  const diagnostics: Preview['diagnostics'] = [];
  draft.visits.forEach((visit, visitIndex) => visit.operations.forEach((operation, operationIndex) => {
    if ('target' in operation && operation.target.kind === 'unresolved') diagnostics.push({code: 'UNRESOLVED_TARGET', path: `/visits/${visitIndex}/operations/${operationIndex}/target`, entityKey: operation.key, severity: 'error', blocks: ['apply'], message: 'Choose a target for ' + operation.key + '.', remedy: 'Fill the selector.'});
  }));
  return {applicable: diagnostics.length === 0, diagnostics, requiredAssumptionKeys: draft.assumptions.filter(item => item.requiresConfirmation).map(item => item.key)};
}

function previewFor(workspaceId: string, revision: number, draft: FlowDraft): Preview {
  const diagnosed = diagnose(draft);
  return {
    previewId: crypto.randomUUID(), workspaceId, baseRevision: revision, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    contractVersion: 1, compilerVersion: 'test', draftHash: 'hash', applicable: diagnosed.applicable, authoringComplete: diagnosed.applicable,
    runReadiness: 'requires-preflight', requiredAssumptionKeys: diagnosed.requiredAssumptionKeys, diagnostics: diagnosed.diagnostics,
    changes: {created: [], reused: [], updated: []}, identityMap: {}, timeline: [],
  };
}

function finish(job: Job, mode: Mode) {
  if (job.state !== 'running') return;
  if (mode === 'invalid') {
    job.draft = invalidDraft();
    job.state = 'needsInfo';
    job.preview = blockedPreview(job.workspaceId, job.baseRevision, invalidDiagnostics());
    return;
  }
  if (mode === 'authoring-failed') {
    job.draft = invalidDraft();
    job.state = 'failed';
    job.phase = 'previewing';
    job.error = {code: 'AUTHORING_INVALID', message: 'The draft still has validation issues.', retryable: false};
    job.preview = blockedPreview(job.workspaceId, job.baseRevision, [{code: 'INVALID_DRAFT', path: '/visits/2/operations/0', severity: 'error', blocks: ['apply', 'run'], message: 'Step 3 uses "swipe", which TnT can\'t author yet.', remedy: 'Describe the step with a supported action.'}]);
    return;
  }
  const draft = (job.draft ?? (mode === 'needs' || mode === 'asks' ? needsDraft() : happyDraft())) as FlowDraft;
  job.draft = draft;
  if (job.questions?.length) {
    job.state = 'needsInfo';
    const preview = previewFor(job.workspaceId, job.baseRevision, draft);
    preview.applicable = true;
    preview.authoringComplete = false;
    job.preview = preview;
    return;
  }
  const diagnosed = diagnose(draft);
  job.state = diagnosed.applicable ? 'pending' : 'needsInfo';
  job.preview = previewFor(job.workspaceId, job.baseRevision, draft);
}

function viewOf(job: Job, mode: Mode): GenerationView {
  const finished = job.state !== 'running';
  const previewFresh = finished && mode !== 'expired' && !!job.preview;
  return {
    id: job.id, workspaceId: job.workspaceId, state: job.state, phase: job.phase, provenance: 'ai', contractVersion: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(job.model ? {model: job.model} : {}),
    ...(job.upstreamProvider ? {upstreamProvider: job.upstreamProvider} : {}),
    ...(job.error ? {error: job.error} : {}),
    ...(previewFresh && job.preview ? {previewId: job.preview.previewId, preview: job.preview, previewExpiresAt: job.preview.expiresAt} : {}),
    ...(finished && job.draft ? {draft: job.draft} : {}),
    ...(finished && job.state === 'needsInfo' && job.questions?.length ? {questions: job.questions.map(question => ({...question, options: [...question.options]}))} : {}),
  };
}

function invalidDraft(): Record<string, unknown> {
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'CoordinatorFromHome', appId: 'com.example.HybridApp',
    execution: {kind: 'unresolved', description: 'Initial navigation is missing.'},
    screens: [{kind: 'unresolved', description: 'home screen definition/id is not available in context'}],
    visits: [{id: 'visitHome', screenId: 'home', assertions: [{type: 'visible', target: {text: 'Coordinator'}}]}],
    assumptions: [],
  };
}

function invalidDiagnostics(): Preview['diagnostics'] {
  return [
    {code: 'INVALID_DRAFT', path: '/execution', severity: 'error', blocks: ['apply', 'run'], message: "must have required property 'setup'", remedy: 'Correct the draft so it matches the v1 flow schema.'},
    {code: 'INVALID_DRAFT', path: '/screens/0', severity: 'error', blocks: ['apply', 'run'], message: "must have required property 'key'", remedy: 'Correct the draft so it matches the v1 flow schema.'},
  ];
}

function blockedPreview(workspaceId: string, revision: number, diagnostics: Preview['diagnostics']): Preview {
  return {
    previewId: crypto.randomUUID(), workspaceId, baseRevision: revision, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    contractVersion: 1, compilerVersion: 'test', draftHash: 'invalid', applicable: false, authoringComplete: false,
    runReadiness: 'blocked', requiredAssumptionKeys: [], diagnostics,
    changes: {created: [], reused: [], updated: []}, identityMap: {}, timeline: [],
  };
}

function askedQuestions(): AskedQuestion[] {
  return [
    {key: 'homeVisible', about: 'open', text: 'Which title should the first step use?', options: ['Home', 'Start', 'Welcome']},
    {key: 'payTarget', text: 'Which control is Pay?', options: ['Pay', 'Confirm']},
  ];
}

function answeredDraft(): FlowDraft {
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'Pay a bill', appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [{key: 'home', kind: 'create', title: 'Home'}],
    visits: [{key: 'v1', screenKey: 'home', operations: [{key: 'open', kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Home'}}, destination: {kind: 'stay'}}]}],
    scripts: [], assumptions: [],
  };
}

function existingScreenDraft(screenId: string): FlowDraft {
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'Pay a bill', appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [{key: 'home', kind: 'existing', screenId}, {key: 'done', kind: 'create', title: 'Done'}],
    visits: [
      {key: 'v1', screenKey: 'home', operations: [{key: 'open', kind: 'tap', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Pay'}}, destination: {kind: 'visit', visitKey: 'v2'}}]},
      {key: 'v2', screenKey: 'done', operations: [{key: 'see', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Done'}}}]},
    ],
    scripts: [], assumptions: [],
  };
}

function lateDraft(): FlowDraft {
  return {
    schemaVersion: 1, mode: 'createScenario', name: 'Late refine', appId: 'com.example.HybridApp', parameters: [],
    execution: {setup: {kind: 'launchApp'}, handlerRefs: [], mock: {kind: 'none'}},
    screens: [{key: 'late', kind: 'create', title: 'Late refine'}],
    visits: [{key: 'v1', screenKey: 'late', operations: [{key: 'see', kind: 'checkVisible', target: {kind: 'selector', selector: {target: 'text', match: 'exact', value: 'Late refine'}}}]}],
    scripts: [], assumptions: [],
  };
}

function runningRun(id: string, workspaceId: string, deviceId: string) {
  return {
    id, deviceId, startedAt: '2026-10-20T00:00:00.000Z', status: 'running',
    snapshot: {id: 'snap', workspaceId, name: 'Untitled workspace', yaml: 'appId: com.example.HybridApp\n---\n- launchApp\n', steps: [], toolVersions: {maestro: '0', node: '22'}, runtimeInputPolicy: 'none'},
    steps: [], log: '', cleanup: {verified: false, detail: 'pending'}, artifacts: [], mappingNote: '',
  };
}

test('empty and YAML-only workspaces open on the contextual canvas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tnt-contextual-canvas-'));
  const yaml = 'appId: com.example.HybridApp\n---\n- launchApp\n';
  const emptyCanvas = {screens: [], edges: [], paths: []};
  const service = createScenarios({
    root: directory,
    runner: createRunner({artifactDirectory: directory, execute: async () => ({stdout: '', stderr: ''})}),
    maestro: {version: async () => '0', run: async () => ({code: 0, log: '', cleanup: {verified: true, detail: 'unused'}})},
  });
  const empty = await service.save({name: 'Untitled workspace', yaml, scenarios: [], canvas: emptyCanvas});
  await service.saveView(empty.id, {format: 1, panels: {advanced: true}, scenarioId: 'gone'});
  const yamlOnly = await service.save({
    name: 'YAML only', yaml, canvas: emptyCanvas,
    scenarios: [{id: 'yaml-1', name: 'Imported flow', steps: [], inputs: {}, parameters: {}, enabledHandlerIds: []}],
  });
  const omitted = await service.save({name: 'No canvas field', yaml, scenarios: []});
  await service.setSession(empty.id);
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'HTMLElement', 'Event', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'] as const;
  const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class ResizeObserver { observe() {} disconnect() {} }
  const pending: Promise<Response>[] = [];
  const request = async (path: string, init?: {body?: string}) => {
    try {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      const id = path.split('/')[3];
      if (path === '/api/session') return Response.json(await service.session());
      if (path === '/api/canvas/references') return Response.json({references: [], diagnostics: []});
      if (path.startsWith('/api/scripts/trust')) return Response.json({scripts: []});
      if (path.endsWith('/view')) return Response.json(await service.saveView(id, body));
      if (/^\/api\/workspaces\/[0-9a-f-]{36}$/.test(path)) return Response.json(await service.workspaceDetail(id));
      return Response.json({error: 'unused'}, {status: 404});
    } catch (error) {
      return Response.json({error: error instanceof Error ? error.message : 'Request failed'}, {status: 400});
    }
  };
  const fetchImpl = (path: string, init?: {body?: string}) => { const response = request(path, init); pending.push(response); return response; };
  for (const key of keys) Object.defineProperty(globalThis, key, {value: key === 'fetch' ? fetchImpl : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'ResizeObserver' ? ResizeObserver : Reflect.get(dom.window, key), configurable: true});
  const {createRoot} = await import('react-dom/client');
  const document = dom.window.document;
  let root = createRoot(document.getElementById('root')!);
  const settle = async () => { do { await Promise.all(pending.splice(0)); await new Promise(resolve => setImmediate(resolve)); } while (pending.length); };
  const render = async () => { await act(async () => { root.render(createElement(Scenarios, {token: 'local', deviceId: '', bundleId: 'com.example.HybridApp', launchBusy: false, onRunning: () => {}, recoverSession: true})); }); };
  const reload = async (id: string) => {
    await service.setSession(id);
    await act(async () => { root.unmount(); });
    root = createRoot(document.getElementById('root')!);
    await render();
    for (let attempt = 0; attempt < 40; attempt++) {
      if (document.querySelector('.artifact-id')?.textContent?.includes(id)) return;
      await act(async () => { await settle(); });
    }
    assert.fail('workspace ' + id + ' did not load');
  };
  const legend = (text: string) => [...document.querySelectorAll('legend')].some(node => node.textContent === text);
  const contextual = (hint?: RegExp) => {
    assert.ok(document.querySelector('.scenario-sequence-bar'), 'sequence bar');
    if (hint) assert.match(document.querySelector('.scenario-sequence-bar')?.textContent ?? '', hint);
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === 'Disable canvas'), false);
    assert.equal(legend('Connect expected screens'), false);
    assert.equal(legend('Advanced YAML associations'), false);
    assert.equal(document.querySelector('.canvas-route-bar'), null);
    assert.match(document.querySelector('.workspace-advanced > summary')?.textContent ?? '', /Advanced mode · legacy authoring and settings/);
  };
  try {
    await reload(empty.id);
    contextual(/No scenarios/);
    assert.match(document.querySelector('.sequence-empty-hint')?.textContent ?? '', /Create one to start a sequence/);
    const launch = document.querySelector<HTMLButtonElement>('[data-testid="ai-flow-button"]');
    assert.ok(launch);
    await act(async () => { launch.click(); });
    assert.equal(document.querySelector('.ai-draft-heading')?.textContent, 'Describe a flow');
    assert.ok(document.querySelector('[aria-label="Flow description"]'));
    await reload(empty.id);
    contextual(/No scenarios/);
    await reload(yamlOnly.id);
    contextual(/Imported flow/);
    assert.doesNotMatch(document.querySelector('.scenario-sequence-bar')?.textContent ?? '', /No scenarios/);
    await reload(omitted.id);
    contextual(/No scenarios/);
    await reload(empty.id);
    contextual(/No scenarios/);
    await showLegacyCanvasControls(document, act);
    assert.equal(document.querySelector('.scenario-sequence-bar'), null);
    assert.ok([...document.querySelectorAll('button')].some(node => node.textContent === 'Disable canvas'));
    assert.equal(legend('Connect expected screens'), true);
    assert.equal(legend('Advanced YAML associations'), true);
    assert.ok(document.querySelector('.canvas-route-bar'));
    const details = document.querySelector<HTMLDetailsElement>('.workspace-advanced')!;
    if (!details.open) await act(async () => { details.querySelector('summary')!.click(); });
    const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Return to contextual canvas');
    assert.ok(back);
    await act(async () => { back.click(); });
    contextual(/No scenarios/);
    await showLegacyCanvasControls(document, act);
    assert.ok([...document.querySelectorAll('button')].some(node => node.textContent === 'Disable canvas'));
    const view = await service.workspaceDetail(empty.id);
    assert.equal(JSON.stringify(view.view ?? {}).includes('legacyCanvas'), false);
    await reload(empty.id);
    contextual(/No scenarios/);
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === 'Disable canvas'), false);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    await rm(directory, {recursive: true, force: true});
  }
});

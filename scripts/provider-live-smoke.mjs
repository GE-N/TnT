#!/usr/bin/env node
// Opt-in live smoke for the OpenAI-compatible, OpenRouter, and Claude Messages shapes.
// Not part of npm test. Skips, with no network call, unless TNT_PROVIDER_SMOKE_KEY is set.
// Never sets TNT_LIVE_COPILOT and never reads the keychain or a session file.

const key = process.env.TNT_PROVIDER_SMOKE_KEY;
if (typeof key !== 'string' || key.trim() === '') {
  console.log('skipped: TNT_PROVIDER_SMOKE_KEY is not set');
  process.exit(0);
}

const base = process.env.TNT_PROVIDER_SMOKE_BASE_URL ?? '';
let endpoint;
try { endpoint = new URL(base); }
catch {
  console.log('skipped: TNT_PROVIDER_SMOKE_BASE_URL must be an https URL');
  process.exit(0);
}
if (endpoint.protocol !== 'https:') {
  console.log('skipped: TNT_PROVIDER_SMOKE_BASE_URL must be an https URL');
  process.exit(0);
}

const model = process.env.TNT_PROVIDER_SMOKE_MODEL || 'gpt-4o';
const url = new URL('chat/completions', endpoint.href.endsWith('/') ? endpoint.href : `${endpoint.href}/`);
const response = await fetch(url, {
  method: 'POST',
  headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'},
  body: JSON.stringify({
    model,
    messages: [{role: 'user', content: 'Reply with OK'}],
    max_tokens: 8,
  }),
});
const text = await response.text();
console.log(JSON.stringify({status: response.status, bytes: Buffer.byteLength(text)}));
process.exit(response.ok ? 0 : 1);

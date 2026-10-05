/** Same-origin calls to the local runner; the session token never appears in a URL. */
export function runnerClient(token: string) {
  return async function api(path: string, body?: unknown) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-TnT-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Runner request failed.');
    return result;
  };
}

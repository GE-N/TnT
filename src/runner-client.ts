export class RunnerRequestError extends Error {blocked?:unknown;constructor(message:string,public status:number,payload?:unknown){super(message);if(payload&&typeof payload==='object'&&'blocked' in payload)this.blocked=(payload as {blocked?:unknown}).blocked;}}
/** Same-origin calls to the local runner; the session token never appears in a URL. */
export function runnerClient(token: string) {
  return async function api(path: string, body?: unknown) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-TnT-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new RunnerRequestError(result?.error ?? result?.blocked?.[0]?.message ?? 'Runner request failed.',response.status,result);
    return result;
  };
}

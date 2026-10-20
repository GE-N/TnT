/** HTTP error for the AI routes. The body never includes a key, prompt, or model response. */
export function redactSecrets(text: string, secrets: readonly string[]) {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'authorization: [redacted]');
}

export class AiHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AiHttpError';
  }
  get body(): {error: string; code: string} {
    return {error: this.message, code: this.code};
  }
}

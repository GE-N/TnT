/** HTTP error for the AI routes. The body never includes a key, prompt, or model response. */
export class AiHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AiHttpError';
  }
  get body(): {error: string; code: string} {
    return {error: this.message, code: this.code};
  }
}

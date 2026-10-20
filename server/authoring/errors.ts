import type {Diagnostic} from './types.js';

/** HTTP error for the authoring routes. Status matches contract §7.1. */
export class AuthoringHttpError extends Error {
  readonly diagnostics?: Diagnostic[];
  constructor(readonly status: number, readonly code: string, message: string, diagnostics?: Diagnostic[]) {
    super(message);
    this.diagnostics = diagnostics;
  }
  get body(): {error: string; code: string; diagnostics?: Diagnostic[]} {
    return {error: this.message, code: this.code, ...(this.diagnostics ? {diagnostics: this.diagnostics} : {})};
  }
}

export function authoringError(status: number, code: string, message: string, diagnostics?: Diagnostic[]) {
  return new AuthoringHttpError(status, code, message, diagnostics);
}

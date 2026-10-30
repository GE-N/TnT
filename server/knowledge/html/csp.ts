/** Served and offline pages share this policy. No script, no remote resources, inline style only. */
export const KNOWLEDGE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; style-src 'unsafe-inline'";
/** Header-only directives. A meta policy cannot set frame-ancestors. */
export const KNOWLEDGE_CSP_HEADER = KNOWLEDGE_CSP + "; frame-ancestors 'none'; sandbox";

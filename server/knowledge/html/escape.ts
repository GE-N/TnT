const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
// C0 controls except tab/newline/carriage return, plus bidi overrides that can spoof the status line.
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Escape authored text for element text and quoted attributes. Controls become visible code points. */
export function escapeHtml(value: string): string {
  const text = value.replace(CONTROLS, character => 'U+' + character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** One-pass entity decode. Replacements are not decoded again, so `&amp;lt;` stays the text `&lt;`. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|#39|[a-z]+);/gi, (entity, body: string) => {
    const named = NAMED[body.toLowerCase()];
    if (named) return named;
    if (body[0] !== '#') return entity;
    const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return entity;
    return String.fromCodePoint(code);
  });
}

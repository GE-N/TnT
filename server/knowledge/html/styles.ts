/** Inlined so a generation file opened from disk does not request the runner. No authored text belongs here. */
export const readerCss = `
:root{--page:#f4f6f8;--surface:#fff;--subtle:#edf1f5;--text:#253041;--muted:#596579;--border:#cbd3dd;--border-strong:#9aa8bb;--accent:#315eaa;--success:#256747;--warning:#8a4b00;--warning-surface:#fff4e5;--warning-border:#d9bc7d;--primary:#0a63d1;--shadow:0 8px 24px #25304114;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:var(--text);background:var(--page)}
*{box-sizing:border-box}body{margin:0}
a{color:var(--primary);text-decoration:none}
.rhead{position:sticky;top:0;z-index:5;min-height:56px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;padding:8px 28px}
.brand{font-size:22px;font-weight:650;letter-spacing:-1px;color:var(--text)}.brand b{color:var(--accent)}
.rhead .crumb{color:var(--muted);font-size:13px}.rhead .crumb strong{color:var(--text);font-weight:600}
.rhead .ro{font-size:11px;border:1px solid var(--border);border-radius:999px;padding:2px 8px;color:var(--muted)}
.status{margin-left:auto;position:relative}
.asof,.live,.status details.review>summary{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:5px 12px;font:inherit;font-size:12.5px;color:var(--text)}
.status details.review>summary{cursor:pointer;list-style:none}
.status details.review>summary::-webkit-details-marker{display:none}
.status details.review>summary small,.asof small,.live small{color:var(--muted);font-size:11.5px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block}
.dot.warn{background:#d9822b}.dot.grey{background:var(--border-strong)}.dot.updating{background:var(--primary)}
.pop{position:absolute;right:0;top:40px;width:min(380px,calc(100vw - 32px));background:var(--surface);border-radius:12px;box-shadow:0 12px 32px #25304129,0 1px 3px #2530411f;padding:14px 16px;font-size:12.5px;z-index:6}
.pop h4{margin:0 0 6px;font-size:13.5px}
.pop dl{display:grid;grid-template-columns:118px 1fr;gap:4px 10px;margin:10px 0}
.pop dt{color:var(--muted)}.pop dd{margin:0;overflow-wrap:anywhere}
.pop .cause{background:var(--warning-surface);border:1px solid var(--warning-border);color:var(--warning);border-radius:8px;padding:8px 10px;margin:6px 0}
.pop code,.meta code{font-size:11.5px;background:var(--subtle);border-radius:4px;padding:0 4px}
#knowledge-banner:empty{display:none}
.banner{max-width:880px;margin:16px auto 0;border-radius:10px;padding:10px 14px;font-size:13px;background:var(--subtle);border:1px solid var(--border);color:var(--text)}
.banner.warn{background:var(--warning-surface);border-color:var(--warning-border);color:var(--warning)}
main{max-width:880px;margin:18px auto 40px;padding:0 16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:22px 26px;margin-bottom:16px}
.ws h1{font-size:22px;margin:0 0 4px;overflow-wrap:anywhere}
.ws .label{font-size:11px;font-weight:600;color:var(--muted);margin:10px 0 0}
.toc{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.toc a{border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:12.5px;color:var(--text);background:var(--surface);overflow-wrap:anywhere}
article:target{border-color:var(--primary)}
.sc-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.sc-head h2{font-size:19px;margin:0;overflow-wrap:anywhere}
.sc-head .id{font:11.5px ui-monospace,Menlo,monospace;color:var(--muted);background:var(--subtle);border-radius:4px;padding:1px 6px}
.sc-head .flag{font-size:11.5px;color:var(--warning);background:var(--warning-surface);border:1px solid var(--warning-border);border-radius:999px;padding:1px 8px}
.fields{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:14px 0 10px}
.fl{font-size:11px;font-weight:600;color:var(--muted);margin:0 0 2px}
.text{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.muted{color:var(--muted)}
.secs{border-top:1px solid var(--border)}
.secs details{border-bottom:1px solid var(--border);padding:9px 0}
.secs summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;font-size:13.5px}
.secs summary::-webkit-details-marker{display:none}
.secs summary::before{content:'▸';color:var(--muted);width:14px}
.secs details[open] summary::before{content:'▾'}
.secs summary em{font-style:normal;color:var(--muted);font-size:12px;margin-left:auto}
.secs .body{padding:6px 0 4px 20px}
.numflow{margin:6px 0;padding-left:0;list-style:none}
.numflow li{margin:3px 0;overflow-wrap:anywhere}
.facts{color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}
.notice{font-size:12.5px;color:var(--muted);border-left:3px solid var(--border-strong);padding:2px 10px;margin:8px 0}
.meta{max-width:880px;margin:0 auto 24px;padding:0 16px;color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 16px}
.index{margin:12px 0 0;padding-left:18px}
.index li{margin:8px 0}
@media(max-width:720px){.fields{grid-template-columns:1fr}.rhead{flex-wrap:wrap}.status{margin-left:0}}
`;

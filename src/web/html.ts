import type { Response } from 'express';

/** Escape untrusted text for HTML content and attribute values. */
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const styles = `
:root{color-scheme:light dark;--fg:#1c1c1e;--muted:#6b6b70;--bg:#fafafa;--card:#fff;--line:#e2e2e6;--accent:#c2410c;--accent-fg:#fff;--error:#b00020;--ok:#166534}
@media (prefers-color-scheme:dark){:root{--fg:#ececef;--muted:#a1a1a8;--bg:#141416;--card:#1d1d20;--line:#333338;--accent:#fb923c;--accent-fg:#141416;--error:#ff6b81;--ok:#4ade80}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);max-width:44rem;margin:0 auto;padding:1.5rem 1rem 4rem;line-height:1.5}
h1{font-size:1.5rem;margin:.5rem 0 1rem}h2{font-size:1.15rem;margin:0 0 .75rem}h3{font-size:1rem;margin:1rem 0 .5rem}
a{color:var(--accent)}
nav{display:flex;flex-wrap:wrap;gap:.25rem 1rem;align-items:center;border-bottom:1px solid var(--line);padding-bottom:.75rem;margin-bottom:1rem}
nav form{margin:0 0 0 auto}nav button{width:auto;margin:0;padding:.25rem .75rem;background:none;color:var(--accent);border:1px solid var(--line)}
section{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1rem;margin:1rem 0}
label{display:block;font-weight:600;margin-top:.75rem}
input,select,button,textarea{font:inherit;padding:.5rem;width:100%;margin-top:.25rem;border:1px solid var(--line);border-radius:.5rem;background:var(--bg);color:var(--fg)}
button{background:var(--accent);color:var(--accent-fg);border:0;font-weight:600;cursor:pointer;margin-top:1rem}
button.secondary{background:none;color:var(--accent);border:1px solid var(--line)}
.inline{display:inline}.inline button{width:auto;margin:0;padding:.25rem .75rem}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.4rem .25rem;border-bottom:1px solid var(--line);vertical-align:middle}
td input,td select{margin:0}
.muted{color:var(--muted);font-size:.9rem}.error{color:var(--error);font-weight:600}.ok{color:var(--ok);font-weight:600}
code,.copy{font-family:ui-monospace,monospace;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:.4rem;padding:.1rem .35rem}
.copy{display:block;padding:.6rem;margin:.5rem 0;user-select:all}
ol li{margin:.35rem 0}
.check{display:flex;gap:.5rem;align-items:center;font-weight:400;margin:.4rem 0}.check input{width:auto;margin:0}
.avatar{display:inline-block;flex:none;width:2.5rem;height:2.5rem;border-radius:50%;object-fit:cover;background:var(--line)}
.friend{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.75rem 0}.friend input{margin:0;flex:1 1 8rem;min-width:0}.friend .actions{display:flex;gap:.5rem;margin-left:auto}.friend button{width:auto;margin:0;padding:.5rem .75rem}
.pair{display:grid;grid-template-columns:1fr 2fr;gap:.75rem}
`;

/** Send a complete page with a strict policy: only this server's scripts, HTTPS images, no framing, never cached. */
export function sendPage(res: Response, status: number, title: string, body: string) {
  res.status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src https:; frame-ancestors 'none'; base-uri 'none'")
    .set('X-Frame-Options', 'DENY')
    .set('Referrer-Policy', 'same-origin')
    .send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${styles}</style></head><body>${body}</body></html>`);
}

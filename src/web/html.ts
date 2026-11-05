import type { Response } from 'express';

/** Escape untrusted text for HTML content and attribute values. */
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const styles = `
:root{color-scheme:light dark;--fg:#1c1c1e;--muted:#6b6b70;--bg:#fafafa;--card:#fff;--line:#e2e2e6;--accent:#c2410c;--accent-fg:#fff;--accent-soft:#fff3eb;--error:#b00020;--error-soft:#fdecef;--ok:#166534;--ok-soft:#ecf8f0}
@media (prefers-color-scheme:dark){:root{--fg:#ececef;--muted:#a1a1a8;--bg:#141416;--card:#1d1d20;--line:#333338;--accent:#fb923c;--accent-fg:#141416;--accent-soft:#2b1f17;--error:#ff6b81;--error-soft:#2c1a1e;--ok:#4ade80;--ok-soft:#16261c}}
*{box-sizing:border-box}
[hidden]{display:none!important}
fieldset.plain{border:0;padding:0;margin:0;min-width:0}
.check .spacer{width:1.25rem;flex:none}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);max-width:44rem;margin:0 auto;padding:1rem 1rem 4rem;line-height:1.5}
h1{font-size:1.5rem;margin:.5rem 0 1rem}h2{font-size:1.15rem;margin:0 0 .25rem}h3{font-size:1rem;margin:1.25rem 0 .5rem}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
nav{display:flex;flex-wrap:wrap;align-items:center;gap:0 1rem;border-bottom:1px solid var(--line);margin-bottom:1rem}
nav .brand{font-weight:700;color:var(--fg);text-decoration:none;padding:.6rem 0}
nav .links{display:flex;gap:1rem}
nav .links a{color:var(--muted);text-decoration:none;padding:.6rem 0;border-bottom:2px solid transparent;margin-bottom:-1px}
nav .links a:hover{color:var(--fg)}
nav .links a[aria-current="page"]{color:var(--accent);font-weight:600;border-bottom-color:var(--accent)}
nav form{margin:0 0 0 auto}
@media (max-width:40rem){nav .links{order:3;flex-basis:100%}}
.brand-header{font-weight:700;border-bottom:1px solid var(--line);padding:.6rem 0;margin-bottom:1rem}
section{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1rem;margin:1rem 0;scroll-margin-top:1rem}
section>:first-child{margin-top:0}
section.highlight{border-color:var(--accent);background:var(--accent-soft)}
.lead{color:var(--muted);font-size:.9rem;margin:0 0 .75rem}
.hint{color:var(--muted);font-size:.9rem;margin:.25rem 0 0}
.muted{color:var(--muted);font-size:.9rem}
label{display:block;font-weight:600;margin-top:.75rem}
input,select,textarea{font:inherit;padding:.5rem;width:100%;min-height:2.75rem;margin-top:.25rem;border:1px solid var(--line);border-radius:.5rem;background:var(--bg);color:var(--fg)}
[aria-invalid="true"]{border-color:var(--error);border-width:2px}
.field-error{color:var(--error);font-weight:600;font-size:.9rem;margin:.25rem 0 0}
button,.button{font:inherit;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:.5rem 1rem;border-radius:.5rem;border:1px solid var(--line);background:none;color:var(--accent);text-decoration:none}
button:hover,.button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
button.danger,.button.danger{color:var(--error)}
button.danger:hover{border-color:var(--error);background:var(--error-soft)}
button.danger.primary{background:var(--error);border-color:var(--error);color:var(--accent-fg)}
button.small{min-height:2.25rem;padding:.25rem .75rem}
@media (pointer:coarse){button.small{min-height:2.75rem}}
.btn-row{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:flex-end;align-items:center;margin-top:1rem}
.btn-row .start{margin-right:auto}
@media (max-width:40rem){.btn-row .primary{flex:1 1 100%}}
.notice{border-radius:.5rem;padding:.6rem .75rem;margin:0 0 .75rem;font-weight:600;border-left:4px solid}
.notice.ok{color:var(--ok);background:var(--ok-soft);border-color:var(--ok)}
.notice.error{color:var(--error);background:var(--error-soft);border-color:var(--error)}
.notice:focus{outline:none}
p.error{color:var(--error);font-weight:600}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.4rem .25rem;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:.85rem;color:var(--muted);font-weight:600}td:last-child{text-align:right}
.rows{list-style:none;padding:0;margin:0}
.rows li{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .75rem;padding:.5rem 0;border-bottom:1px solid var(--line)}
.rows li:last-child{border-bottom:0}
.rows .name{font-weight:600}.rows .meta{color:var(--muted);font-size:.9rem}.rows form{margin:0 0 0 auto}
code,.copy{font-family:ui-monospace,monospace;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:.4rem;padding:.1rem .35rem}
.copy-field{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.5rem 0}
.copy{flex:1 1 16rem;display:block;padding:.6rem;user-select:all}
ol li{margin:.35rem 0}
.check{display:flex;gap:.75rem;align-items:center;font-weight:400;margin:0;padding:.5rem 0;border-bottom:1px solid var(--line)}
.check input{width:1.25rem;height:1.25rem;min-height:0;margin:0;flex:none;accent-color:var(--accent)}
.check .who{display:flex;flex-direction:column;min-width:0}
.badge{display:inline-block;font-size:.8rem;font-weight:600;color:var(--ok);background:var(--ok-soft);border-radius:1rem;padding:0 .5rem;width:fit-content}
.avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:2.5rem;height:2.5rem;border-radius:50%;object-fit:cover;background:var(--line);color:var(--muted);font-weight:700;font-size:.9rem}
.friend{display:flex;gap:.5rem;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--line)}.friend input{margin:0;flex:1 1 auto;min-width:0}
.pair{display:grid;grid-template-columns:1fr 2fr;gap:.75rem}
.pair label{margin-top:0}
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

/** A page for someone who is not signed in: the product name, then the content. */
export function sendPublicPage(res: Response, status: number, title: string, content: string) {
  sendPage(res, status, title, `<header class="brand-header">AimHarder MCP</header><main>${content}</main>`);
}

/** The AimHarder sign-in fields and button, shared by sign-in, invitations and connector approval. */
export function signInForm(options: { action: string; submit: string; error?: string | undefined; hidden?: Record<string, string> }) {
  const invalid = options.error ? ' aria-invalid="true" aria-describedby="sign-in-error"' : '';
  const hidden = Object.entries(options.hidden ?? {}).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join('');
  return `${options.error ? `<p class="notice error" id="sign-in-error" role="alert">${escapeHtml(options.error)}</p>` : ''}
<form method="post" action="${escapeHtml(options.action)}">${hidden}
<label for="username">Correo de AimHarder</label><input id="username" name="username" type="email" autocomplete="username" required autofocus${invalid}>
<label for="password">Contraseña de AimHarder</label><input id="password" name="password" type="password" autocomplete="current-password" required${invalid}>
<div class="btn-row"><button type="submit" class="primary">${escapeHtml(options.submit)}</button></div></form>`;
}

import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { bookingWindowSchema, cancellationWindowSchema, gymIdSchema, maxBookingWindowDays, maxCancellationWindowMinutes, timeZoneSchema, wholeNumber, weekdays, type Friends, type HttpConfiguration, type Weekday } from '../config.js';
import { type Accounts } from '../accounts.js';
import { getClassParticipants, getClassSessions } from '../features/schedule.js';
import type { Context } from '../features/context.js';
import { AccountsOAuthProvider } from '../oauth.js';
import type { Gym } from '../upstream.js';
import { escapeHtml as e, sendPage, sendPublicPage, signInForm } from './html.js';

const cookieName = 'aimharder_session';
const dayNames: Record<Weekday, string> = { mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves', fri: 'Viernes', sat: 'Sábado', sun: 'Domingo' };
/** Outcomes shown in the section that was changed, after a redirect: `?message=…&section=…[&field=…]`. */
const messages: Record<string, { text: string; ok?: true }> = {
  saved: { text: 'Cambios guardados.', ok: true },
  'plan-added': { text: 'Clase añadida al plan.', ok: true },
  'plan-removed': { text: 'Clase quitada del plan.', ok: true },
  'friends-added': { text: 'Amigos añadidos. Puedes cambiarles el nombre aquí.', ok: true },
  'friend-removed': { text: 'Quitado de tus amigos.', ok: true },
  removed: { text: 'Acceso retirado. Se han borrado su contraseña y sus ajustes.', ok: true },
  'invitation-deleted': { text: 'Invitación anulada. El enlace ya no funciona.', ok: true },
  'gym-chosen': { text: 'Gimnasio elegido. Configura ahora su zona horaria, tu plan y tus preferencias.', ok: true },
  'calendar-revoked': { text: 'Enlace desactivado. Tu app de calendario ya no recibirá tus reservas.', ok: true },
  invalid: { text: 'No se ha guardado: algún valor no es válido. Revísalo y vuelve a intentarlo.' },
  'plan-slot': { text: 'No se ha añadido: elige una clase del horario.' },
  friend: { text: 'No se ha guardado: cada amigo necesita un nombre, de 100 caracteres como máximo.' },
  gym: { text: 'No se ha guardado: elige uno de tus gimnasios.' },
  label: { text: 'Escribe el nombre de la persona a la que quieres invitar.' },
  tz: { text: 'Elige una zona horaria de la lista.' },
  book: { text: 'Escribe un número de días entre 1 y 60, o déjalo vacío.' },
  cancel: { text: 'Escribe un número de minutos entre 1 y 10080, o déjalo vacío.' },
};
const timeZones = Intl.supportedValuesOf('timeZone');
const timetableCacheMs = 60 * 60 * 1000;
/** A gym's classes in the coming seven days, by weekday: what can go in a weekly plan. */
interface Timetable { byDay: Record<Weekday, { startTime: string; className: string }[]>; names: string[] }
const weekdayOf = (date: string) => weekdays[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!;
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((word) => [...word][0] ?? '').join('').toUpperCase();
const avatar = (url: string | undefined | null, name: string) => (url
  ? `<img class="avatar" src="${e(url)}" alt="" width="40" height="40" loading="lazy">`
  : `<span class="avatar" aria-hidden="true">${e(initials(name))}</span>`);
const copyField = (id: string, value: string, primary = false) => `<div class="copy-field"><code class="copy" id="${id}">${e(value)}</code>
<button type="button"${primary ? ' class="primary"' : ''} data-copy="${id}" hidden>Copiar</button><span class="sr-only" role="status" data-copy-status></span></div>`;
const appScript = `// Enhancements for the settings pages; every page works without them.
// Show only the selected weekday's classes in each plan form.
for (const form of document.querySelectorAll('form[data-plan]')) {
  const day = form.querySelector('select[name="day"]');
  const slot = form.querySelector('select[name="slot"]');
  const groups = [...slot.querySelectorAll('optgroup')].map((group) => group.cloneNode(true));
  const sync = () => {
    const group = groups.find((entry) => entry.dataset.day === day.value);
    slot.replaceChildren(...(group ? [...group.children].map((option) => option.cloneNode(true)) : []));
    slot.disabled = !slot.options.length;
  };
  day.addEventListener('change', sync);
  sync();
}
// Copy buttons for links and addresses, shown only where the clipboard can be used.
for (const button of document.querySelectorAll('button[data-copy]')) {
  const target = document.getElementById(button.dataset.copy);
  const status = button.parentElement.querySelector('[data-copy-status]');
  if (!target || !navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener('click', async () => {
    let done = true;
    try { await navigator.clipboard.writeText(target.textContent.trim()); } catch { done = false; }
    button.textContent = done ? 'Copiado' : 'Copiar';
    if (status) status.textContent = done ? 'Copiado' : 'No se ha podido copiar; selecciónalo y cópialo.';
    setTimeout(() => { button.textContent = 'Copiar'; if (status) status.textContent = ''; }, 2500);
  });
}
// Move focus to the outcome of the last action, or to the field it points at, so that it is seen and read out.
document.querySelector('[data-notice], [aria-invalid="true"]')?.focus();
`;

type Body = Record<string, string | string[] | undefined>;
type Page = 'settings' | 'welcome' | 'admin';
const field = (body: Body, name: string) => { const value = body[name]; return typeof value === 'string' ? value.trim() : ''; };
const list = (body: Body, name: string) => { const value = body[name]; return value === undefined ? [] : (Array.isArray(value) ? value : [value]); };
const query = (req: Request, name: string) => (typeof req.query[name] === 'string' ? req.query[name] : '');
const today = (timeZone: string | null) => new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'Europe/Madrid' }).format(new Date());
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const shortDate = (iso: string) => new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'Europe/Madrid' }).format(new Date(iso));

/** Return to a page section with the outcome, which that section shows; `target` is the field to point at, if any. */
function back(res: Response, path: string, section: string, message: string, target?: string) {
  const params = new URLSearchParams({ message, section, ...(target ? { field: target } : {}) });
  res.redirect(303, `${path}?${params.toString()}#${encodeURIComponent(target ?? section)}`);
}

/** Validate and save settings, then return to that section of the settings page with the outcome. */
function save(res: Response, section: string, store: () => void, message = 'saved', invalid = 'invalid') {
  try { store(); }
  catch { back(res, '/settings', section, invalid); return; }
  back(res, '/settings', section, message);
}

/**
 * The web pages of the remote server, in Spanish for the gym's members: sign-in, invitations, connection instructions,
 * each account's settings, and the owner's administration. The only script (`/assets/app.js`) filters the plan form's
 * classes by weekday, adds copy buttons and focuses the outcome of the last action; pages work without it. A signed,
 * HttpOnly session cookie identifies the account; every form post must come from this origin.
 */
export function webRouter(config: HttpConfiguration, accounts: Accounts, provider: AccountsOAuthProvider, signInLimit: RequestHandler) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 500 });
  const origin = config.publicUrl.origin;
  const timetables = new Map<string, { at: number; timetable: Timetable }>();

  const sameOrigin: RequestHandler = (req, res, next) => {
    const source = req.get('origin') ?? (URL.canParse(req.get('referer') ?? '') ? new URL(req.get('referer')!).origin : undefined);
    if (source !== origin) { sendPublicPage(res, 403, 'No permitido', '<h1>No se ha enviado el formulario</h1><p>Por seguridad, solo se aceptan formularios enviados desde esta web. Vuelve a la página, recárgala y envíalo de nuevo.</p><p><a href="/settings">Ir a Ajustes</a></p>'); return; }
    next();
  };
  const sessionOf = (req: Request) => {
    const cookie = (req.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
    return provider.sessionAccount(cookie?.slice(cookieName.length + 1));
  };
  const signedIn: RequestHandler = async (req, res, next) => {
    const sub = await sessionOf(req);
    if (!sub) { res.redirect(303, '/login'); return; }
    res.locals.sub = sub;
    next();
  };
  const ownerOnly: RequestHandler = (_req, res, next) => {
    if (!accounts.isOwner(res.locals.sub as string)) { sendPublicPage(res, 404, 'Página no encontrada', '<h1>Esta página no existe</h1><p><a href="/settings">Ir a Ajustes</a></p>'); return; }
    next();
  };
  const startSession = async (res: Response, sub: string) => {
    res.cookie(cookieName, await provider.session(sub), {
      httpOnly: true, sameSite: 'lax', secure: config.publicUrl.protocol === 'https:', path: '/', maxAge: AccountsOAuthProvider.sessionSeconds * 1000,
    });
  };
  /** A page for a signed-in account: navigation with the current page marked, the content, and the enhancements script. */
  const layout = (res: Response, status: number, title: string, active: Page, body: string) => {
    const sub = res.locals.sub as string;
    const link = (page: Page, label: string) => `<a href="/${page}"${page === active ? ' aria-current="page"' : ''}>${label}</a>`;
    const nav = `<nav aria-label="Principal"><a class="brand" href="/settings">AimHarder MCP</a>
<div class="links">${link('settings', 'Ajustes')}${link('welcome', 'Conectar')}${accounts.isOwner(sub) ? link('admin', 'Administrar') : ''}</div>
<form method="post" action="/logout"><button type="submit" class="small">Salir</button></form></nav>`;
    sendPage(res, status, title, `${nav}<main>${body}</main><script src="/assets/app.js" defer></script>`);
  };
  /** The outcome of the last action, in the section it concerns. */
  const notice = (req: Request, section: string) => {
    const message = messages[query(req, 'message')];
    // An error about one field is shown next to that field instead.
    if (query(req, 'section') !== section || query(req, 'field') || !message || !Object.hasOwn(messages, query(req, 'message'))) return '';
    return `<p class="notice ${message.ok ? 'ok' : 'error'}" role="${message.ok ? 'status' : 'alert'}" tabindex="-1" data-notice>${e(message.text)}</p>`;
  };
  /** Marks the field the last error points at: attributes for the control and the message below it. */
  const fieldError = (req: Request, id: string) => {
    const message = messages[query(req, 'message')];
    if (query(req, 'field') !== id || !message || message.ok) return { attributes: '', text: '' };
    return { attributes: ` aria-invalid="true" aria-describedby="${e(id)}-error"`, text: `<p class="field-error" id="${e(id)}-error" role="alert">${e(message.text)}</p>` };
  };
  const context = (res: Response) => accounts.context(res.locals.sub as string);
  /** The account's gyms and its gym (undefined: none chosen among several, or the chosen one is gone), or undefined when AimHarder cannot be read. */
  const accountOf = async (ctx: Context | undefined) => {
    try { return ctx ? await ctx.upstream.account() : undefined; }
    catch { return undefined; }
  };
  const timetableOf = async (sub: string, ctx: Context, gym: Gym): Promise<Timetable> => {
    const key = `${sub}:${gym.id}`;
    const cached = timetables.get(key);
    if (cached && Date.now() - cached.at < timetableCacheMs) return cached.timetable;
    const timetable: Timetable = { byDay: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, names: [] };
    try {
      const start = today(gym.timeZone);
      const schedule = await getClassSessions(ctx, { startDate: start, endDate: addDays(start, 6) });
      for (const session of schedule.sessions) timetable.byDay[weekdayOf(session.date)].push({ startTime: session.startTime, className: session.classType.name });
      for (const day of weekdays) timetable.byDay[day].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.className.localeCompare(b.className, 'es'));
      timetable.names = [...new Set(schedule.sessions.map((session) => session.classType.name))].sort((a, b) => a.localeCompare(b, 'es'));
      timetables.set(key, { at: Date.now(), timetable });
    } catch { /* without a timetable, the plan can still be read and pruned */ }
    return timetable;
  };

  router.get('/assets/app.js', (_req, res) => {
    res.type('text/javascript').set('Cache-Control', 'no-cache').set('X-Content-Type-Options', 'nosniff').send(appScript);
  });
  router.get('/', async (req, res) => { res.redirect(303, (await sessionOf(req)) ? '/settings' : '/login'); });

  // Sign-in for the settings pages, with the same AimHarder account as the connector.
  const loginPage = (res: Response, status: number, error?: string) => sendPublicPage(res, status, 'Entrar', `<h1>Entrar</h1>
<section><p class="lead">Con el mismo correo y contraseña que usas en la app de AimHarder.</p>
${signInForm({ action: '/login', submit: 'Entrar', error })}</section>
<p class="muted">¿No tienes acceso? Pide una invitación a quien administra el servidor.</p>`);
  router.get('/login', async (req, res) => {
    if (await sessionOf(req)) { res.redirect(303, '/settings'); return; }
    loginPage(res, 200);
  });
  router.post('/login', signInLimit, sameOrigin, form, async (req, res) => {
    const body = req.body as Body;
    const username = field(body, 'username');
    const password = typeof body.password === 'string' ? body.password : '';
    const result = username && password ? await accounts.signIn(username, password) : { error: 'credentials' as const };
    if ('error' in result) {
      const reasons = {
        credentials: 'El correo o la contraseña no son correctos. Usa los mismos que en la app de AimHarder.',
        'not-invited': 'Esta cuenta de AimHarder no tiene acceso a este servidor. Pide una invitación a quien lo administra.',
        unavailable: 'No se ha podido comprobar tu cuenta porque AimHarder no responde. Inténtalo de nuevo en unos minutos.',
      };
      loginPage(res, result.error === 'unavailable' ? 503 : 401, reasons[result.error]);
      return;
    }
    await startSession(res, result.sub);
    res.redirect(303, '/settings');
  });
  router.post('/logout', sameOrigin, (_req, res) => {
    res.clearCookie(cookieName, { path: '/' });
    res.redirect(303, '/login');
  });

  // Invitations: a single-use link the owner shares; the invitee signs in with AimHarder to join.
  const invitePage = (res: Response, status: number, token: string, label: string, error?: string) => sendPublicPage(res, status, 'Invitación', `<h1>Hola, ${e(label)}</h1>
<section><p>Te han invitado a usar AimHarder desde Claude o ChatGPT: pregunta por las clases y el entreno del día, mira quién va a una clase y reserva o cancela confirmándolo en el chat.</p>
<p class="lead">Entra con tu cuenta de AimHarder para aceptar.</p>
${signInForm({ action: `/invite/${encodeURIComponent(token)}`, submit: 'Aceptar la invitación', error })}
<p class="hint">Tu correo y tu contraseña se guardan cifrados en este servidor: los necesita para consultar AimHarder por ti. Si quieres dejar de usarlo, pide a quien lo administra que te retire el acceso y se borrarán.</p></section>`);
  const invalidInvitation = (res: Response) => sendPublicPage(res, 410, 'Invitación no válida', '<h1>Este enlace de invitación ya no funciona</h1><p>Ya se ha usado o ha caducado: cada enlace sirve una sola vez y dura siete días. Pide uno nuevo a quien administra el servidor.</p>');
  router.get('/invite/:token', (req, res) => {
    const invitation = accounts.store.invitation(String(req.params.token));
    if (!invitation) { invalidInvitation(res); return; }
    invitePage(res, 200, String(req.params.token), invitation.label);
  });
  router.post('/invite/:token', signInLimit, sameOrigin, form, async (req, res) => {
    const token = String(req.params.token);
    const invitation = accounts.store.invitation(token);
    if (!invitation) { invalidInvitation(res); return; }
    const body = req.body as Body;
    const username = field(body, 'username');
    const password = typeof body.password === 'string' ? body.password : '';
    const result = username && password ? await accounts.join(token, username, password) : { error: 'credentials' as const };
    if ('error' in result) {
      if (result.error === 'invitation') { invalidInvitation(res); return; }
      const reasons = {
        credentials: [401, 'El correo o la contraseña no son correctos. Usa los mismos que en la app de AimHarder.'],
        unavailable: [503, 'No se ha podido comprobar tu cuenta porque AimHarder no responde. Inténtalo de nuevo en unos minutos.'],
        owner: [400, 'Esta cuenta ya tiene acceso: es la de quien administra el servidor. Entra desde la página de inicio de sesión.'],
        'no-gym': [403, 'Tu cuenta de AimHarder no tiene ningún gimnasio. La invitación sigue sin usar, por si quieres entrar con otra cuenta.'],
      } as const;
      const [status, message] = reasons[result.error];
      invitePage(res, status, token, invitation.label, message);
      return;
    }
    await startSession(res, result.sub);
    res.redirect(303, '/welcome');
  });

  // How to add the connector, for people who have never done it.
  router.get('/welcome', signedIn, (_req, res) => {
    const url = new URL('/mcp', config.publicUrl).href;
    layout(res, 200, 'Conectar', 'welcome', `<h1>Conecta tu asistente</h1>
<section class="highlight"><h2>Dirección del conector</h2><p class="lead">Cópiala: la pegarás en Claude o en ChatGPT siguiendo los pasos de abajo.</p>${copyField('connector-url', url, true)}</section>
<section><h2>Claude</h2><p class="lead">Se añade una sola vez y funciona en claude.ai, en la app de escritorio y en el móvil. Hazlo desde un navegador o la app de escritorio:</p><ol>
<li>Abre <strong>Personalizar → Conectores</strong> (en inglés, <em>Customize → Connectors</em>).</li>
<li>Pulsa <strong>Añadir conector personalizado</strong> (<em>Add custom connector</em>).</li>
<li>Escribe el nombre <code>AimHarder</code> y pega la dirección del conector. Si pregunta cómo identificarse, elige registrarse automáticamente.</li>
<li>Pulsa <strong>Añadir</strong> y después <strong>Conectar</strong>.</li>
<li>Se abre la página <strong>Autorizar AimHarder MCP</strong>: entra con tu correo y contraseña de AimHarder y pulsa <strong>Autorizar</strong>.</li>
</ol><p>En cada chat, comprueba que está activado en <strong>+ → Conectores</strong>. La primera vez que use cada herramienta te pedirá permiso: para las que solo consultan puedes elegir «Permitir siempre»; para reservar o cancelar, es mejor aprobarlas una a una.</p></section>
<section><h2>ChatGPT</h2><ol>
<li>Abre <a href="https://chatgpt.com/plugins">chatgpt.com/plugins</a> en un navegador y elige <strong>+ → Add custom MCP server</strong>.</li>
<li>Nombre <code>AimHarder</code>. En <strong>Connection</strong> elige <strong>Server URL</strong> y pega la dirección del conector.</li>
<li>Elige <strong>OAuth</strong> y, si pregunta, <strong>Dynamic Client Registration (DCR)</strong>. Deja vacíos Client ID y Client Secret.</li>
<li>Pulsa <strong>Create as a plugin</strong> y después <strong>Install</strong>.</li>
<li>En un chat nuevo escribe <code>@</code>, elige <strong>AimHarder</strong> y pregunta algo. Cuando pida autorizar, entra con tu cuenta de AimHarder.</li>
</ol></section>
<section><h2>Prueba a preguntar</h2><ul><li>«¿Qué clases hay mañana?»</li><li>«¿Cuál es el entreno de hoy?»</li><li>«¿Quién va a la clase de las 14:00 de hoy?»</li><li>«Resérvame la clase de mañana a las 7:00»</li></ul>
<p>Antes de reservar, cancelar o guardar algo, el asistente te enseña exactamente lo que va a hacer y no hace nada hasta que lo confirmas.</p>
<p>Tu gimnasio, tu plan semanal, tu clase de entreno y tus amigos se configuran en <a href="/settings">Ajustes</a>.</p></section>`);
  });

  // Each account's own settings: its gym (and that gym's rules) first, then the weekly plan, preferences, friends and the
  // calendar link. Until the account has a gym (several and none chosen, or the chosen one is gone) only the choice of gym
  // is shown. `calendarLink` is a calendar feed link just created, shown this once.
  const settingsPage = async (req: Request, res: Response, status = 200, calendarLink?: string) => {
    const sub = res.locals.sub as string;
    const ctx = context(res);
    const config = accounts.preferences(sub);
    const found = await accountOf(ctx);
    if (!ctx || !config || !found) {
      layout(res, 200, 'Ajustes', 'settings', '<h1>Ajustes</h1><section><p class="error">No se ha podido consultar tu cuenta en AimHarder, así que ahora no se muestran tus ajustes. Recarga la página en unos minutos.</p></section>');
      return;
    }
    const { gyms, gym } = found;
    const gone = config.gym !== undefined && !gym;
    const choice = gyms.length > 1 || gone ? `<form method="post" action="/settings/gym"><label for="gym">Gimnasio</label><select id="gym" name="gym">
${gym ? '' : '<option value="" selected disabled>Elige tu gimnasio</option>'}${gyms.map((entry) => `<option value="${e(entry.id)}"${gym?.id === entry.id ? ' selected' : ''}>${e(entry.name)}</option>`).join('')}</select>
<p class="hint">${gym ? 'Si cambias de gimnasio se borran el resto de tus ajustes (zona horaria, márgenes, plan, clase de entreno, filtro y amigos), porque son del gimnasio anterior, y las reservas vuelven a pedir confirmación.' : 'Tu cuenta de AimHarder tiene varios. El asistente usa solo el que elijas.'}</p>
<div class="btn-row"><button type="submit"${gym ? '' : ' class="primary"'}>${gym ? 'Cambiar de gimnasio' : 'Elegir gimnasio'}</button></div></form>` : '';
    if (!gym) {
      layout(res, 200, 'Ajustes', 'settings', `<h1>Ajustes</h1><section id="gimnasio"><h2>Tu gimnasio</h2>${notice(req, 'gimnasio')}
${gone ? '<p class="notice error" role="alert">Tu gimnasio ya no está disponible: elige otro.</p>' : '<p class="lead">Elige el gimnasio que quieres usar con el asistente. Hasta entonces no puede consultar ni reservar nada.</p>'}
${choice}</section>`);
      return;
    }
    const timetable = await timetableOf(sub, ctx, gym);
    const [tz, book, cancel] = [fieldError(req, 'tz'), fieldError(req, 'book'), fieldError(req, 'cancel')];
    // An unconfirmed zone stays so until the account holder picks one: saving the other rules does not confirm it.
    const zone = config.timeZone;
    const zones = zone === undefined || timeZones.includes(zone) ? timeZones : [zone, ...timeZones];
    const gymSection = `<section id="gimnasio"><h2>Tu gimnasio</h2><p class="lead">${gyms.length > 1 ? 'El que usa el asistente y sus reglas.' : `${e(gym.name)}. Sus reglas, tal como las conoces.`}</p>${notice(req, 'gimnasio')}
${choice}<form method="post" action="/settings/rules">
<label for="tz">Zona horaria</label><select id="tz" name="tz"${tz.attributes}>${zone === undefined ? '<option value="" selected>Sin confirmar (se supone Europe/Madrid)</option>' : ''}${zones.map((entry) => `<option${entry === zone ? ' selected' : ''}>${e(entry)}</option>`).join('')}</select>
${tz.text}<p class="hint">${zone ? 'La de la ciudad del gimnasio; con ella se interpretan las horas de las clases.' : 'Elige la de la ciudad del gimnasio y guárdala para poder reservar y cancelar desde el asistente.'}</p>
<label for="book">Apertura de reservas (días)</label><input id="book" name="book" type="number" inputmode="numeric" min="1" max="${maxBookingWindowDays}" value="${e(String(config.bookingWindowDays ?? ''))}" placeholder="Sin configurar"${book.attributes}>
${book.text}<p class="hint">Con cuántos días de antelación se abren las reservas de una clase.</p>
<label for="cancel">Margen de cancelación (minutos)</label><input id="cancel" name="cancel" type="number" inputmode="numeric" min="1" max="${maxCancellationWindowMinutes}" value="${e(String(config.cancellationWindowMinutes ?? ''))}" placeholder="Sin configurar"${cancel.attributes}>
${cancel.text}<p class="hint">Cuántos minutos antes de la clase cancelar puede costar el crédito.</p>
<div class="btn-row"><button type="submit">Guardar reglas</button></div></form></section>`;
    const entries = config.bookingPlan;
    const known = (day: Weekday, startTime: string, className: string) => timetable.byDay[day].some((slot) => slot.startTime === startTime && slot.className === className);
    const haveTimetable = timetable.names.length > 0;
    const rows = entries.map((entry) => `<tr><td>${dayNames[entry.day]}</td><td>${e(entry.startTime)}</td><td>${e(entry.className)}${haveTimetable && !known(entry.day, entry.startTime, entry.className) ? '<br><span class="field-error">No aparece en el horario de los próximos siete días</span>' : ''}</td>
<td><form method="post" action="/settings/plan/remove"><input type="hidden" name="day" value="${entry.day}">
<input type="hidden" name="startTime" value="${e(entry.startTime)}"><input type="hidden" name="className" value="${e(entry.className)}"><button type="submit" class="danger small" aria-label="Quitar del plan: ${e(`${dayNames[entry.day]}, ${entry.startTime}, ${entry.className}`)}">Quitar</button></form></td></tr>`).join('');
    const groups = weekdays.map((day) => `<optgroup label="${dayNames[day]}" data-day="${day}">${timetable.byDay[day].map((slot) => `<option value="${e(`${day}|${slot.startTime}|${slot.className}`)}">${e(slot.startTime)} · ${e(slot.className)}</option>`).join('')}</optgroup>`).join('');
    const plan = `<section id="plan"><h2>Plan semanal de reservas</h2><p class="lead">Las clases que sueles reservar. Con ellas basta con decir «resérvame la semana que viene». Puedes añadir varias el mismo día.</p>${notice(req, 'plan')}
${entries.length ? `<table><thead><tr><th scope="col">Día</th><th scope="col">Hora</th><th scope="col">Clase</th><th scope="col"><span class="sr-only">Acciones</span></th></tr></thead><tbody>${rows}</tbody></table>` : '<p>Todavía no hay clases en tu plan. Añade abajo las que sueles reservar.</p>'}
${haveTimetable ? `<form method="post" action="/settings/plan/add" data-plan><h3>Añadir una clase</h3>
<div class="pair"><div><label for="day">Día</label><select id="day" name="day">${weekdays.map((day) => `<option value="${day}">${dayNames[day]}</option>`).join('')}</select></div>
<div><label for="slot">Clase y hora</label><select id="slot" name="slot">${groups}</select></div></div>
<div class="btn-row"><button type="submit" class="primary">Añadir al plan</button></div></form>` : '<p class="error">No se ha podido cargar el horario del gimnasio, así que ahora no puedes añadir clases. Recarga la página en unos minutos.</p>'}</section>`;
    const current = config.workoutClass ?? '';
    const options = [`<option value=""${current ? '' : ' selected'}>Ninguna</option>`, ...timetable.names.map((name) => `<option value="${e(name)}"${name === current ? ' selected' : ''}>${e(name)}</option>`),
      ...(current && !timetable.names.includes(current) ? [`<option value="${e(current)}" selected>${e(current)} (no aparece en el horario de los próximos siete días)</option>`] : [])];
    const preferences = `<section id="preferencias"><h2>Preferencias</h2><p class="lead">Lo que el asistente entiende cuando no le das más detalles.</p>${notice(req, 'preferencias')}<form method="post" action="/settings/preferences">
<label for="workout">Clase de tu entreno</label><select id="workout" name="workout">${options.join('')}</select>
<p class="hint">La clase que se entiende cuando preguntas «¿cuál es el entreno de hoy?».</p>
<label for="participantsFilter">Al preguntar quién va a una clase, mostrar</label>
<select id="participantsFilter" name="participantsFilter"><option value="all"${config.participantsFilter !== 'friends' ? ' selected' : ''}>A todos los apuntados</option>
<option value="friends"${config.participantsFilter === 'friends' ? ' selected' : ''}>Solo a mis amigos</option></select>
<p class="hint">Con «Solo a mis amigos», el asistente te dirá también cuántas personas más hay apuntadas.</p>
<div class="btn-row"><button type="submit">Guardar preferencias</button></div></form></section>`;
    const friends = Object.entries(config.friends).sort(([, a], [, b]) => a.name.localeCompare(b.name, 'es'));
    const findLink = '<a class="button start" href="/settings/friends/find">Añadir amigos desde una clase</a>';
    // Removal buttons belong to a separate form, so that pressing Enter in a name saves the names instead of removing someone.
    const friendList = friends.length ? `<form id="remove-friend" method="post" action="/settings/friends/remove"></form>
<form method="post" action="/settings/friends/rename">${friends.map(([id, friend]) => `<div class="friend">${avatar(friend.photoUrl, friend.name)}
<label class="sr-only" for="friend-${e(id)}">Nombre de ${e(friend.name)}</label><input id="friend-${e(id)}" name="name:${e(id)}" value="${e(friend.name)}" maxlength="100" required>
<button type="submit" form="remove-friend" name="id" value="${e(id)}" class="danger small" aria-label="Quitar a ${e(friend.name)}">Quitar</button></div>`).join('')}
<div class="btn-row">${findLink}<button type="submit">Guardar nombres</button></div></form>` : `<p>Todavía no has añadido a nadie. Búscalos entre los apuntados a una clase a la que vayáis juntos.</p><div class="btn-row">${findLink}</div>`;
    const feed = accounts.calendarFeed(sub);
    const calendar = `<section id="calendario"><h2>Calendario</h2><p class="lead">Tus próximas reservas en tu app de calendario (Apple, Google, Outlook…). Te suscribes a un enlace privado y se actualiza solo.</p>${notice(req, 'calendario')}
${calendarLink ? `<div class="notice ok" role="status" tabindex="-1" data-notice>Enlace creado.</div>
<p>Añádelo en tu app de calendario como calendario suscrito (o «desde URL»).</p>${copyField('calendar-link', calendarLink)}<p class="hint">Es un enlace nuevo: el anterior ya no funciona. Si tenías el calendario suscrito en alguna app, cambia allí el enlace por este. Cópialo ahora: no se volverá a mostrar. Quien tenga el enlace ve tus reservas, así que no lo compartas.</p>`
    : feed ? `<p>Tienes un enlace activo desde el ${e(shortDate(feed.createdAt))}. Si lo has perdido o crees que otra persona lo tiene, crea uno nuevo: el anterior dejará de funcionar.</p>` : ''}
<form id="calendar-create" method="post" action="/settings/calendar"></form>${feed ? '<form id="calendar-revoke" method="post" action="/settings/calendar/revoke"></form>' : ''}
<div class="btn-row">${feed ? '<button type="submit" form="calendar-revoke" class="danger start">Desactivar el enlace</button>' : ''}<button type="submit" form="calendar-create"${feed ? '' : ' class="primary"'}>${feed ? 'Crear un enlace nuevo' : 'Crear el enlace'}</button></div>
<p class="hint">Solo aparecen las reservas que AimHarder muestra como próximas; las que cancelas desaparecen. Tu app consulta el enlace cada cierto tiempo, así que un cambio puede tardar en verse.</p></section>`;
    layout(res, status, 'Ajustes', 'settings', `<h1>Ajustes</h1>${gymSection}${plan}${preferences}
<section id="amigos"><h2>Amigos</h2><p class="lead">Cuando preguntes quién va a una clase, puedes ver solo a tus amigos, con el nombre por el que los conoces.</p>${notice(req, 'amigos')}
${friendList}</section>
${calendar}`);
  };
  router.get('/settings', signedIn, (req, res) => settingsPage(req, res));

  // The calendar feed link: creating one replaces the previous link, which stops working.
  router.post('/settings/calendar', sameOrigin, signedIn, form, async (req, res) => {
    // The link is offered once the account has a gym.
    if (!(await accountOf(context(res)))?.gym) { res.redirect(303, '/settings#gimnasio'); return; }
    const token = accounts.createCalendarFeed(res.locals.sub as string);
    if (!token) { back(res, '/settings', 'calendario', 'invalid'); return; }
    await settingsPage(req, res, 201, new URL(`/calendar/${token}.ics`, config.publicUrl).href);
  });
  router.post('/settings/calendar/revoke', sameOrigin, signedIn, form, (_req, res) => {
    accounts.revokeCalendarFeed(res.locals.sub as string);
    back(res, '/settings', 'calendario', 'calendar-revoked');
  });

  router.post('/settings/gym', sameOrigin, signedIn, form, async (req, res) => {
    const sub = res.locals.sub as string;
    const gymId = field(req.body as Body, 'gym');
    const found = await accountOf(context(res));
    if (!found) { back(res, '/settings', 'gimnasio', 'invalid'); return; }
    if (!gymIdSchema.safeParse(gymId).success || !found.gyms.some((entry) => entry.id === gymId)) { back(res, '/settings', 'gimnasio', 'gym'); return; }
    save(res, 'gimnasio', () => accounts.chooseGym(sub, gymId), 'gym-chosen');
  });

  router.post('/settings/rules', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const [timeZone, book, cancel] = [field(body, 'tz'), field(body, 'book'), field(body, 'cancel')];
    // An empty window means none; an empty zone leaves it unconfirmed.
    const window = (value: string, schema: typeof bookingWindowSchema) => (value === '' ? null : wholeNumber(value, schema));
    // Check each value on its own, to point at the field that is wrong.
    if (timeZone !== '' && !timeZoneSchema.safeParse(timeZone).success) { back(res, '/settings', 'gimnasio', 'tz', 'tz'); return; }
    const bookingWindowDays = window(book, bookingWindowSchema);
    if (bookingWindowDays === undefined) { back(res, '/settings', 'gimnasio', 'book', 'book'); return; }
    const cancellationWindowMinutes = window(cancel, cancellationWindowSchema);
    if (cancellationWindowMinutes === undefined) { back(res, '/settings', 'gimnasio', 'cancel', 'cancel'); return; }
    save(res, 'gimnasio', () => accounts.setGymRules(sub, { ...(timeZone ? { timeZone } : {}), bookingWindowDays, cancellationWindowMinutes }));
  });

  router.post('/settings/preferences', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const filter = field(body, 'participantsFilter');
    save(res, 'preferencias', () => accounts.setDefaults(sub, { workoutClass: field(body, 'workout') || null, ...(filter ? { participantsFilter: filter } : {}) }));
  });

  router.post('/settings/plan/add', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const [day, startTime, ...rest] = field(body, 'slot').split('|');
    const className = rest.join('|');
    if (!day || !startTime || !className || !(weekdays as readonly string[]).includes(day)) { back(res, '/settings', 'plan', 'plan-slot'); return; }
    save(res, 'plan', () => accounts.addPlanEntry(sub, { day: day as Weekday, startTime, className }), 'plan-added');
  });
  router.post('/settings/plan/remove', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const [day, startTime, className] = [field(body, 'day'), field(body, 'startTime'), field(body, 'className')];
    save(res, 'plan', () => accounts.removePlanEntry(sub, { day: day as Weekday, startTime, className }), 'plan-removed');
  });

  router.post('/settings/friends/add', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const ids = list(body, 'friend').map((id) => id.trim());
    if (!ids.length) { back(res, '/settings', 'amigos', 'friend'); return; }
    const added: Friends = Object.fromEntries(ids.map((id) => {
      const photoUrl = field(body, `photo:${id}`);
      return [id, { name: field(body, `name:${id}`), ...(photoUrl ? { photoUrl } : {}) }];
    }));
    save(res, 'amigos', () => accounts.addFriends(sub, added), 'friends-added', 'friend');
  });
  // Every friend's name, from one form: `name:<id>` for each friend shown.
  router.post('/settings/friends/rename', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const names = Object.fromEntries(Object.keys(body).filter((key) => key.startsWith('name:')).map((key) => [key.slice('name:'.length), field(body, key)]));
    save(res, 'amigos', () => accounts.renameFriends(sub, names), 'saved', 'friend');
  });
  router.post('/settings/friends/remove', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    save(res, 'amigos', () => accounts.removeFriend(sub, field(req.body as Body, 'id')), 'friend-removed');
  });

  // Find friends among the participants of a class: pick a day, then a class, then the people.
  router.get('/settings/friends/find', signedIn, async (req, res) => {
    const sub = res.locals.sub as string;
    const ctx = context(res);
    const found = await accountOf(ctx);
    if (ctx && found && !found.gym) { res.redirect(303, '/settings#gimnasio'); return; }
    const gym = found?.gym;
    if (!ctx || !gym) {
      layout(res, 503, 'Añadir amigos', 'settings', '<h1>Añadir amigos</h1><p class="error">No se ha podido consultar tu cuenta en AimHarder. Recarga la página en unos minutos.</p><p><a href="/settings#amigos">Volver a Ajustes</a></p>');
      return;
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(query(req, 'date')) ? query(req, 'date') : today(gym.timeZone);
    let content = '';
    try {
      if (query(req, 'class') && query(req, 'time')) {
        const result = await getClassParticipants(ctx, { date, className: query(req, 'class'), startTime: query(req, 'time'), filter: 'all' });
        const { accountId } = await ctx.upstream.account();
        const friends: Friends = { ...accounts.preferences(sub)?.friends };
        const people = result.participants.filter((participant) => participant.userId !== accountId);
        // Keep friends' pictures current with what AimHarder shows now.
        accounts.refreshFriendPhotos(sub, Object.fromEntries(people.flatMap((person) => (person.photoUrl ? [[String(person.userId), person.photoUrl]] : []))));
        const backToDay = `<a class="button start" href="/settings/friends/find?date=${e(date)}">Volver a las clases del día</a>`;
        const anyNew = people.some((person) => !Object.hasOwn(friends, String(person.userId)));
        content = `<h2>${e(query(req, 'class'))} · ${e(query(req, 'time'))}</h2>${people.length ? `<form method="post" action="/settings/friends/add"><fieldset class="plain"><legend class="sr-only">Personas apuntadas</legend>${people.map((person) => {
          const id = String(person.userId);
          const friend = Object.hasOwn(friends, id) ? friends[id] : undefined;
          if (friend) {
            return `<div class="check"><span class="spacer"></span>${avatar(person.photoUrl, person.name)}<span class="who"><span>${e(person.name)}</span><span class="badge">Ya es tu amigo${friend.name !== person.name ? `, como «${e(friend.name)}»` : ''}</span></span></div>`;
          }
          return `<label class="check"><input type="checkbox" name="friend" value="${e(id)}">${avatar(person.photoUrl, person.name)}<span class="who">${e(person.name)}</span></label>
<input type="hidden" name="name:${e(id)}" value="${e(person.name.slice(0, 100))}">${person.photoUrl ? `<input type="hidden" name="photo:${e(id)}" value="${e(person.photoUrl)}">` : ''}`;
        }).join('')}</fieldset>
<div class="btn-row">${backToDay}${anyNew ? '<button type="submit" class="primary">Añadir a mis amigos</button>' : ''}</div>${anyNew ? '<p class="hint">Después puedes cambiarles el nombre en Ajustes.</p>' : ''}</form>`
          : `<p>No hay nadie más apuntado a esta clase. Prueba con otra.</p><div class="btn-row">${backToDay}</div>`}`;
      } else {
        content = `<h2>Clases del día</h2>${schedule(await getClassSessions(ctx, { startDate: date, endDate: date }))}`;
      }
    } catch {
      content = '<p class="error">No se ha podido consultar AimHarder. Recarga la página en unos minutos.</p>';
    }
    function schedule(result: Awaited<ReturnType<typeof getClassSessions>>) {
      if (!result.sessions.length) return '<p>No hay clases ese día. Elige otro arriba.</p>';
      return `<ul class="rows">${result.sessions.map((session) => `<li><a href="/settings/friends/find?${e(new URLSearchParams({ date, class: session.classType.name, time: session.startTime }).toString())}">${e(session.startTime)} · ${e(session.classType.name)}</a>${session.occupancy !== null ? ` <span class="meta">${session.occupancy} apuntados</span>` : ''}</li>`).join('')}</ul>`;
    }
    layout(res, 200, 'Añadir amigos', 'settings', `<p><a href="/settings#amigos">← Ajustes</a></p><h1>Añadir amigos</h1><p class="lead">Elige una clase en la que coincidas con ellos y marca a quién quieres añadir.</p>
<section><form method="get" action="/settings/friends/find">
<label for="date">Día</label><input id="date" name="date" type="date" value="${e(date)}" required><div class="btn-row"><button type="submit">Ver clases</button></div></form></section>
<section>${content}</section>`);
  });

  // The owner's administration: people with access and invitations.
  const adminPage = (req: Request, res: Response, status = 200, created?: { url: string; label: string; expiresAt: string }) => {
    const invitations = accounts.store.invitations();
    const members = accounts.members();
    const labelError = fieldError(req, 'label');
    layout(res, status, 'Administrar', 'admin', `<h1>Administrar</h1>
<section id="personas"><h2>Personas con acceso</h2><p class="lead">Cada persona usa el conector con su propia cuenta de AimHarder.</p>${notice(req, 'personas')}
${created ? `<div class="notice ok" role="status" tabindex="-1" data-notice>Invitación creada para ${e(created.label)}.</div>
<p>Envíale este enlace. Funciona una vez y caduca el ${e(shortDate(created.expiresAt))}.</p>${copyField('invitation-link', created.url)}<p class="hint">Cópialo ahora: no se volverá a mostrar.</p>` : ''}
${members.length ? `<ul class="rows">${members.map((member) => `<li><span class="name">${e(member.label)}</span><span class="meta">desde el ${e(shortDate(member.createdAt))}</span>
<form method="post" action="/admin/members/remove"><input type="hidden" name="id" value="${member.id}"><button type="submit" class="danger small" aria-label="Retirar el acceso a ${e(member.label)}">Retirar acceso</button></form></li>`).join('')}</ul>` : '<p>De momento, solo tú. Invita a alguien abajo.</p>'}
${invitations.length ? `<h3>Invitaciones pendientes</h3><ul class="rows">${invitations.map((invitation) => `<li><span class="name">${e(invitation.label)}</span><span class="meta">caduca el ${e(shortDate(invitation.expiresAt))}</span>
<form method="post" action="/admin/invitations/delete"><input type="hidden" name="id" value="${e(invitation.id)}"><button type="submit" class="danger small" aria-label="Anular la invitación de ${e(invitation.label)}">Anular</button></form></li>`).join('')}</ul>` : ''}
<h3>Invitar a alguien</h3><form method="post" action="/admin/invitations"><label for="label">Nombre de la persona</label><input id="label" name="label" maxlength="100" required${labelError.attributes}>
${labelError.text}<p class="hint">Aparecerá en su invitación. Se crea un enlace de un solo uso, válido durante siete días, para que entre con su cuenta de AimHarder.</p>
<div class="btn-row"><button type="submit" class="primary">Crear enlace de invitación</button></div></form></section>
`);
  };
  router.get('/admin', signedIn, ownerOnly, (req, res) => adminPage(req, res));
  router.post('/admin/invitations', sameOrigin, signedIn, ownerOnly, form, async (req, res) => {
    const label = field(req.body as Body, 'label').slice(0, 100);
    if (!label) { back(res, '/admin', 'personas', 'label', 'label'); return; }
    const { token, expiresAt } = accounts.store.createInvitation(label);
    adminPage(req, res, 201, { url: new URL(`/invite/${token}`, config.publicUrl).href, label, expiresAt });
  });
  router.post('/admin/invitations/delete', sameOrigin, signedIn, ownerOnly, form, (req, res) => {
    accounts.store.deleteInvitation(field(req.body as Body, 'id'));
    back(res, '/admin', 'personas', 'invitation-deleted');
  });
  // Removing a member deletes their data, so it asks first: without `confirm=yes` it only shows what would happen.
  router.post('/admin/members/remove', sameOrigin, signedIn, ownerOnly, form, (req, res) => {
    const body = req.body as Body;
    const id = Number(field(body, 'id'));
    const member = accounts.members().find((entry) => entry.id === id);
    if (!member) { res.redirect(303, '/admin#personas'); return; }
    if (field(body, 'confirm') !== 'yes') {
      layout(res, 200, 'Retirar acceso', 'admin', `<p><a href="/admin#personas">← Administrar</a></p><h1>¿Retirar el acceso a ${e(member.label)}?</h1>
<section><p>Si continúas:</p><ul><li>Se borran su correo y su contraseña de AimHarder guardados en este servidor.</li><li>Se borran sus ajustes: plan semanal, clase de entreno y amigos.</li><li>Sus asistentes se desconectan y su sesión se cierra.</li></ul>
<p>No se puede deshacer. Para devolverle el acceso tendrás que enviarle otra invitación.</p>
<form method="post" action="/admin/members/remove"><input type="hidden" name="id" value="${member.id}"><input type="hidden" name="confirm" value="yes">
<div class="btn-row"><a class="button start" href="/admin#personas">Mantener acceso</a><button type="submit" class="danger primary">Retirar acceso</button></div></form></section>`);
      return;
    }
    accounts.removeMember(member.id);
    back(res, '/admin', 'personas', 'removed');
  });
  router.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendPublicPage(res, 500, 'Error', '<h1>Algo ha fallado</h1><p>No se ha podido completar lo que pedías. Vuelve a intentarlo y, si sigue pasando, avisa a quien administra el servidor.</p><p><a href="/settings">Volver a Ajustes</a></p>');
  });
  return router;
}

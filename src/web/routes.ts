import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { friendsSchema, gymIdSchema, gymSettingsSchema, sortPlan, weekdays, type BookingPlan, type Friends, type GymSettings, type HttpConfiguration, type UserSettings, type Weekday } from '../config.js';
import { type Accounts } from '../accounts.js';
import { getClassParticipants, getClassSessions } from '../features/schedule.js';
import type { Context } from '../features/context.js';
import { AccountsOAuthProvider } from '../oauth.js';
import type { Gym } from '../upstream.js';
import { escapeHtml as e, sendPage } from './html.js';

const cookieName = 'aimharder_session';
const dayNames: Record<Weekday, string> = { mon: 'Lunes', tue: 'Martes', wed: 'Miércoles', thu: 'Jueves', fri: 'Viernes', sat: 'Sábado', sun: 'Domingo' };
const messages: Record<string, string> = {
  saved: 'Guardado.',
  invalid: 'Algún valor no es válido. Revisa el formulario.',
  'plan-slot': 'Elige una clase del horario para añadirla al plan.',
  friend: 'Cada amigo necesita un nombre de hasta 100 caracteres.',
  gyms: 'Marca al menos un gimnasio.',
  removed: 'Acceso retirado.',
};
const timetableCacheMs = 60 * 60 * 1000;
/** A gym's classes in the coming seven days, by weekday: what can go in a weekly plan. */
interface Timetable { byDay: Record<Weekday, { startTime: string; className: string }[]>; names: string[] }
const weekdayOf = (date: string) => weekdays[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!;
const avatar = (url: string | undefined | null) => (url ? `<img class="avatar" src="${e(url)}" alt="" width="40" height="40" loading="lazy">` : '<span class="avatar"></span>');
const planScript = `// Show only the selected weekday's classes in each plan form.
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
`;

type Body = Record<string, string | string[] | undefined>;
const field = (body: Body, name: string) => { const value = body[name]; return typeof value === 'string' ? value.trim() : ''; };
const list = (body: Body, name: string) => { const value = body[name]; return value === undefined ? [] : (Array.isArray(value) ? value : [value]); };
const today = (timeZone: string | null) => new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'Europe/Madrid' }).format(new Date());
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const shortDate = (iso: string) => new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'Europe/Madrid' }).format(new Date(iso));

/**
 * The web pages of the remote server, in Spanish for the gym's members: sign-in, invitations, connection instructions,
 * each account's settings, and the owner's administration. The only script is the plan form's weekday filter, and pages
 * work without it. A signed, HttpOnly session cookie
 * identifies the account; every form post must come from this origin.
 */
export function webRouter(config: HttpConfiguration, accounts: Accounts, provider: AccountsOAuthProvider, signInLimit: RequestHandler) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 500 });
  const origin = config.publicUrl.origin;
  const timetables = new Map<string, { at: number; timetable: Timetable }>();

  const sameOrigin: RequestHandler = (req, res, next) => {
    const source = req.get('origin') ?? (URL.canParse(req.get('referer') ?? '') ? new URL(req.get('referer')!).origin : undefined);
    if (source !== origin) { sendPage(res, 403, 'No permitido', '<h1>No permitido</h1><p>Envía el formulario desde esta misma página.</p>'); return; }
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
    if (!accounts.isOwner(res.locals.sub as string)) { sendPage(res, 404, 'No encontrado', '<h1>No encontrado</h1>'); return; }
    next();
  };
  const startSession = async (res: Response, sub: string) => {
    res.cookie(cookieName, await provider.session(sub), {
      httpOnly: true, sameSite: 'lax', secure: config.publicUrl.protocol === 'https:', path: '/', maxAge: AccountsOAuthProvider.sessionSeconds * 1000,
    });
  };
  const layout = (res: Response, status: number, title: string, body: string) => {
    const sub = res.locals.sub as string | undefined;
    const nav = sub ? `<nav><strong>AimHarder MCP</strong><a href="/settings">Ajustes</a><a href="/welcome">Conectar</a>${accounts.isOwner(sub) ? '<a href="/admin">Administrar</a>' : ''}
<form method="post" action="/logout"><button type="submit">Salir</button></form></nav>` : '';
    sendPage(res, status, title, nav + body);
  };
  const notice = (req: Request) => {
    const key = typeof req.query.message === 'string' ? req.query.message : '';
    if (!Object.hasOwn(messages, key)) return '';
    return `<p class="${key === 'saved' || key === 'removed' ? 'ok' : 'error'}">${e(messages[key]!)}</p>`;
  };
  const context = (res: Response) => accounts.context(res.locals.sub as string);
  const gymsOf = async (ctx: Context | undefined): Promise<Gym[] | undefined> => {
    try { return ctx ? (await ctx.upstream.account()).gyms : undefined; }
    catch { return undefined; }
  };
  const timetableOf = async (sub: string, ctx: Context, gym: Gym): Promise<Timetable> => {
    const key = `${sub}:${gym.id}`;
    const cached = timetables.get(key);
    if (cached && Date.now() - cached.at < timetableCacheMs) return cached.timetable;
    const timetable: Timetable = { byDay: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, names: [] };
    try {
      const start = today(gym.timeZone);
      const schedule = await getClassSessions(ctx, { startDate: start, endDate: addDays(start, 6), gymId: gym.id });
      for (const session of schedule.sessions) timetable.byDay[weekdayOf(session.date)].push({ startTime: session.startTime, className: session.classType.name });
      for (const day of weekdays) timetable.byDay[day].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.className.localeCompare(b.className, 'es'));
      timetable.names = [...new Set(schedule.sessions.map((session) => session.classType.name))].sort((a, b) => a.localeCompare(b, 'es'));
      timetables.set(key, { at: Date.now(), timetable });
    } catch { /* without a timetable, the plan can still be read and pruned */ }
    return timetable;
  };
  const saveFriends = (sub: string, friends: Friends) => accounts.saveUserSettings(sub, { ...accounts.userSettings(sub), friends });

  router.get('/settings/plan.js', (_req, res) => {
    res.type('text/javascript').set('Cache-Control', 'no-cache').set('X-Content-Type-Options', 'nosniff').send(planScript);
  });
  router.get('/', async (req, res) => { res.redirect(303, (await sessionOf(req)) ? '/settings' : '/login'); });

  // Sign-in for the settings pages, with the same AimHarder account as the connector.
  const loginPage = (res: Response, status: number, error?: string) => sendPage(res, status, 'Entrar', `<h1>AimHarder MCP</h1>
<section><h2>Entrar</h2><p>Usa tu cuenta de AimHarder.</p>${error ? `<p class="error">${e(error)}</p>` : ''}
<form method="post" action="/login">
<label for="username">Correo de AimHarder</label><input id="username" name="username" type="email" autocomplete="username" required autofocus>
<label for="password">Contraseña de AimHarder</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Entrar</button></form></section>`);
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
        credentials: 'El correo o la contraseña de AimHarder no son correctos.',
        'not-invited': 'Esta cuenta de AimHarder no tiene acceso. Pide una invitación a quien administra el servidor.',
        unavailable: 'No se ha podido comprobar la cuenta con AimHarder. Inténtalo de nuevo en unos minutos.',
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
  const invitePage = (res: Response, status: number, token: string, label: string, error?: string) => sendPage(res, status, 'Invitación', `<h1>Hola, ${e(label)}</h1>
<section><p>Te han invitado a usar tu cuenta de AimHarder desde Claude o ChatGPT: consultar clases y entrenamientos, ver quién va a una clase y reservar o cancelar confirmándolo en el chat.</p>
<p>Entra con tu cuenta de AimHarder para aceptar.</p>${error ? `<p class="error">${e(error)}</p>` : ''}
<form method="post" action="/invite/${e(encodeURIComponent(token))}">
<label for="username">Correo de AimHarder</label><input id="username" name="username" type="email" autocomplete="username" required autofocus>
<label for="password">Contraseña de AimHarder</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Aceptar la invitación</button></form>
<p class="muted">Tu correo y tu contraseña se guardan cifrados en este servidor, porque los necesita para consultar AimHarder por ti. Quien lo administra puede retirarte el acceso, y puedes pedírselo cuando quieras; entonces se borran.</p></section>`);
  const invalidInvitation = (res: Response) => sendPage(res, 410, 'Invitación no válida', '<h1>Invitación no válida</h1><p>Este enlace ya se ha usado o ha caducado. Pide uno nuevo a quien administra el servidor.</p>');
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
        credentials: [401, 'El correo o la contraseña de AimHarder no son correctos.'],
        unavailable: [503, 'No se ha podido comprobar la cuenta con AimHarder. Inténtalo de nuevo en unos minutos.'],
        owner: [400, 'Esta es la cuenta de quien administra el servidor; ya tiene acceso.'],
        'no-gym': [403, 'Tu cuenta de AimHarder no pertenece a ninguno de los gimnasios de este servidor. La invitación sigue sin usar.'],
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
    layout(res, 200, 'Conectar', `<h1>Conecta tu asistente</h1>
<p>Esta es la dirección del conector. La necesitarás en los pasos de abajo:</p><span class="copy">${e(url)}</span>
<section><h2>Claude</h2><p>Se añade una sola vez y funciona en claude.ai, en la app de escritorio y en el móvil. Hazlo desde un navegador o la app de escritorio:</p><ol>
<li>Abre <strong>Personalizar → Conectores</strong> (en inglés, <em>Customize → Connectors</em>).</li>
<li>Pulsa <strong>Añadir conector personalizado</strong> (<em>Add custom connector</em>).</li>
<li>Escribe el nombre <code>AimHarder</code> y pega la dirección de arriba. Si pregunta cómo identificarse, elige registrarse automáticamente.</li>
<li>Pulsa <strong>Añadir</strong> y después <strong>Conectar</strong>.</li>
<li>Se abre la página <strong>Autorizar AimHarder MCP</strong>: entra con tu correo y contraseña de AimHarder y pulsa <strong>Autorizar</strong>.</li>
</ol><p>En cada chat, comprueba que está activado en <strong>+ → Conectores</strong>. La primera vez que use cada herramienta te pedirá permiso: para las que solo consultan puedes elegir «Permitir siempre»; para reservar o cancelar, mejor aprobar cada vez.</p></section>
<section><h2>ChatGPT</h2><ol>
<li>Abre <a href="https://chatgpt.com/plugins">chatgpt.com/plugins</a> en un navegador y elige <strong>+ → Add custom MCP server</strong>.</li>
<li>Nombre <code>AimHarder</code>. En <strong>Connection</strong> elige <strong>Server URL</strong> y pega la dirección de arriba.</li>
<li>Elige <strong>OAuth</strong> y, si pregunta, <strong>Dynamic Client Registration (DCR)</strong>. Deja vacíos Client ID y Client Secret.</li>
<li>Pulsa <strong>Create as a plugin</strong> y después <strong>Install</strong>.</li>
<li>En un chat nuevo escribe <code>@</code>, elige <strong>AimHarder</strong> y pregunta algo. Cuando pida autorizar, entra con tu cuenta de AimHarder.</li>
</ol></section>
<section><h2>Prueba</h2><ul><li>«¿Qué clases hay mañana?»</li><li>«¿Cuál es el entreno de hoy?»</li><li>«¿Quién va a la clase de las 14:00 de hoy?»</li><li>«Resérvame la clase de mañana a las 7:00»</li></ul>
<p>Antes de reservar, cancelar o guardar algo, el asistente te enseña exactamente lo que va a hacer y no hace nada hasta que lo confirmas.</p>
<p>Tu plan semanal, tu clase de entreno y tus amigos se configuran en <a href="/settings">Ajustes</a>.</p></section>`);
  });

  // Each account's own preferences.
  router.get('/settings', signedIn, async (req, res) => {
    const sub = res.locals.sub as string;
    const ctx = context(res);
    const config = accounts.configuration(sub);
    const gyms = await gymsOf(ctx);
    const friends = Object.entries(config?.friends ?? {}).sort(([, a], [, b]) => a.name.localeCompare(b.name, 'es'));
    let preferences: string;
    let plan = '';
    if (ctx && config && gyms) {
      const timetables = new Map(await Promise.all(gyms.map(async (gym) => [gym.id, await timetableOf(sub, ctx, gym)] as const)));
      const heading = (gym: Gym) => (gyms.length > 1 ? `<h3>${e(gym.name)}</h3>` : '');
      preferences = `<section><h2>Preferencias</h2><form method="post" action="/settings/preferences">
${gyms.length > 1 ? `<label for="defaultGym">Gimnasio por defecto</label><select id="defaultGym" name="defaultGym">${gyms.map((gym) => `<option value="${e(gym.id)}"${config.defaultGym === gym.id ? ' selected' : ''}>${e(gym.name)}</option>`).join('')}</select>` : ''}
${gyms.map((gym) => {
        const current = config.workoutClasses?.[gym.id] ?? '';
        const names = timetables.get(gym.id)!.names;
        const options = [`<option value="">Ninguna</option>`, ...names.map((name) => `<option value="${e(name)}"${name === current ? ' selected' : ''}>${e(name)}</option>`),
          ...(current && !names.includes(current) ? [`<option value="${e(current)}" selected>${e(current)} (no aparece en el horario actual)</option>`] : [])];
        return `<label for="workout-${e(gym.id)}">Clase de tu entreno${gyms.length > 1 ? ` en ${e(gym.name)}` : ''}</label>
<select id="workout-${e(gym.id)}" name="workout:${e(gym.id)}">${options.join('')}</select>
<p class="muted">La clase que se entiende cuando preguntas «¿cuál es el entreno de hoy?».</p>`;
      }).join('')}
<label for="participantsFilter">Al preguntar quién va a una clase, mostrar</label>
<select id="participantsFilter" name="participantsFilter"><option value="all"${config.participantsFilter !== 'friends' ? ' selected' : ''}>A todos los apuntados</option>
<option value="friends"${config.participantsFilter === 'friends' ? ' selected' : ''}>Solo a mis amigos</option></select>
<button type="submit">Guardar preferencias</button></form></section>`;
      plan = `<section><h2>Plan semanal de reservas</h2><p class="muted">Las clases que sueles reservar, así basta con decir «resérvame la semana que viene». Puedes poner varias el mismo día.</p>
${gyms.map((gym) => {
        const entries: BookingPlan = config.bookingPlans?.[gym.id] ?? [];
        const timetable = timetables.get(gym.id)!;
        const known = (day: Weekday, startTime: string, className: string) => timetable.byDay[day].some((slot) => slot.startTime === startTime && slot.className === className);
        const haveTimetable = timetable.names.length > 0;
        const rows = entries.map((entry) => `<tr><td>${dayNames[entry.day]}</td><td>${e(entry.startTime)}</td><td>${e(entry.className)}${haveTimetable && !known(entry.day, entry.startTime, entry.className) ? ' <span class="error">no aparece en el horario actual</span>' : ''}</td>
<td><form class="inline" method="post" action="/settings/plan/remove"><input type="hidden" name="gym" value="${e(gym.id)}"><input type="hidden" name="day" value="${entry.day}">
<input type="hidden" name="startTime" value="${e(entry.startTime)}"><input type="hidden" name="className" value="${e(entry.className)}"><button type="submit" class="secondary">Quitar</button></form></td></tr>`).join('');
        const groups = weekdays.map((day) => `<optgroup label="${dayNames[day]}" data-day="${day}">${timetable.byDay[day].map((slot) => `<option value="${e(`${day}|${slot.startTime}|${slot.className}`)}">${e(slot.startTime)} · ${e(slot.className)}</option>`).join('')}</optgroup>`).join('');
        return `${heading(gym)}${entries.length ? `<table><thead><tr><th>Día</th><th>Hora</th><th>Clase</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p>Todavía no hay clases en el plan.</p>'}
${haveTimetable ? `<form method="post" action="/settings/plan/add" data-plan><input type="hidden" name="gym" value="${e(gym.id)}"><h3>Añadir una clase</h3>
<div class="pair"><div><label for="day-${e(gym.id)}">Día</label><select id="day-${e(gym.id)}" name="day">${weekdays.map((day) => `<option value="${day}">${dayNames[day]}</option>`).join('')}</select></div>
<div><label for="slot-${e(gym.id)}">Clase y hora</label><select id="slot-${e(gym.id)}" name="slot">${groups}</select></div></div>
<button type="submit">Añadir al plan</button></form>` : '<p class="error">No se ha podido leer el horario del gimnasio; inténtalo más tarde para añadir clases.</p>'}`;
      }).join('')}</section>`;
    } else {
      preferences = '<section><p class="error">No se ha podido consultar tu cuenta en AimHarder ahora mismo, así que no se muestran tus preferencias ni tu plan. Vuelve a intentarlo en unos minutos.</p></section>';
    }
    const friendRows = friends.map(([id, friend]) => `<form class="friend" method="post" action="/settings/friends/rename">${avatar(friend.photoUrl)}
<input type="hidden" name="id" value="${e(id)}"><input aria-label="Nombre de tu amigo" name="name" value="${e(friend.name)}" maxlength="100" required>
<span class="actions"><button type="submit" class="secondary">Guardar</button><button type="submit" class="secondary" formaction="/settings/friends/remove" formnovalidate>Quitar</button></span></form>`).join('');
    layout(res, 200, 'Ajustes', `<h1>Ajustes</h1>${notice(req)}${preferences}${plan}
<section><h2>Amigos</h2><p class="muted">Cuando preguntes quién va a una clase, puedes ver solo a tus amigos, con el nombre por el que los conoces.</p>
${friends.length ? friendRows : '<p>Todavía no has añadido a nadie.</p>'}
<p><a href="/settings/friends/find">Añadir amigos desde una clase</a></p></section><script src="/settings/plan.js" defer></script>`);
  });

  router.post('/settings/preferences', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const next: UserSettings = { ...accounts.userSettings(sub) };
    const workoutClasses = { ...next.workoutClasses };
    for (const [key, value] of Object.entries(body)) {
      if (!key.startsWith('workout:') || typeof value !== 'string') continue;
      const gymId = key.slice('workout:'.length);
      if (value.trim()) workoutClasses[gymId] = value.trim(); else delete workoutClasses[gymId];
    }
    next.workoutClasses = workoutClasses;
    const filter = field(body, 'participantsFilter');
    if (filter) next.participantsFilter = filter as 'all' | 'friends';
    const defaultGym = field(body, 'defaultGym');
    if (defaultGym) next.defaultGym = defaultGym;
    save(res, () => accounts.saveUserSettings(sub, next));
  });

  const savePlan = (sub: string, gymId: string, change: (plan: BookingPlan) => BookingPlan) => {
    const settings = accounts.userSettings(sub);
    const current = accounts.configuration(sub)?.bookingPlans?.[gymId] ?? [];
    accounts.saveUserSettings(sub, { ...settings, bookingPlans: { ...settings.bookingPlans, [gymId]: sortPlan(change(current)) } });
  };
  router.post('/settings/plan/add', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const [day, startTime, ...rest] = field(body, 'slot').split('|');
    const className = rest.join('|');
    if (!day || !startTime || !className || !(weekdays as readonly string[]).includes(day)) { res.redirect(303, '/settings?message=plan-slot'); return; }
    save(res, () => savePlan(sub, field(body, 'gym'), (plan) => [...plan, { day: day as Weekday, startTime, className }]));
  });
  router.post('/settings/plan/remove', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const [day, startTime, className] = [field(body, 'day'), field(body, 'startTime'), field(body, 'className')];
    save(res, () => savePlan(sub, field(body, 'gym'), (plan) => plan.filter((entry) => !(entry.day === day && entry.startTime === startTime && entry.className === className))));
  });

  router.post('/settings/friends/add', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const friends: Friends = { ...accounts.configuration(sub)?.friends };
    const ids = list(body, 'friend').map((id) => id.trim());
    for (const id of ids) {
      const photoUrl = field(body, `photo:${id}`);
      friends[id] = { name: field(body, `name:${id}`), ...(photoUrl ? { photoUrl } : {}) };
    }
    const parsed = friendsSchema.safeParse(friends);
    if (!ids.length || !parsed.success) { res.redirect(303, '/settings?message=friend'); return; }
    save(res, () => saveFriends(sub, parsed.data));
  });
  router.post('/settings/friends/rename', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const friends: Friends = { ...accounts.configuration(sub)?.friends };
    const id = field(body, 'id');
    if (!Object.hasOwn(friends, id)) { res.redirect(303, '/settings'); return; }
    friends[id] = { ...friends[id]!, name: field(body, 'name') };
    const parsed = friendsSchema.safeParse(friends);
    if (!parsed.success) { res.redirect(303, '/settings?message=friend'); return; }
    save(res, () => saveFriends(sub, parsed.data));
  });
  router.post('/settings/friends/remove', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const friends: Friends = { ...accounts.configuration(sub)?.friends };
    delete friends[field(req.body as Body, 'id')];
    save(res, () => saveFriends(sub, friends));
  });

  // Find friends among the participants of a class: pick a day, then a class, then the people.
  router.get('/settings/friends/find', signedIn, async (req, res) => {
    const sub = res.locals.sub as string;
    const ctx = context(res);
    const gyms = await gymsOf(ctx);
    if (!ctx || !gyms?.length) {
      layout(res, 503, 'Buscar amigos', '<h1>Buscar amigos</h1><p class="error">No se ha podido consultar tu cuenta en AimHarder ahora mismo. Vuelve a intentarlo en unos minutos.</p>');
      return;
    }
    const query = (name: string) => (typeof req.query[name] === 'string' ? req.query[name] : '');
    const gym = gyms.find((entry) => entry.id === query('gym')) ?? gyms.find((entry) => entry.id === ctx.config.defaultGym) ?? gyms[0]!;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(query('date')) ? query('date') : today(gym.timeZone);
    let content = '';
    try {
      if (query('class') && query('time')) {
        const result = await getClassParticipants(ctx, { date, className: query('class'), startTime: query('time'), gymId: gym.id, filter: 'all' });
        const { accountId } = await ctx.upstream.account();
        const friends: Friends = { ...accounts.configuration(sub)?.friends };
        const people = result.participants.filter((participant) => participant.userId !== accountId);
        // Keep friends' pictures current with what AimHarder shows now.
        let refreshed = false;
        for (const person of people) {
          const friend = friends[String(person.userId)];
          if (friend && person.photoUrl && friend.photoUrl !== person.photoUrl) { friends[String(person.userId)] = { ...friend, photoUrl: person.photoUrl }; refreshed = true; }
        }
        if (refreshed) saveFriends(sub, friends);
        content = `<h2>${e(query('class'))} · ${e(query('time'))}</h2>${people.length ? `<form method="post" action="/settings/friends/add">${people.map((person) => {
          const id = String(person.userId);
          const friend = Object.hasOwn(friends, id) ? friends[id] : undefined;
          return `<label class="check">${avatar(person.photoUrl)}<input type="checkbox" name="friend" value="${e(id)}"${friend ? ' checked disabled' : ''}> ${e(person.name)}${friend ? ` <span class="muted">(ya es tu amigo: ${e(friend.name)})</span>` : ''}</label>
<input type="hidden" name="name:${e(id)}" value="${e(person.name.slice(0, 100))}">${person.photoUrl ? `<input type="hidden" name="photo:${e(id)}" value="${e(person.photoUrl)}">` : ''}`;
        }).join('')}<button type="submit">Añadir a mis amigos</button><p class="muted">Después puedes cambiarles el nombre en Ajustes.</p></form>` : '<p>No hay nadie más apuntado a esta clase.</p>'}
<p><a href="/settings/friends/find?gym=${e(encodeURIComponent(gym.id))}&amp;date=${e(date)}">Volver a las clases del día</a></p>`;
      } else {
        const schedule = await getClassSessions(ctx, { startDate: date, endDate: date, gymId: gym.id });
        content = schedule.sessions.length ? `<ul>${schedule.sessions.map((session) => `<li><a href="/settings/friends/find?${e(new URLSearchParams({ gym: gym.id, date, class: session.classType.name, time: session.startTime }).toString())}">${e(session.startTime)} · ${e(session.classType.name)}</a>${session.occupancy !== null ? ` <span class="muted">(${session.occupancy} apuntados)</span>` : ''}</li>`).join('')}</ul>` : '<p>No hay clases ese día.</p>';
      }
    } catch {
      content = '<p class="error">No se ha podido consultar AimHarder. Vuelve a intentarlo en unos minutos.</p>';
    }
    layout(res, 200, 'Buscar amigos', `<h1>Añadir amigos</h1><p class="muted">Elige una clase en la que coincidas con ellos y marca a quién quieres añadir.</p>
<section><form method="get" action="/settings/friends/find">${gyms.length > 1 ? `<label for="gym">Gimnasio</label><select id="gym" name="gym">${gyms.map((entry) => `<option value="${e(entry.id)}"${entry.id === gym.id ? ' selected' : ''}>${e(entry.name)}</option>`).join('')}</select>` : `<input type="hidden" name="gym" value="${e(gym.id)}">`}
<label for="date">Día</label><input id="date" name="date" type="date" value="${e(date)}" required><button type="submit" class="secondary">Ver clases</button></form></section>
<section>${content}</section><p><a href="/settings">Volver a Ajustes</a></p>`);
  });

  // The owner's administration: gyms, invitations, members and the gym's rules.
  const adminPage = async (req: Request, res: Response, status = 200, created?: { url: string; label: string; expiresAt: string }) => {
    const owner = accounts.context(res.locals.sub as string);
    let allGyms: Gym[] | undefined;
    try { allGyms = owner ? (await owner.upstream.account(true)).gyms : undefined; } catch { allGyms = undefined; }
    const config = accounts.configuration(res.locals.sub as string);
    const active = accounts.gymSettings().activeGyms;
    const isActive = (gym: Gym) => !active?.length || active.includes(gym.id);
    const gyms = allGyms?.filter(isActive);
    const invitations = accounts.store.invitations();
    const members = accounts.members();
    layout(res, status, 'Administrar', `<h1>Administrar</h1>${notice(req)}
<section><h2>Invitar</h2>${created ? `<p class="ok">Invitación creada para ${e(created.label)}. Envíale este enlace; funciona una vez y caduca el ${e(shortDate(created.expiresAt))}:</p><span class="copy">${e(created.url)}</span><p class="muted">El enlace no se vuelve a mostrar.</p>` : ''}
<form method="post" action="/admin/invitations"><label for="label">Nombre de la persona</label><input id="label" name="label" maxlength="100" required><button type="submit">Crear enlace de invitación</button></form>
${invitations.length ? `<h3>Pendientes</h3><table><tbody>${invitations.map((invitation) => `<tr><td>${e(invitation.label)}</td><td class="muted">caduca el ${e(shortDate(invitation.expiresAt))}</td><td>
<form class="inline" method="post" action="/admin/invitations/delete"><input type="hidden" name="id" value="${e(invitation.id)}"><button type="submit" class="secondary">Anular</button></form></td></tr>`).join('')}</tbody></table>` : ''}</section>
<section><h2>Personas con acceso</h2>${members.length ? `<table><tbody>${members.map((member) => `<tr><td>${e(member.label)}</td><td class="muted">desde el ${e(shortDate(member.createdAt))}</td><td>
<form class="inline" method="post" action="/admin/members/remove"><input type="hidden" name="id" value="${member.id}"><button type="submit" class="secondary">Retirar acceso</button></form></td></tr>`).join('')}</tbody></table>
<p class="muted">Retirar el acceso borra su contraseña y sus ajustes, y desconecta sus asistentes.</p>` : '<p>Solo tú, de momento.</p>'}</section>
<section><h2>Gimnasios</h2><p class="muted">Los gimnasios que usa este servidor. Los demás no se muestran ni se pueden usar, en ninguna cuenta.</p>
${allGyms ? `<form method="post" action="/admin/gyms">${allGyms.map((gym) => `<label class="check"><input type="checkbox" name="gym" value="${e(gym.id)}"${isActive(gym) ? ' checked' : ''}> ${e(gym.name)} <span class="muted">(${e(gym.id)})</span></label>`).join('')}
<button type="submit">Guardar gimnasios</button></form>` : '<p class="error">No se ha podido consultar AimHarder ahora mismo.</p>'}</section>
<section><h2>Reglas del gimnasio</h2><p class="muted">Se aplican a todas las cuentas. Deja un campo vacío para usar el valor de la configuración del servidor.</p>
${gyms && config ? `<form method="post" action="/admin/gym">${gyms.map((gym) => `${gyms.length > 1 ? `<h3>${e(gym.name)}</h3>` : ''}
<label for="tz-${e(gym.id)}">Zona horaria</label><input id="tz-${e(gym.id)}" name="tz:${e(gym.id)}" value="${e(config.gymTimeZones[gym.id] ?? '')}" placeholder="Europe/Madrid">
<label for="book-${e(gym.id)}">Días de antelación con que se abren las reservas</label><input id="book-${e(gym.id)}" name="book:${e(gym.id)}" type="number" min="1" max="60" value="${e(String(config.bookingWindowDays?.[gym.id] ?? ''))}">
<label for="cancel-${e(gym.id)}">Minutos antes de la clase a partir de los que cancelar puede costar el crédito</label><input id="cancel-${e(gym.id)}" name="cancel:${e(gym.id)}" type="number" min="1" max="10080" value="${e(String(config.cancellationWindowMinutes?.[gym.id] ?? ''))}">`).join('')}
<button type="submit">Guardar reglas</button></form>` : '<p class="error">No se ha podido consultar AimHarder ahora mismo.</p>'}</section>`);
  };
  router.get('/admin', signedIn, ownerOnly, (req, res) => adminPage(req, res));
  router.post('/admin/invitations', sameOrigin, signedIn, ownerOnly, form, async (req, res) => {
    const label = field(req.body as Body, 'label').slice(0, 100);
    if (!label) { res.redirect(303, '/admin?message=invalid'); return; }
    const { token, expiresAt } = accounts.store.createInvitation(label);
    await adminPage(req, res, 201, { url: new URL(`/invite/${token}`, config.publicUrl).href, label, expiresAt });
  });
  router.post('/admin/invitations/delete', sameOrigin, signedIn, ownerOnly, form, (req, res) => {
    accounts.store.deleteInvitation(field(req.body as Body, 'id'));
    res.redirect(303, '/admin?message=saved');
  });
  router.post('/admin/members/remove', sameOrigin, signedIn, ownerOnly, form, (req, res) => {
    const id = Number(field(req.body as Body, 'id'));
    if (Number.isSafeInteger(id) && id > 0) accounts.removeMember(id);
    res.redirect(303, '/admin?message=removed');
  });
  router.post('/admin/gyms', sameOrigin, signedIn, ownerOnly, form, (req, res) => {
    const activeGyms = list(req.body as Body, 'gym').map((id) => id.trim());
    const parsed = gymSettingsSchema.safeParse({ ...accounts.gymSettings(), activeGyms });
    if (!activeGyms.length || !parsed.success) { res.redirect(303, '/admin?message=gyms'); return; }
    accounts.saveGymSettings(parsed.data as GymSettings);
    res.redirect(303, '/admin?message=saved');
  });
  router.post('/admin/gym', sameOrigin, signedIn, ownerOnly, form, (req, res) => {
    const body = req.body as Body;
    const next = { gymTimeZones: {} as Record<string, string>, bookingWindowDays: {} as Record<string, number>, cancellationWindowMinutes: {} as Record<string, number> };
    for (const key of Object.keys(body)) {
      const match = /^(tz|book|cancel):(.+)$/.exec(key);
      const value = field(body, key);
      if (!match || !value || !gymIdSchema.safeParse(match[2]).success) continue;
      const gymId = match[2]!;
      if (match[1] === 'tz') next.gymTimeZones[gymId] = value;
      else (match[1] === 'book' ? next.bookingWindowDays : next.cancellationWindowMinutes)[gymId] = Number(value);
    }
    const current = accounts.gymSettings();
    const parsed = gymSettingsSchema.safeParse({ ...next, ...(current.activeGyms ? { activeGyms: current.activeGyms } : {}) });
    if (!parsed.success) { res.redirect(303, '/admin?message=invalid'); return; }
    accounts.saveGymSettings(parsed.data as GymSettings);
    res.redirect(303, '/admin?message=saved');
  });

  router.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendPage(res, 500, 'Error', '<h1>Algo ha fallado</h1><p>Vuelve a intentarlo. Si sigue pasando, avisa a quien administra el servidor.</p><p><a href="/settings">Volver</a></p>');
  });
  return router;
}

/** Validate and save settings, then return to the settings page with the outcome. */
function save(res: Response, store: () => void) {
  try { store(); }
  catch { res.redirect(303, '/settings?message=invalid'); return; }
  res.redirect(303, '/settings?message=saved');
}


import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { friendsSchema, gymIdSchema, gymSettingsSchema, weekdays, type BookingPlan, type GymSettings, type HttpConfiguration, type UserSettings, type Weekday } from '../config.js';
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
  'plan-incomplete': 'Cada día del plan necesita una clase y una hora, o ninguna de las dos.',
  friend: 'Indica un ID de AimHarder (solo números) y un nombre.',
  removed: 'Acceso retirado.',
};
const classNameCacheMs = 60 * 60 * 1000;

type Body = Record<string, string | string[] | undefined>;
const field = (body: Body, name: string) => { const value = body[name]; return typeof value === 'string' ? value.trim() : ''; };
const list = (body: Body, name: string) => { const value = body[name]; return value === undefined ? [] : (Array.isArray(value) ? value : [value]); };
const today = (timeZone: string | null) => new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'Europe/Madrid' }).format(new Date());
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const shortDate = (iso: string) => new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'Europe/Madrid' }).format(new Date(iso));

/**
 * The web pages of the remote server, in Spanish for the gym's members: sign-in, invitations, connection instructions,
 * each account's settings, and the owner's administration. Pages carry no scripts. A signed, HttpOnly session cookie
 * identifies the account; every form post must come from this origin.
 */
export function webRouter(config: HttpConfiguration, accounts: Accounts, provider: AccountsOAuthProvider, signInLimit: RequestHandler) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 500 });
  const origin = config.publicUrl.origin;
  const classNames = new Map<string, { at: number; names: string[] }>();

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
  const suggestions = async (sub: string, ctx: Context, gym: Gym) => {
    const key = `${sub}:${gym.id}`;
    const cached = classNames.get(key);
    if (cached && Date.now() - cached.at < classNameCacheMs) return cached.names;
    let names: string[] = [];
    try {
      const start = today(gym.timeZone);
      const schedule = await getClassSessions(ctx, { startDate: start, endDate: addDays(start, 6), gymId: gym.id });
      names = [...new Set(schedule.sessions.map((session) => session.classType.name))].sort((a, b) => a.localeCompare(b, 'es'));
    } catch { /* suggestions are optional */ }
    classNames.set(key, { at: Date.now(), names });
    return names;
  };

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
    const friends = Object.entries(config?.friends ?? {});
    let preferences = '';
    let plan = '';
    if (ctx && config && gyms) {
      const names = new Map(await Promise.all(gyms.map(async (gym) => [gym.id, await suggestions(sub, ctx, gym)] as const)));
      const datalist = (gym: Gym) => `<datalist id="classes-${e(gym.id)}">${(names.get(gym.id) ?? []).map((name) => `<option value="${e(name)}">`).join('')}</datalist>`;
      const workout = (gym: Gym) => config.workoutClasses?.[gym.id] ?? '';
      preferences = `<section><h2>Preferencias</h2><form method="post" action="/settings/preferences">
${gyms.length > 1 ? `<label for="defaultGym">Gimnasio por defecto</label><select id="defaultGym" name="defaultGym">${gyms.map((gym) => `<option value="${e(gym.id)}"${config.defaultGym === gym.id ? ' selected' : ''}>${e(gym.name)}</option>`).join('')}</select>` : ''}
${gyms.map((gym) => `<label for="workout-${e(gym.id)}">Clase de tu entreno${gyms.length > 1 ? ` en ${e(gym.name)}` : ''}</label>
<input id="workout-${e(gym.id)}" name="workout:${e(gym.id)}" value="${e(workout(gym))}" list="classes-${e(gym.id)}" maxlength="300" placeholder="Por ejemplo, CROSS">${datalist(gym)}
<p class="muted">La clase que se entiende cuando preguntas «¿cuál es el entreno de hoy?».</p>`).join('')}
<label for="participantsFilter">Al preguntar quién va a una clase, mostrar</label>
<select id="participantsFilter" name="participantsFilter"><option value="all"${config.participantsFilter !== 'following' ? ' selected' : ''}>A todos los apuntados</option>
<option value="following"${config.participantsFilter === 'following' ? ' selected' : ''}>Solo a quienes sigo en AimHarder y a mis amigos</option></select>
<button type="submit">Guardar preferencias</button></form></section>`;
      plan = `<section><h2>Plan semanal de reservas</h2><p class="muted">Las clases que sueles reservar. Así basta con decir «resérvame la semana que viene». Deja vacío un día para no reservarlo.</p>
<form method="post" action="/settings/plan">${gyms.map((gym) => {
        const current: BookingPlan = config.bookingPlans?.[gym.id] ?? {};
        return `${gyms.length > 1 ? `<h3>${e(gym.name)}</h3>` : ''}<table><thead><tr><th>Día</th><th>Clase</th><th>Hora</th></tr></thead><tbody>${weekdays.map((day) => `<tr><td>${dayNames[day]}</td>
<td><input aria-label="Clase del ${dayNames[day]}" name="class:${e(gym.id)}:${day}" value="${e(current[day]?.className ?? '')}" list="classes-${e(gym.id)}" maxlength="300"></td>
<td><input aria-label="Hora del ${dayNames[day]}" name="time:${e(gym.id)}:${day}" type="time" value="${e(current[day]?.startTime ?? '')}"></td></tr>`).join('')}</tbody></table>`;
      }).join('')}<button type="submit">Guardar plan</button></form></section>`;
    } else {
      preferences = '<section><p class="error">No se ha podido consultar tu cuenta en AimHarder ahora mismo, así que no se muestran tus preferencias ni tu plan. Vuelve a intentarlo en unos minutos.</p></section>';
    }
    const friendRows = friends.map(([id, label]) => `<tr><td>${e(label)}</td><td class="muted">${e(id)}</td><td><form class="inline" method="post" action="/settings/friends/remove">
<input type="hidden" name="id" value="${e(id)}"><button type="submit" class="secondary">Quitar</button></form></td></tr>`).join('');
    layout(res, 200, 'Ajustes', `<h1>Ajustes</h1>${notice(req)}${preferences}${plan}
<section><h2>Amigos</h2><p class="muted">Atletas que cuentan como «a quienes sigo» aunque tengan el perfil privado y no puedas seguirlos en AimHarder.</p>
${friends.length ? `<table><tbody>${friendRows}</tbody></table>` : '<p>Todavía no has añadido a nadie.</p>'}
<p><a href="/settings/friends/find">Buscar amigos en una clase</a></p>
<details><summary>Añadir con su ID de AimHarder</summary><form method="post" action="/settings/friends/add">
<label for="friend-id">ID de AimHarder</label><input id="friend-id" name="id" inputmode="numeric" pattern="[1-9][0-9]{0,15}" required>
<label for="friend-label">Nombre</label><input id="friend-label" name="label" maxlength="100" required>
<button type="submit">Añadir</button></form></details></section>`);
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
    if (filter) next.participantsFilter = filter as 'all' | 'following';
    const defaultGym = field(body, 'defaultGym');
    if (defaultGym) next.defaultGym = defaultGym;
    save(res, () => accounts.saveUserSettings(sub, next));
  });

  router.post('/settings/plan', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const plans: Record<string, BookingPlan> = {};
    for (const key of Object.keys(body)) {
      const match = /^class:([^:]+):(mon|tue|wed|thu|fri|sat|sun)$/.exec(key);
      if (!match) continue;
      const [, gymId, day] = match as unknown as [string, string, Weekday];
      const plan = plans[gymId] ??= {};
      const className = field(body, key);
      const startTime = field(body, `time:${gymId}:${day}`);
      if (!className && !startTime) continue;
      if (!className || !startTime) { res.redirect(303, '/settings?message=plan-incomplete'); return; }
      plan[day] = { className, startTime };
    }
    save(res, () => accounts.saveUserSettings(sub, { ...accounts.userSettings(sub), bookingPlans: { ...accounts.userSettings(sub).bookingPlans, ...plans } }));
  });

  router.post('/settings/friends/add', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const body = req.body as Body;
    const added: Record<string, string> = {};
    if (field(body, 'id')) added[field(body, 'id')] = field(body, 'label');
    for (const id of list(body, 'friend')) added[id.trim()] = field(body, `label:${id.trim()}`);
    const current = accounts.configuration(sub)?.friends ?? {};
    const friends = friendsSchema.safeParse({ ...current, ...added });
    if (!Object.keys(added).length || !friends.success) { res.redirect(303, '/settings?message=friend'); return; }
    save(res, () => accounts.saveUserSettings(sub, { ...accounts.userSettings(sub), friends: friends.data }));
  });

  router.post('/settings/friends/remove', sameOrigin, signedIn, form, (req, res) => {
    const sub = res.locals.sub as string;
    const friends = { ...accounts.configuration(sub)?.friends };
    delete friends[field(req.body as Body, 'id')];
    save(res, () => accounts.saveUserSettings(sub, { ...accounts.userSettings(sub), friends }));
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
        const friends = accounts.configuration(sub)?.friends ?? {};
        const people = result.participants.filter((participant) => participant.userId !== accountId);
        content = `<h2>${e(query('class'))} · ${e(query('time'))}</h2>${people.length ? `<form method="post" action="/settings/friends/add">${people.map((person) => {
          const id = String(person.userId);
          const already = Object.hasOwn(friends, id);
          return `<label class="check"><input type="checkbox" name="friend" value="${e(id)}"${already ? ' checked disabled' : ''}> ${e(person.name)}${already ? ' <span class="muted">(ya es tu amigo)</span>' : ''}</label>
<input type="hidden" name="label:${e(id)}" value="${e(person.name.slice(0, 100))}">`;
        }).join('')}<button type="submit">Añadir a mis amigos</button></form>` : '<p>No hay nadie más apuntado a esta clase.</p>'}
<p><a href="/settings/friends/find?gym=${e(encodeURIComponent(gym.id))}&amp;date=${e(date)}">Volver a las clases del día</a></p>`;
      } else {
        const schedule = await getClassSessions(ctx, { startDate: date, endDate: date, gymId: gym.id });
        content = schedule.sessions.length ? `<ul>${schedule.sessions.map((session) => `<li><a href="/settings/friends/find?${e(new URLSearchParams({ gym: gym.id, date, class: session.classType.name, time: session.startTime }).toString())}">${e(session.startTime)} · ${e(session.classType.name)}</a>${session.occupancy !== null ? ` <span class="muted">(${session.occupancy} apuntados)</span>` : ''}</li>`).join('')}</ul>` : '<p>No hay clases ese día.</p>';
      }
    } catch {
      content = '<p class="error">No se ha podido consultar AimHarder. Vuelve a intentarlo en unos minutos.</p>';
    }
    layout(res, 200, 'Buscar amigos', `<h1>Buscar amigos</h1><p class="muted">Elige una clase en la que coincidas con ellos y marca a quién quieres añadir.</p>
<section><form method="get" action="/settings/friends/find">${gyms.length > 1 ? `<label for="gym">Gimnasio</label><select id="gym" name="gym">${gyms.map((entry) => `<option value="${e(entry.id)}"${entry.id === gym.id ? ' selected' : ''}>${e(entry.name)}</option>`).join('')}</select>` : `<input type="hidden" name="gym" value="${e(gym.id)}">`}
<label for="date">Día</label><input id="date" name="date" type="date" value="${e(date)}" required><button type="submit" class="secondary">Ver clases</button></form></section>
<section>${content}</section><p><a href="/settings">Volver a Ajustes</a></p>`);
  });

  // The owner's administration: invitations, members and the gym's rules.
  const adminPage = async (req: Request, res: Response, status = 200, created?: { url: string; label: string; expiresAt: string }) => {
    const owner = accounts.context(res.locals.sub as string);
    const gyms = await gymsOf(owner);
    const config = accounts.configuration(res.locals.sub as string);
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
    const parsed = gymSettingsSchema.safeParse(next);
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


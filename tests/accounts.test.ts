import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type Server } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../src/http-server.js';
import { appBase, appToken } from './support/app-api.js';

// Two AimHarder accounts at the same gym: the owner (configured in the environment) and a friend the owner invites.
const people = {
  owner: { id: 42, username: 'owner@example.invalid', password: 'owner-synthetic-password' },
  friend: { id: 77, username: 'friend@example.invalid', password: 'friend-synthetic-password' },
  stranger: { id: 99, username: 'stranger@example.invalid', password: 'stranger-synthetic-password' },
  formerMember: { id: 55, username: 'former@example.invalid', password: 'former-synthetic-password' },
};
type Person = typeof people.owner;
const ownerSecret = 'synthetic-owner-secret-0123456789';
const claudeCallback = 'https://claude.ai/api/mcp/auth_callback';
const byUsername = (username: string) => Object.values(people).find((person) => person.username === username);
const sampleGym = { role: 'client', gym: 'Gimnasio de prueba', centre_url: 'sample-gym.aimharder.es', boid: 200 };
const oldGym = { role: 'client', gym: 'Gimnasio antiguo', centre_url: 'old-gym.aimharder.es', boid: 300 };
// The owner's gyms can change per test; the former member only belongs to the old gym.
let ownerRoles = [sampleGym];
const account = (id: number) => ({ id, roles: id === 42 ? ownerRoles : id === 55 ? [oldGym] : [sampleGym] });

const upstream = setupServer(http.all(/^http:\/\/(localhost|127\.0\.0\.1):\d+\//, () => passthrough()));
const whoami: number[] = [];
const servers: { server: HttpServer; close: () => void }[] = [];
let port = 0;
let dataDir = '';
let base = '';

beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(async () => {
  port = await freePort();
  base = `http://localhost:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'aimharder-mcp-accounts-'));
  whoami.length = 0;
  ownerRoles = [sampleGym];
  upstream.use(
    http.post('https://login.aimharder.es/api/login', async ({ request }) => {
      const { username, password } = await request.json() as { username: string; password: string };
      const person = byUsername(username);
      if (!person || person.password !== password) return HttpResponse.json({ data: { auth: { authOK: false } } });
      return HttpResponse.json({ data: { userData: { id: person.id }, auth: { authOK: true } } },
        { headers: { 'Set-Cookie': `amhrdrauth=cookie-${person.id}; Domain=.aimharder.es; Path=/; HttpOnly` } });
    }),
    http.get('https://aimharder.es/api/whoami', ({ request }) => {
      const id = Number(/amhrdrauth=cookie-(\d+)/.exec(request.headers.get('cookie') ?? '')?.[1]);
      whoami.push(id);
      return HttpResponse.json({ data: [account(id)] });
    }),
    http.get(`${appBase}/login`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const person = byUsername(params.get('mail') ?? '');
      if (!person || person.password !== params.get('pw')) return HttpResponse.json({ error: 'Correo electrónico y/o contraseña incorrecto' });
      return HttpResponse.json({ cookie: appToken(person.id), userId: person.id, clientBoxes: [] });
    }),
    http.get(`${appBase}/bookings`, () => HttpResponse.json({ bookings: [
      { id: 840420, classId: 10, className: 'CROSS', time: '07:00 - 08:00', ocupation: 2, limit: 14, coachName: null },
    ] })),
    http.get(`${appBase}/classAthleteBookings`, () => HttpResponse.json({ athletes: [
      { id: 1, usid: 77, name: 'Friend Fixture', state: 1, pic: 'https://images.example.invalid/77.jpg' },
      { id: 2, usid: 88, name: 'Private Partner', state: 1, pic: 'https://images.example.invalid/88-new.jpg' },
    ] })),
  );
  await start();
});
afterEach(async () => {
  await stopAll();
  rmSync(dataDir, { recursive: true, force: true });
  upstream.resetHandlers();
});
afterAll(() => upstream.close());

function freePort() {
  return new Promise<number>((resolve) => {
    const probe: Server = createNetServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function start(extra: Record<string, string> = {}) {
  const { app, config, close } = createHttpApp({ ...extra,
    AIMHARDER_USERNAME: people.owner.username, AIMHARDER_PASSWORD: people.owner.password,
    AIMHARDER_BOOKING_PLAN: '[{"day":"mon","className":"CROSS","startTime":"07:00"}]',
    AIMHARDER_WORKOUT_CLASS: 'CROSS',
    MCP_PUBLIC_URL: base, MCP_OWNER_SECRET: ownerSecret, PORT: String(port), MCP_DATA_DIR: dataDir,
  });
  const server = await new Promise<HttpServer>((resolve) => { const s = app.listen(config.port, '127.0.0.1', () => resolve(s)); });
  servers.push({ server, close });
}

async function stopAll() {
  for (const { server, close } of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    close();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** A browser-like form post from this origin, optionally with a session cookie. */
const post = (path: string, fields: Record<string, string | string[]>, cookie = '', origin: string | null = base) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) for (const item of [value].flat()) body.append(key, item);
  return fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
};
const get = (path: string, cookie = '') => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const sessionCookie = (response: Response) => /aimharder_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')?.[0] ?? '';

async function signIn(person: Person) {
  const response = await post('/login', { username: person.username, password: person.password });
  expect(response.status).toBe(303);
  return sessionCookie(response);
}

async function invite(label = 'Laura') {
  const owner = await signIn(people.owner);
  const created = await post('/admin/invitations', { label }, owner);
  expect(created.status).toBe(201);
  const link = /<code class="copy" id="invitation-link">([^<]+)<\/code>/.exec(await created.text())?.[1];
  expect(link).toMatch(new RegExp(`^${base}/invite/`));
  return new URL(link!).pathname;
}

async function joinAs(person: Person) {
  const path = await invite();
  const joined = await post(path, { username: person.username, password: person.password });
  expect(joined.status).toBe(303);
  expect(joined.headers.get('location')).toBe('/welcome');
  return { path, cookie: sessionCookie(joined) };
}

/** The connector flow Claude or ChatGPT runs, signing in with an AimHarder account. */
async function connect(person: Person) {
  const registration = await (await fetch(`${base}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [claudeCallback], client_name: 'Claude', token_endpoint_auth_method: 'none' }),
  })).json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(`${base}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: registration.client_id, redirect_uri: claudeCallback, state: 'synthetic-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${base}/mcp`,
  })) url.searchParams.set(key, value);
  const approval = /name="approval" value="([^"]+)"/.exec(await (await fetch(url)).text())![1]!;
  const approved = await fetch(`${base}/authorize/approve`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ approval, username: person.username, password: person.password }),
  });
  if (approved.status !== 302) return { status: approved.status, text: await approved.text() };
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
  const tokens = await (await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: claudeCallback, client_id: registration.client_id }),
  })).json() as { access_token: string };
  return { status: 302, accessToken: tokens.access_token };
}

async function accountContext(accessToken: string) {
  const client = new Client({ name: 'accounts-harness', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  const result = await client.callTool({ name: 'get_account_context', arguments: {} });
  await client.close();
  return result;
}

const mcpStatus = async (accessToken: string) => (await fetch(`${base}/mcp`, {
  method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
})).status;

test('an invited friend joins with their AimHarder account and uses their own account through the connector', async () => {
  const { path, cookie } = await joinAs(people.friend);
  const welcome = await (await get('/welcome', cookie)).text();
  expect(welcome).toContain(`${base}/mcp`);
  expect((await get(path)).status).toBe(410);

  const friend = await connect(people.friend);
  expect(friend.status).toBe(302);
  whoami.length = 0;
  const result = await accountContext(friend.accessToken!);
  expect(result.isError).not.toBe(true);
  expect(whoami).toEqual([77]);
  // The friend does not inherit the owner's personal booking plan.
  expect(result.structuredContent).toMatchObject({ defaults: { bookingPlan: [], participantsFilter: 'all', friends: 0 }, settingsUrl: `${base}/settings` });

  const owner = await connect(people.owner);
  whoami.length = 0;
  const ownerResult = await accountContext(owner.accessToken!);
  expect(whoami).toEqual([42]);
  expect(ownerResult.structuredContent).toMatchObject({ defaults: { bookingPlan: [{ day: 'mon', className: 'CROSS', startTime: '07:00' }] } });
});

test('only invited accounts get in, and each invitation link works once', async () => {
  const stranger = await connect(people.stranger);
  expect(stranger.status).toBe(401);
  expect(stranger.text).toContain('no tiene acceso');
  const login = await post('/login', { username: people.stranger.username, password: people.stranger.password });
  expect(login.status).toBe(401);
  expect(sessionCookie(login)).toBe('');

  const path = await invite();
  const wrong = await post(path, { username: people.friend.username, password: 'wrong-password' });
  expect(wrong.status).toBe(401);
  expect((await get(path)).status).toBe(200);
  expect((await post(path, { username: people.owner.username, password: people.owner.password })).status).toBe(400);
  expect((await post('/invite/forged-token', { username: people.friend.username, password: people.friend.password })).status).toBe(410);
});

test('stores members\' passwords encrypted, never in clear text', async () => {
  await joinAs(people.friend);
  const files = readdirSync(dataDir).map((name) => readFileSync(join(dataDir, name)).toString('latin1')).join('');
  expect(files).not.toContain(people.friend.password);
  expect(files).not.toContain(people.friend.username);
});

test('each account edits its own plan, preferences and friends, and the connector applies them', async () => {
  const { cookie } = await joinAs(people.friend);
  const page = await (await get('/settings', cookie)).text();
  expect(page).toContain('Plan semanal');
  expect(page).toContain('<option value="tue|07:00|CROSS">07:00 · CROSS</option>');
  // Members start from their own settings only: the environment configures the owner's account.
  expect(page).toContain('<option value="" selected>Ninguna</option>');
  expect(page).toContain('Sin confirmar (se supone Europe/Madrid)');
  expect(page).not.toContain('Cambiar de gimnasio');
  expect(page).toContain('<script src="/assets/app.js" defer></script>');
  expect((await get('/assets/app.js')).headers.get('content-type')).toContain('text/javascript');

  const outcome = (section: string, message: string, field?: string) => `/settings?message=${message}&section=${section}${field ? `&field=${field}` : ''}#${field ?? section}`;
  for (const slot of ['tue|07:00|CROSS', 'mon|07:00|CROSS', 'tue|07:00|CROSS']) {
    expect((await post('/settings/plan/add', { day: 'mon', slot }, cookie)).headers.get('location')).toBe(outcome('plan', 'plan-added'));
  }
  expect((await post('/settings/plan/add', { day: 'mon', slot: 'someday|07:00|CROSS' }, cookie)).headers.get('location')).toBe(outcome('plan', 'plan-slot'));
  expect((await post('/settings/plan/add', { day: 'mon', slot: '' }, cookie)).headers.get('location')).toBe(outcome('plan', 'plan-slot'));
  expect((await post('/settings/plan/remove', { day: 'mon', startTime: '07:00', className: 'CROSS' }, cookie)).headers.get('location')).toBe(outcome('plan', 'plan-removed'));
  expect((await post('/settings/preferences', { workout: 'CROSS', participantsFilter: 'friends' }, cookie)).headers.get('location')).toBe(outcome('preferencias', 'saved'));
  expect((await post('/settings/preferences', { participantsFilter: 'following' }, cookie)).headers.get('location')).toBe(outcome('preferencias', 'invalid'));

  const found = await (await get('/settings/friends/find?date=2026-11-05&class=CROSS&time=07:00', cookie)).text();
  expect(found).toContain('Private Partner');
  expect(found).toContain('src="https://images.example.invalid/88-new.jpg"');
  expect(found).not.toContain('Friend Fixture');
  expect((await post('/settings/friends/add', { friend: '88', 'name:88': 'Private Partner', 'photo:88': 'https://images.example.invalid/88.jpg' }, cookie)).headers.get('location')).toBe(outcome('amigos', 'friends-added'));
  expect((await post('/settings/friends/rename', { 'name:88': 'Pepe', 'name:404': 'Nobody' }, cookie)).headers.get('location')).toBe(outcome('amigos', 'saved'));
  expect((await post('/settings/friends/rename', { 'name:88': '' }, cookie)).headers.get('location')).toBe(outcome('amigos', 'friend'));
  expect((await post('/settings/friends/add', { friend: '89', 'name:89': 'Someone', 'photo:89': 'http://images.example.invalid/89.jpg' }, cookie)).headers.get('location')).toBe(outcome('amigos', 'friend'));
  // Seeing a friend again in a class refreshes their picture.
  await get('/settings/friends/find?date=2026-11-05&class=CROSS&time=07:00', cookie);
  const settings = await (await get('/settings', cookie)).text();
  expect(settings).toContain('value="Pepe"');
  expect(settings).toContain('src="https://images.example.invalid/88-new.jpg"');

  const friend = await connect(people.friend);
  const result = await accountContext(friend.accessToken!);
  expect(result.structuredContent).toMatchObject({ defaults: {
    bookingPlan: [{ day: 'tue', className: 'CROSS', startTime: '07:00' }], workoutClass: 'CROSS', participantsFilter: 'friends', friends: 1,
  } });

  const owner = await connect(people.owner);
  expect((await accountContext(owner.accessToken!)).structuredContent).toMatchObject({ defaults: { friends: 0, bookingPlan: [{ day: 'mon', className: 'CROSS' }] } });
});

test('an account with several gyms chooses one, and choosing another clears its other settings', async () => {
  ownerRoles = [sampleGym, oldGym];
  const owner = await signIn(people.owner);
  const connection = await connect(people.owner);
  expect(connection.status).toBe(302);
  expect(JSON.stringify(await accountContext(connection.accessToken!))).toContain('GYM_REQUIRED');
  const choosing = await (await get('/settings', owner)).text();
  expect(choosing).toContain('<option value="" selected disabled>Elige tu gimnasio</option>');
  expect(choosing).toContain('Gimnasio antiguo');
  expect(choosing).not.toContain('Plan semanal');
  expect((await get('/settings/friends/find', owner)).headers.get('location')).toBe('/settings#gimnasio');

  const outcome = (message: string) => `/settings?message=${message}&section=gimnasio#gimnasio`;
  expect((await post('/settings/gym', { gym: 'foreign-gym' }, owner)).headers.get('location')).toBe(outcome('gym'));
  expect((await post('/settings/gym', { gym: 'sample-gym' }, owner)).headers.get('location')).toBe(outcome('gym-chosen'));
  // The first choice clears what the environment sets too: it was set for no gym in particular.
  expect((await accountContext(connection.accessToken!)).structuredContent).toMatchObject({ gym: { id: 'sample-gym' }, defaults: { bookingPlan: [], workoutClass: null } });
  await post('/settings/rules', { tz: 'Atlantic/Canary', book: '', cancel: '' }, owner);
  await post('/settings/plan/add', { slot: 'tue|07:00|CROSS' }, owner);
  await post('/settings/preferences', { workout: 'CROSS', participantsFilter: 'friends' }, owner);
  await post('/settings/friends/add', { friend: '88', 'name:88': 'Private Partner' }, owner);
  expect((await post('/settings/gym', { gym: 'sample-gym' }, owner)).headers.get('location')).toBe(outcome('gym-chosen'));
  expect((await accountContext(connection.accessToken!)).structuredContent).toMatchObject({ gym: { id: 'sample-gym', timeZone: 'Atlantic/Canary' }, defaults: { workoutClass: 'CROSS', friends: 1 } });

  expect((await post('/settings/gym', { gym: 'old-gym' }, owner)).headers.get('location')).toBe(outcome('gym-chosen'));
  const after = (await accountContext(connection.accessToken!)).structuredContent;
  expect(after).toMatchObject({ gym: { id: 'old-gym', timeZoneStatus: 'assumed' }, defaults: { bookingPlan: [], workoutClass: null, participantsFilter: 'all', friends: 0 } });
  expect(await (await get('/settings', owner)).text()).toContain('Cambiar de gimnasio');

  // A chosen gym that is no longer the account's asks for another.
  ownerRoles = [sampleGym];
  expect(JSON.stringify(await accountContext(connection.accessToken!))).toContain('GYM_NOT_ACCESSIBLE');
  expect(await (await get('/settings', owner)).text()).toContain('Tu gimnasio ya no está disponible: elige otro.');

  // Administration no longer manages gyms.
  expect(await (await get('/admin', owner)).text()).not.toContain('Gimnasios');
  expect((await post('/admin/gyms', { gym: 'sample-gym' }, owner)).status).toBe(404);
});

test('choosing another gym also sets booking confirmation back to its default', async () => {
  ownerRoles = [sampleGym, oldGym];
  await stopAll();
  await start({ AIMHARDER_GYM: 'sample-gym', AIMHARDER_REQUIRE_BOOKING_CONFIRMATION: 'false' });
  const owner = await signIn(people.owner);
  const connection = await connect(people.owner);
  expect((await accountContext(connection.accessToken!)).structuredContent).toMatchObject({ writeConfirmationPolicy: { bookingCreation: false } });
  await post('/settings/gym', { gym: 'old-gym' }, owner);
  expect((await accountContext(connection.accessToken!)).structuredContent).toMatchObject({ gym: { id: 'old-gym' }, writeConfirmationPolicy: { bookingCreation: true } });
});

test('a data file of version 2 keeps what applied at each account\'s gym', async () => {
  await joinAs(people.friend);
  await stopAll();
  const db = new DatabaseSync(join(dataDir, 'aimharder-mcp.sqlite'));
  db.exec(`INSERT OR REPLACE INTO settings (scope, value, updated_at) VALUES
    ('gym', '{"gymTimeZones":{"sample-gym":"Atlantic/Canary"},"cancellationWindowMinutes":{"sample-gym":90},"activeGyms":["sample-gym"]}', '2026-01-01'),
    ('member:77', '{"defaultGym":"sample-gym","workoutClasses":{"sample-gym":"CROSS"},"bookingPlans":{"sample-gym":[{"day":"wed","className":"CROSS","startTime":"07:00"}],"old-gym":[]},"participantsFilter":"friends"}', '2026-01-01');
    DROP TABLE calendar_feeds; PRAGMA user_version = 2;`);
  db.close();
  await start();
  const friend = await accountContext((await connect(people.friend)).accessToken!);
  expect(friend.structuredContent).toMatchObject({ gym: { id: 'sample-gym', timeZone: 'Atlantic/Canary', timeZoneStatus: 'user-confirmed' },
    defaults: { workoutClass: 'CROSS', participantsFilter: 'friends', bookingPlan: [{ day: 'wed', className: 'CROSS', startTime: '07:00' }] } });
  // The owner had no settings of their own: the gym rules still apply to them.
  const owner = await accountContext((await connect(people.owner)).accessToken!);
  expect(owner.structuredContent).toMatchObject({ gym: { timeZone: 'Atlantic/Canary' }, defaults: { bookingPlan: [{ day: 'mon', className: 'CROSS' }] } });
  await stopAll();
  const migrated = new DatabaseSync(join(dataDir, 'aimharder-mcp.sqlite'));
  expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
  expect(migrated.prepare("SELECT scope FROM settings WHERE scope = 'gym'").all()).toEqual([]);
  expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'calendar_feeds'").all()).toHaveLength(1);
  migrated.close();
  await start();
});

test('a data file from the previous version keeps members and drops personal settings in the old format', async () => {
  const { cookie } = await joinAs(people.friend);
  await post('/settings/preferences', { participantsFilter: 'friends' }, cookie);
  await stopAll();
  const db = new DatabaseSync(join(dataDir, 'aimharder-mcp.sqlite'));
  db.exec(`UPDATE settings SET value = '{"participantsFilter":"following","bookingPlans":{"sample-gym":{"mon":{"className":"CROSS","startTime":"07:00"}}}}'; PRAGMA user_version = 1;`);
  db.close();
  await start();
  const friend = await connect(people.friend);
  expect((await accountContext(friend.accessToken!)).structuredContent).toMatchObject({ defaults: { participantsFilter: 'all', bookingPlan: [] } });
});

test('removing a member signs them out everywhere and deletes their data', async () => {
  const { cookie } = await joinAs(people.friend);
  const friend = await connect(people.friend);
  expect(await mcpStatus(friend.accessToken!)).toBe(200);

  const owner = await signIn(people.owner);
  const admin = await (await get('/admin', owner)).text();
  expect(admin).toContain('Laura');
  // The first post only asks for confirmation; the member keeps access until it is confirmed.
  const confirmation = await post('/admin/members/remove', { id: '77' }, owner);
  expect(confirmation.status).toBe(200);
  expect(await confirmation.text()).toContain('name="confirm" value="yes"');
  expect(await mcpStatus(friend.accessToken!)).toBe(200);
  expect((await post('/admin/members/remove', { id: '77', confirm: 'yes' }, owner)).headers.get('location')).toBe('/admin?message=removed&section=personas#personas');

  expect(await mcpStatus(friend.accessToken!)).toBe(401);
  expect((await get('/settings', cookie)).headers.get('location')).toBe('/login');
  expect((await connect(people.friend)).status).toBe(401);
});

test('keeps members, settings and connections across restarts', async () => {
  const { cookie } = await joinAs(people.friend);
  await post('/settings/friends/add', { friend: '88', 'name:88': 'Private Partner' }, cookie);
  const friend = await connect(people.friend);
  await stopAll();
  await start();
  expect((await accountContext(friend.accessToken!)).structuredContent).toMatchObject({ defaults: { friends: 1 } });
});

test('administration is for the owner only, and forms must come from this origin', async () => {
  const { cookie } = await joinAs(people.friend);
  expect((await get('/admin', cookie)).status).toBe(404);
  expect((await post('/admin/invitations', { label: 'Someone' }, cookie)).status).toBe(404);
  expect((await post('/settings/plan/add', { slot: 'mon|07:00|CROSS' }, cookie, null)).status).toBe(403);
  expect((await post('/settings/plan/add', { slot: 'mon|07:00|CROSS' }, cookie, 'https://attacker.example.invalid')).status).toBe(403);
  expect((await get('/settings')).headers.get('location')).toBe('/login');
});

test('each account sets its own gym rules', async () => {
  const { cookie } = await joinAs(people.friend);
  const outcome = (message: string, field?: string) => `/settings?message=${message}&section=gimnasio${field ? `&field=${field}` : ''}#${field ?? 'gimnasio'}`;
  // Until the account holder picks a zone it stays unconfirmed, even when other rules are saved.
  expect(await (await get('/settings', cookie)).text()).toContain('<option value="" selected>Sin confirmar (se supone Europe/Madrid)</option>');
  expect((await post('/settings/rules', { tz: '', book: '7', cancel: '' }, cookie)).headers.get('location')).toBe(outcome('saved'));
  expect((await accountContext((await connect(people.friend)).accessToken!)).structuredContent).toMatchObject({ gym: { timeZoneStatus: 'assumed' } });
  expect((await post('/settings/rules', { tz: 'Europe/Madrid', book: '7', cancel: '90' }, cookie)).headers.get('location')).toBe(outcome('saved'));
  expect(await (await get('/settings', cookie)).text()).not.toContain('Sin confirmar (se supone');
  expect((await post('/settings/rules', { tz: 'Mars/Olympus', book: '', cancel: '' }, cookie)).headers.get('location')).toBe(outcome('tz', 'tz'));
  expect((await post('/settings/rules', { tz: 'Europe/Madrid', book: '99', cancel: '' }, cookie)).headers.get('location')).toBe(outcome('book', 'book'));
  expect((await post('/settings/rules', { tz: 'Europe/Madrid', book: '', cancel: '1.5' }, cookie)).headers.get('location')).toBe(outcome('cancel', 'cancel'));
  const invalidRule = await (await get('/settings?message=book&section=gimnasio&field=book', cookie)).text();
  expect(invalidRule).toContain('aria-invalid="true" aria-describedby="book-error"');
  expect(invalidRule).toContain('value="7"');
  const friend = await connect(people.friend);
  expect((await accountContext(friend.accessToken!)).structuredContent).toMatchObject({ gym: { timeZone: 'Europe/Madrid', timeZoneStatus: 'user-confirmed' } });
  const owner = await connect(people.owner);
  expect((await accountContext(owner.accessToken!)).structuredContent).toMatchObject({ gym: { timeZoneStatus: 'assumed' } });
});

test('tokens issued before accounts existed keep working as the owner\'s', async () => {
  const key = scryptSync(ownerSecret, 'aimharder-mcp/oauth-signing-key/v1', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const legacy = await new SignJWT({ kind: 'access', client_id: 'legacy-client', scope: '' }).setProtectedHeader({ alg: 'HS256' })
    .setIssuer(`${base}/`).setIssuedAt().setExpirationTime('1h').setAudience(`${base}/mcp`).sign(key);
  whoami.length = 0;
  expect((await accountContext(legacy)).structuredContent).toMatchObject({ defaults: { bookingPlan: [{ day: 'mon', className: 'CROSS' }] } });
  expect(whoami).toEqual([42]);
});

test('the owner edits a plan that starts from the environment, and the environment entries stay in it', async () => {
  const cookie = await signIn(people.owner);
  expect((await post('/settings/plan/add', { day: 'tue', slot: 'tue|07:00|CROSS' }, cookie)).status).toBe(303);
  const owner = await connect(people.owner);
  const result = await accountContext(owner.accessToken!);
  expect(result.structuredContent).toMatchObject({ defaults: { bookingPlan: [
    { day: 'mon', className: 'CROSS', startTime: '07:00' }, { day: 'tue', className: 'CROSS', startTime: '07:00' },
  ] } });
  expect((await post('/settings/plan/remove', { day: 'mon', startTime: '07:00', className: 'CROSS' }, cookie)).status).toBe(303);
  const after = await accountContext((await connect(people.owner)).accessToken!);
  expect(after.structuredContent).toMatchObject({ defaults: { bookingPlan: [{ day: 'tue', className: 'CROSS', startTime: '07:00' }] } });
});

test('the owner can clear a workout class that comes from the environment', async () => {
  const cookie = await signIn(people.owner);
  const owner = await connect(people.owner);
  expect((await accountContext(owner.accessToken!)).structuredContent).toMatchObject({ defaults: { workoutClass: 'CROSS' } });
  expect((await post('/settings/preferences', { workout: '' }, cookie)).status).toBe(303);
  expect((await accountContext((await connect(people.owner)).accessToken!)).structuredContent).toMatchObject({ defaults: { workoutClass: null } });
  expect(await (await get('/settings', cookie)).text()).toContain('<option value="" selected>Ninguna</option>');
});

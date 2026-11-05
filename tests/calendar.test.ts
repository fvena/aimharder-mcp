import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type Server } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { createHttpApp } from '../src/http-server.js';
import { appBase, appToken } from './support/app-api.js';

// The owner (configured in the environment) and a member the owner invites, at the same gym.
const people = {
  owner: { id: 42, username: 'owner@example.invalid', password: 'owner-synthetic-password' },
  friend: { id: 77, username: 'friend@example.invalid', password: 'friend-synthetic-password' },
};
type Person = typeof people.owner;
const ownerSecret = 'synthetic-owner-secret-0123456789';
const byUsername = (username: string) => Object.values(people).find((person) => person.username === username);
const gym = { role: 'client', gym: 'Box Norte, Sala 1', centre_url: 'sample-gym.aimharder.es', boid: 200 };
// The account's gyms; one unless a test says otherwise.
let roles = [gym];

const row = (id: number, day: string, time: string, className: string, bookState = 1) => ({ id, day, time, className, bookState, coachName: 'Private Coach' });
const ownerRows = [
  row(9001, 'Martes, 10 de Noviembre de 2026', '07:00 - 08:00', 'CrossFit; WOD, Ñ'),
  row(9002, 'Lunes, 29 de Marzo de 2027', '19:30 - 20:30', 'Halterofilia', 0),
  row(9004, 'Martes, 30 de Marzo de 2027', '23:30 - 00:30', 'Nocturna', 7),
];
// What AimHarder's upcoming view returns, by account; tests change it to show cancellations and failures.
let upcoming: Record<number, unknown[] | 'error'> = {};
const nextBookingsAccounts: number[] = [];

const upstream = setupServer(http.all(/^http:\/\/(localhost|127\.0\.0\.1):\d+\//, () => passthrough()));
const servers: { server: HttpServer; close: () => void }[] = [];
let port = 0;
let dataDir = '';
let base = '';

beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(async () => {
  port = await freePort();
  base = `http://localhost:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'aimharder-mcp-calendar-'));
  upcoming = { 42: ownerRows, 77: [row(7001, 'Miércoles, 11 de Noviembre de 2026', '18:00 - 19:00', 'Open Box')] };
  nextBookingsAccounts.length = 0;
  roles = [gym];
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
      return HttpResponse.json({ data: [{ id, roles }] });
    }),
    http.get(`${appBase}/login`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      const person = byUsername(params.get('mail') ?? '');
      if (!person || person.password !== params.get('pw')) return HttpResponse.json({ error: 'Correo electrónico y/o contraseña incorrecto' });
      return HttpResponse.json({ cookie: appToken(person.id), userId: person.id, clientBoxes: [] });
    }),
    http.get(`${appBase}/nextBookings`, ({ request }) => {
      const id = Number(new URL(request.url).searchParams.get('token')?.split('|')[0]);
      nextBookingsAccounts.push(id);
      const rows = upcoming[id];
      if (rows === 'error') return new HttpResponse(null, { status: 500 });
      return HttpResponse.json({ nextClasses: rows ?? [], history: [] });
    }),
    http.get(`${appBase}/bookings`, () => HttpResponse.json({ bookings: [] })),
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

async function start() {
  const { app, config, close } = createHttpApp({
    AIMHARDER_USERNAME: people.owner.username, AIMHARDER_PASSWORD: people.owner.password,
    MCP_PUBLIC_URL: base, MCP_OWNER_SECRET: ownerSecret, PORT: String(port), MCP_DATA_DIR: dataDir,
  });
  const server = await new Promise<HttpServer>((resolve) => { const s = app.listen(config.port, '127.0.0.1', () => resolve(s)); });
  servers.push({ server, close });
}

/** Restart the server: the feed cache starts empty, so the next read goes to AimHarder again. */
async function restart() { await stopAll(); await start(); }

async function stopAll() {
  for (const { server, close } of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    close();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const post = (path: string, fields: Record<string, string>, cookie = '') => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual', body: new URLSearchParams(fields),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
});
const get = (path: string, cookie = '') => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const sessionCookie = (response: Response) => /aimharder_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')?.[0] ?? '';

async function signIn(person: Person) {
  const response = await post('/login', { username: person.username, password: person.password });
  expect(response.status).toBe(303);
  return sessionCookie(response);
}

/** Create a calendar link from the settings page and return its path. */
async function createLink(cookie: string) {
  const created = await post('/settings/calendar', {}, cookie);
  expect(created.status).toBe(201);
  const link = /<code class="copy" id="calendar-link">([^<]+)<\/code>/.exec(await created.text())?.[1];
  expect(link).toMatch(new RegExp(`^${base}/calendar/[A-Za-z0-9_-]{43}\\.ics$`));
  return new URL(link!).pathname;
}

/** Unfold content lines (RFC 5545 §3.1). */
const unfold = (body: string) => body.replace(/\r\n /g, '').split('\r\n');
const events = (body: string) => body.split('BEGIN:VEVENT').slice(1).map((part) => unfold(`BEGIN:VEVENT${part.split('END:VEVENT')[0]}END:VEVENT`));

test('an account creates a calendar link in its settings, shown once and stored only as a digest', async () => {
  const cookie = await signIn(people.owner);
  const before = await (await get('/settings', cookie)).text();
  expect(before).toContain('id="calendario"');
  expect(before).toContain('Crear el enlace');

  const path = await createLink(cookie);
  const token = path.slice('/calendar/'.length, -'.ics'.length);
  const after = await (await get('/settings', cookie)).text();
  expect(after).not.toContain(token);
  expect(after).toContain('Tienes un enlace activo');
  expect(after).toContain('Desactivar el enlace');
  // Sending the form again, for example by reloading, makes a new link: the page says the old one stops working.
  const again = await (await post('/settings/calendar', {}, cookie)).text();
  expect(again).toContain('Es un enlace nuevo: el anterior ya no funciona.');

  const files = readdirSync(dataDir).map((name) => readFileSync(join(dataDir, name)).toString('latin1')).join('');
  expect(files).not.toContain(token);
  // Forms must come from this origin.
  expect((await fetch(`${base}/settings/calendar`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie } })).status).toBe(403);
});

test('the feed lists the upcoming bookings as events at their UTC instants', async () => {
  const cookie = await signIn(people.owner);
  const response = await get(await createLink(cookie));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('private, max-age=300');
  const body = await response.text();
  expect(body.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
  expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
  expect(body.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  expect(body).not.toContain('Private Coach');

  // Madrid is UTC+1 in November and UTC+2 after the change to summer time on 28 March 2027.
  const [first, second, third] = events(body);
  expect(first).toEqual(expect.arrayContaining([
    `UID:sample-gym-9001@aimharder-mcp`, 'DTSTART:20261110T060000Z', 'DTEND:20261110T070000Z',
    'SUMMARY:CrossFit\\; WOD\\, Ñ', 'LOCATION:Box Norte\\, Sala 1', 'STATUS:CONFIRMED',
  ]));
  expect(second).toEqual(expect.arrayContaining([
    `UID:sample-gym-9002@aimharder-mcp`, 'DTSTART:20270329T173000Z', 'DTEND:20270329T183000Z', 'SUMMARY:Halterofilia (lista de espera)', 'STATUS:TENTATIVE',
  ]));
  // Another state is shown as AimHarder gives it: no status, no suffix. A class that ends after midnight ends the next day.
  expect(third).toEqual(expect.arrayContaining([`UID:sample-gym-9004@aimharder-mcp`, 'DTSTART:20270330T213000Z', 'DTEND:20270330T223000Z', 'SUMMARY:Nocturna']));
  expect(third!.some((line) => line.startsWith('STATUS:'))).toBe(false);
  expect(body).not.toMatch(/VTIMEZONE|TZID/);
});

test('each booking keeps its UID on every read; cancelled bookings disappear', async () => {
  const cookie = await signIn(people.owner);
  const path = await createLink(cookie);
  const uids = (body: string) => events(body).map((lines) => lines.find((line) => line.startsWith('UID:')));
  const first = await (await get(path)).text();
  expect(uids(first)).toEqual(['UID:sample-gym-9001@aimharder-mcp', 'UID:sample-gym-9002@aimharder-mcp', 'UID:sample-gym-9004@aimharder-mcp']);

  // AimHarder lists the bookings in another order, with a new one: the existing ones keep their UIDs.
  upcoming[42] = [row(9003, 'Jueves, 12 de Noviembre de 2026', '09:00 - 10:00', 'Gimnástica'), ...[...ownerRows].reverse()];
  await restart();
  expect(uids(await (await get(path)).text())).toEqual(['UID:sample-gym-9001@aimharder-mcp', 'UID:sample-gym-9003@aimharder-mcp', 'UID:sample-gym-9002@aimharder-mcp', 'UID:sample-gym-9004@aimharder-mcp']);

  upcoming[42] = [ownerRows[1]!];
  await restart();
  expect(uids(await (await get(path)).text())).toEqual(['UID:sample-gym-9002@aimharder-mcp']);
});

test('reads AimHarder at most every few minutes and answers unchanged feeds with 304', async () => {
  const cookie = await signIn(people.owner);
  const path = await createLink(cookie);
  const first = await get(path);
  const etag = first.headers.get('etag');
  expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  const reads = nextBookingsAccounts.length;
  const again = await fetch(`${base}${path}`, { headers: { 'If-None-Match': etag! } });
  expect(again.status).toBe(304);
  expect(nextBookingsAccounts.length).toBe(reads);

  // After a restart the feed is read again; the same bookings give the same tag.
  await restart();
  expect((await fetch(`${base}${path}`, { headers: { 'If-None-Match': etag! } })).status).toBe(304);
  upcoming[42] = [];
  await restart();
  const changed = await fetch(`${base}${path}`, { headers: { 'If-None-Match': etag! } });
  expect(changed.status).toBe(200);
  expect(events(await changed.text())).toEqual([]);
});

test('a failed AimHarder read is an error, never an empty calendar', async () => {
  const cookie = await signIn(people.owner);
  const path = await createLink(cookie);
  upcoming[42] = 'error';
  const failed = await get(path);
  expect(failed.status).toBe(503);
  expect(failed.headers.get('retry-after')).toBe('300');
  expect(await failed.text()).not.toContain('VCALENDAR');
  // The failure is not cached.
  upcoming[42] = ownerRows;
  expect((await get(path)).status).toBe(200);
});

test('unknown, malformed, replaced and revoked links are not found', async () => {
  const cookie = await signIn(people.owner);
  expect((await get(`/calendar/${'a'.repeat(43)}.ics`)).status).toBe(404);
  expect((await get('/calendar/short.ics')).status).toBe(404);
  const old = await createLink(cookie);
  expect((await get(old.replace('.ics', ''))).status).toBe(404);
  expect((await get(old)).status).toBe(200);

  // A new link replaces the old one.
  const current = await createLink(cookie);
  expect(current).not.toBe(old);
  expect((await get(old)).status).toBe(404);
  expect((await get(current)).status).toBe(200);

  const revoked = await post('/settings/calendar/revoke', {}, cookie);
  expect(revoked.headers.get('location')).toBe('/settings?message=calendar-revoked&section=calendario#calendario');
  expect((await get(current)).status).toBe(404);
  const page = await (await get('/settings?message=calendar-revoked&section=calendario', cookie)).text();
  expect(page).toContain('Enlace desactivado');
  expect(page).toContain('Crear el enlace');
});

test('each account\'s link shows its own bookings, and removing a member revokes theirs', async () => {
  const owner = await signIn(people.owner);
  const created = await post('/admin/invitations', { label: 'Laura' }, owner);
  const invitation = new URL(/<code class="copy" id="invitation-link">([^<]+)<\/code>/.exec(await created.text())![1]!).pathname;
  const joined = await post(invitation, { username: people.friend.username, password: people.friend.password });
  const friend = sessionCookie(joined);
  const path = await createLink(friend);

  nextBookingsAccounts.length = 0;
  const body = await (await get(path)).text();
  expect(nextBookingsAccounts).toEqual([77]);
  expect(events(body).map((lines) => lines.find((line) => line.startsWith('SUMMARY:')))).toEqual(['SUMMARY:Open Box']);

  await post('/admin/members/remove', { id: '77', confirm: 'yes' }, owner);
  expect((await get(path)).status).toBe(404);
});

test('the calendar section and link wait until an account with several gyms chooses one', async () => {
  roles = [gym, { ...gym, gym: 'Otro box', centre_url: 'other-gym.aimharder.es', boid: 300 }];
  const cookie = await signIn(people.owner);
  expect(await (await get('/settings', cookie)).text()).not.toContain('id="calendario"');
  expect((await post('/settings/calendar', {}, cookie)).headers.get('location')).toBe('/settings#gimnasio');
  await post('/settings/gym', { gym: 'sample-gym' }, cookie);
  const path = await createLink(cookie);
  expect((await get(path)).status).toBe(200);
  // A chosen gym that is no longer the account's is an error, never an empty calendar.
  roles = [{ ...gym, centre_url: 'other-gym.aimharder.es', boid: 300 }];
  await restart();
  expect((await get(path)).status).toBe(503);
});

test('the feed is served only for the public host name', async () => {
  const cookie = await signIn(people.owner);
  const path = await createLink(cookie);
  expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(403);
});

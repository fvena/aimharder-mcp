import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { appBase, appLogin } from './support/app-api.js';
import { bookingWindow } from '../src/domain/booking-preparation.js';

const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];
const requests: { method: string; pathname: string }[] = [];
const row = (extra: Record<string, unknown> = {}) => ({
  id: 501, classId: 10, className: 'Open Box', time: '10:00 - 11:00',
  ocupation: 8, limit: 20, enabled: 1, bookState: null, cancelledId: null,
  resadmin: 0, hidden: 0, ...extra,
});
const day = (bookings: unknown[]) => ({ clasesDisp: 'Classes', day: 'Source label', bookings, timetable: [], seminars: [] });

beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  requests.length = 0;
  upstream.use(
    appLogin(),
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({
      data: { userData: { id: 42 }, auth: { authOK: true } },
    }, { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [
      { role: 'client', boid: 200, gym: 'Sample Gym', centre_url: 'sample-gym.aimharder.es' },
    ] }] })),
    http.get(`${appBase}/bookings`, () => HttpResponse.json(day([row()]))),
  );
});
upstream.events.on('request:start', ({ request }) => requests.push({ method: request.method, pathname: new URL(request.url).pathname }));
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  upstream.resetHandlers();
});
afterAll(() => upstream.close());

async function connect(extra: Record<string, string | undefined> = {}) {
  const server = createServer({ AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic-password',
    AIMHARDER_GYM_TIME_ZONES: '{"sample-gym":"Europe/Madrid"}', ...extra });
  const client = new Client({ name: 'booking-preparation-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
async function prepare(client: Client, extra: Record<string, unknown> = {}) {
  return client.callTool({ name: 'prepare_booking_creation', arguments: {
    date: '2026-09-26', className: 'Open Box', startTime: '10:00', endTime: '11:00', ...extra,
  } });
}
const writes = () => requests.filter(({ method }) => method === 'POST');

test('prepares one exact class through read-only MCP calls without a credit warning', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  for (const name of ['prepare_booking_creation', 'execute_booking_creation']) {
    const tool = tools.find(tool => tool.name === name)!;
    expect(tool.description).toContain('writeConfirmationRequired');
    expect(tool.description).toContain('do not ask for another confirmation');
    expect(JSON.stringify(tool)).not.toMatch(/credit/i);
  }
  const result = await prepare(client);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    status: 'ready', action: 'create', gym: { id: 'sample-gym', timeZoneStatus: 'user-confirmed' },
    target: { className: 'Open Box', date: '2026-09-26', startTime: '10:00', endTime: '11:00' },
    currentState: 'unbooked',
    actionReference: expect.any(String), expiresAt: expect.any(String),
  });
  expect((result.structuredContent as { actionReference: string }).actionReference).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toMatch(/sourceId|accountId|boxId|familyId|credit/i);
  expect(requests.map(({ method, pathname }) => [method, pathname])).toEqual([
    ['POST', '/api/login'], ['GET', '/api/whoami'], ['GET', '/aplic/apiExternal/login'], ['GET', '/aplic/apiExternal/bookings'],
  ]);
  expect(writes().map(({ pathname }) => pathname)).toEqual(['/api/login']);
});

test('ambiguous alternatives retain exact class and time without an action reference', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(day([row(), row({ id: 502, enabled: 0 })]))));
  const result = await prepare(await connect());
  expect(result.structuredContent).toMatchObject({ status: 'ambiguous', alternatives: [
    { className: 'Open Box', startTime: '10:00', endTime: '11:00', currentState: 'unbooked' },
    { className: 'Open Box', startTime: '10:00', endTime: '11:00', currentState: 'unbooked' },
  ] });
  expect(result.structuredContent).not.toHaveProperty('actionReference');
});

test.each([
  [[], 'missing'], [[row({ bookState: 1 })], 'already-booked'],
  [[row({ bookState: 0 })], 'waitlisted'], [[row({ bookState: 99 })], 'unsupported'],
  [[row({ enabled: 0 })], 'unsupported'], [[row({ resadmin: 1 })], 'unsupported'],
  [[row({ cancelledId: 3 })], 'unsupported'], [[row({ hidden: 1 })], 'unsupported'],
  [[row({ enabled: undefined })], 'unsupported'], [[row({ bookState: undefined })], 'unsupported'],
  [[row({ cancelledId: undefined })], 'unsupported'],
] as const)('does not issue a reference for %s', async (bookings, status) => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(day([...bookings]))));
  const result = await prepare(await connect());
  expect(result.structuredContent).toMatchObject({ status });
  expect(result.structuredContent).not.toHaveProperty('actionReference');
  expect(JSON.stringify(result)).not.toContain('currently offers this class');
  expect(JSON.stringify(result)).not.toMatch(/credit/i);
});

test('prepares a class when the optional source hidden flag is absent', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(day([row({ hidden: undefined })]))));
  const result = await prepare(await connect());
  expect(result.structuredContent).toMatchObject({ status: 'ready', currentState: 'unbooked' });
  expect(requests.some(({ pathname }) => pathname === '/aplic/apiExternal/book')).toBe(false);
});

test('an assumed zone and an inaccessible gym block preparation', async () => {
  expect((await prepare(await connect({ AIMHARDER_GYM_TIME_ZONES: undefined }))).isError).toBe(true);
  expect(requests.some(({ pathname }) => pathname === '/aplic/apiExternal/bookings')).toBe(false);
  expect((await prepare(await connect(), { gymId: 'other-gym' })).isError).toBe(true);
  expect(requests.some(({ pathname }) => pathname === '/aplic/apiExternal/bookings')).toBe(false);
});

test('preserves gym-local wall times at DST boundaries without inventing an instant', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(day([row({ time: '02:30 - 03:30' })]))));
  for (const date of ['2026-03-29', '2026-10-25']) {
    const result = await prepare(await connect(), { date, startTime: '02:30', endTime: '03:30' });
    expect(result.structuredContent).toMatchObject({ status: 'ready', target: { date, startTime: '02:30', endTime: '03:30' } });
    expect(JSON.stringify(result)).not.toMatch(/utcOffset|startsAt|endsAt/);
  }
});

test.each([{ sourceId: 501 }, { familyId: 1 }, { accountId: 42 }, { date: '2026-09-26T00:00:00Z' }, { endTime: '25:00' }])
('rejects unsupported selectors and invalid input before network access: %j', async (extra) => {
  expect((await prepare(await connect(), extra)).isError).toBe(true);
  expect(requests).toHaveLength(0);
});

test('malformed schedules fail safely without leaking source data', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json({ ...day([row()]), resmsgs: ['private-data'] })));
  const result = await prepare(await connect());
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('private-data');
});

const madridDate = (offsetDays: number) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10);
};

test('booking window opens the configured days before the class at the same gym-local time', () => {
  const now = new Date('2026-11-05T01:18:00Z'); // 02:18 in Madrid
  expect(bookingWindow('2026-11-12', '14:00', 'Europe/Madrid', 7, now)).toEqual({ bookingOpensAt: '2026-11-05T14:00', bookingOpen: false });
  expect(bookingWindow('2026-11-12', '02:00', 'Europe/Madrid', 7, now)).toEqual({ bookingOpensAt: '2026-11-05T02:00', bookingOpen: true });
  expect(bookingWindow('2026-11-11', '14:00', 'Europe/Madrid', 7, now)).toMatchObject({ bookingOpen: true });
  expect(bookingWindow('2026-11-12', '14:00', 'Europe/Madrid', 7, new Date('2026-11-05T13:00:00Z'))).toMatchObject({ bookingOpen: true });
});

test('returns not-yet-open without a reference or write when the configured window is closed', async () => {
  const date = madridDate(10);
  const client = await connect({ AIMHARDER_BOOKING_WINDOW_DAYS: '{"sample-gym":7}' });
  const result = await prepare(client, { date });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ status: 'not-yet-open', bookingOpensAt: `${madridDate(3)}T10:00`, currentState: 'unbooked' });
  expect(result.structuredContent).not.toHaveProperty('actionReference');
  expect(requests.filter(({ pathname }) => pathname === '/aplic/apiExternal/book')).toEqual([]);
});

test('prepares normally inside the configured window and without a configured window', async () => {
  const inside = await prepare(await connect({ AIMHARDER_BOOKING_WINDOW_DAYS: '{"sample-gym":7}' }), { date: madridDate(3) });
  expect(inside.structuredContent).toMatchObject({ status: 'ready' });
  const unconfigured = await prepare(await connect(), { date: madridDate(10) });
  expect(unconfigured.structuredContent).toMatchObject({ status: 'ready' });
});

test('rejects an invalid booking window configuration at startup', async () => {
  for (const value of ['{"sample-gym":0}', '{"sample-gym":7.5}', '[7]', 'seven']) {
    await expect(connect({ AIMHARDER_BOOKING_WINDOW_DAYS: value })).rejects.toMatchObject({ code: 'INVALID_BOOKING_WINDOW_CONFIGURATION' });
  }
});

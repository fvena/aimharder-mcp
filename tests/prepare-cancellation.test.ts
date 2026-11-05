import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { appBase, appLogin } from './support/app-api.js';
import { insideCancellationWindow, BookingPreparationStore, type BookingCancellationPreview } from '../src/booking-preparation.js';

const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];
const requests: { method: string; path: string; search: string }[] = [];
let rows: unknown[];
const row = (extra: Record<string, unknown> = {}) => ({
  id: 501, idres: 900, classId: 10, className: 'Open Box', time: '10:00 - 11:00',
  ocupation: 8, limit: 20, enabled: 1, bookState: 1, cancelledId: null,
  resadmin: 0, ...extra,
});
const day = () => ({ clasesDisp: 'Classes', day: 'Source label', bookings: rows, timetable: [], seminars: [] });

beforeAll(() => upstream.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  requests.length = 0; rows = [row()];
  upstream.use(
    appLogin(),
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({ data: { userData: { id: 42 }, auth: { authOK: true } } },
      { headers: { 'Set-Cookie': 'amhrdrauth=synthetic; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [
      { role: 'client', boid: 200, gym: 'Sample Gym', centre_url: 'sample-gym.aimharder.es' },
    ] }] })),
    http.get(`${appBase}/bookings`, () => HttpResponse.json(day())),
  );
});
upstream.events.on('request:start', ({ request }) => {
  const url = new URL(request.url);
  requests.push({ method: request.method, path: url.pathname, search: url.search });
});
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  upstream.resetHandlers(); vi.useRealTimers();
});
afterAll(() => upstream.close());

async function connect(extra: Record<string, string | undefined> = {}) {
  const server = createServer({ AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic',
    AIMHARDER_GYM_TIME_ZONES: '{"sample-gym":"Europe/Madrid"}', ...extra });
  const client = new Client({ name: 'cancellation-preparation-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
async function prepare(client: Client, extra: Record<string, unknown> = {}) {
  return client.callTool({ name: 'prepare_booking_cancellation', arguments: {
    date: '2026-09-26', className: 'Open Box', startTime: '10:00', endTime: '11:00', ...extra,
  } });
}

test('prepares exactly one account-scoped cancellation from the daily reservation without a write', async () => {
  const result = await prepare(await connect());
  expect(result.structuredContent).toMatchObject({ action: 'cancel', status: 'ready', currentState: 'booked',
    gym: { id: 'sample-gym', timeZoneStatus: 'user-confirmed' }, credit: { balance: null, entitlementPeriod: null },
    actionReference: expect.any(String), expiresAt: expect.any(String) });
  expect(JSON.stringify(result)).not.toMatch(/idres|reservationId|sourceId|familyId|boxId|accountId/);
  expect(requests.map(({ method, path }) => [method, path])).toEqual([
    ['POST', '/api/login'], ['GET', '/api/whoami'], ['GET', '/aplic/apiExternal/login'], ['GET', '/aplic/apiExternal/bookings'],
  ]);
  const search = new URLSearchParams(requests[3]!.search);
  expect([search.get('box'), search.get('day')]).toEqual(['200', '20260926']);
});

test('ambiguous, missing, cancelled, waitlisted, and unsupported rows have no executable reference', async () => {
  const client = await connect();
  for (const [candidateRows, status] of [
    [[], 'missing'], [[row(), row({ id: 502, idres: 901 })], 'ambiguous'],
    [[row({ cancelledId: 7, idres: null })], 'already-cancelled'],
    [[row({ bookState: 0 })], 'unsupported'], [[row({ bookState: null, idres: null })], 'unsupported'],
    [[row({ idres: undefined })], 'unsupported'], [[row({ enabled: 0 })], 'unsupported'],
    [[row({ hidden: 1 })], 'unsupported'],
  ] as const) {
    rows = [...candidateRows];
    const result = await prepare(client);
    expect(result.structuredContent).toMatchObject({ status });
    expect(result.structuredContent).not.toHaveProperty('actionReference');
  }
  expect(requests.filter(({ path }) => path === '/api/cancelBook')).toHaveLength(0);
});

test('unconfirmed zone, inaccessible gym and arbitrary selectors fail without a schedule query', async () => {
  expect((await prepare(await connect({ AIMHARDER_GYM_TIME_ZONES: undefined }))).isError).toBe(true);
  expect((await prepare(await connect(), { gymId: 'other-gym' })).isError).toBe(true);
  expect((await prepare(await connect(), { reservationId: 900 })).isError).toBe(true);
  expect((await prepare(await connect(), { familyId: 1 })).isError).toBe(true);
  expect(requests.some(({ path }) => path === '/api/bookings')).toBe(false);
});

test('the configured cancellation window warning starts at its wall-clock boundary', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(day())));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T06:30:00Z')); // 08:30 in Madrid
  const result = await prepare(await connect({ AIMHARDER_CANCELLATION_WINDOW_MINUTES: '{"sample-gym":90}' }));
  expect(result.structuredContent).toMatchObject({ status: 'ready', credit: { balance: null } });
  expect(JSON.stringify(result.structuredContent)).toContain('90-minute');
  expect(insideCancellationWindow('2026-09-26', '10:00', 'Europe/Madrid', 90, new Date('2026-09-26T06:29:00Z'))).toBe(false);
  expect(insideCancellationWindow('2026-09-26', '10:00', 'Europe/Madrid', 90, new Date('2026-09-26T06:30:00Z'))).toBe(true);
  expect(insideCancellationWindow('2026-09-26', '10:00', 'Europe/Madrid', 90, new Date('2026-09-26T06:31:00Z'))).toBe(true);
  // The spring jump skips 02:00–02:59 local; elapsed time is shorter than wall time.
  expect(insideCancellationWindow('2026-03-29', '03:00', 'Europe/Madrid', 90, new Date('2026-03-28T23:29:00Z'))).toBe(false);
  expect(insideCancellationWindow('2026-03-29', '03:00', 'Europe/Madrid', 90, new Date('2026-03-28T23:30:00Z'))).toBe(true);
  expect(insideCancellationWindow('2026-03-29', '03:00', 'Europe/Madrid', 90, new Date('2026-03-29T00:30:00Z'))).toBe(true);
});

test('gym-local midnight and DST wall times preserve exact labels without inventing UTC instants', async () => {
  rows = [row({ time: '02:30 - 03:30' })];
  const client = await connect();
  for (const date of ['2026-03-29', '2026-10-25']) {
    const result = await prepare(client, { date, startTime: '02:30', endTime: '03:30' });
    expect(result.structuredContent).toMatchObject({ status: 'ready', target: { date, startTime: '02:30', endTime: '03:30' } });
    expect(JSON.stringify(result)).not.toMatch(/utcOffset|startsAt/);
  }
  expect(insideCancellationWindow('2026-09-26', '00:30', 'Europe/Madrid', 90, new Date('2026-09-25T21:30:00Z'))).toBe(true);
});

test('malformed source data fails safely without leaking source text', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json({ ...day(), resmsgs: ['private source text'] })));
  const result = await prepare(await connect());
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private source text');
  expect(requests.filter(({ path }) => path === '/api/cancelBook')).toHaveLength(0);
});

test('cancellation reference is bound to action, account, gym and expiry', () => {
  const store = new BookingPreparationStore();
  const preview: BookingCancellationPreview = { action: 'cancel', gym: { id: 'sample-gym', name: 'Sample Gym', timeZone: 'Europe/Madrid', timeZoneStatus: 'user-confirmed' },
    target: { className: 'Open Box', date: '2026-09-26', startTime: '10:00', endTime: '11:00' },
    currentState: 'booked', credit: { possibleLoss: 'Unknown', balance: null, entitlementPeriod: null }, notices: [] };
  const first = store.issueCancellation(42, 200, 900, preview);
  preview.target.className = 'Changed';
  expect(store.take(first.actionReference, 'cancel', 42, 'sample-gym')).toMatchObject({ reservationId: 900, preview: { target: { className: 'Open Box' } } });
  expect(store.take(first.actionReference, 'cancel', 42, 'sample-gym')).toBeNull();
  const second = store.issueCancellation(42, 200, 900, preview);
  expect(store.take(second.actionReference, 'create', 42, 'sample-gym')).toBeNull();
  const third = store.issueCancellation(42, 200, 900, preview);
  expect(store.take(third.actionReference, 'cancel', 43, 'sample-gym')).toBeNull();
  const fourth = store.issueCancellation(42, 200, 900, preview);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 120_001);
  expect(store.take(fourth.actionReference, 'cancel', 42, 'sample-gym')).toBeNull();
});

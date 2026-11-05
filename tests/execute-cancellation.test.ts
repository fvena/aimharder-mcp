import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { appBase, appLogin } from './support/app-api.js';

const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];
let reservationId: number | null;
let sourceSessionId: number;
let bookState: number | null;
let cancelledId: number | null;
let duplicate = false;
let missing = false;
let upcomingState: number | null;
let writes: string[];
let response: () => Response;
let scheduleReads: number;

const row = (id = sourceSessionId, idres = reservationId) => ({ id, idres, classId: 10, className: 'Open Box', time: '10:00 - 11:00',
  ocupation: 8, limit: 20, enabled: 1, bookState, cancelledId, resadmin: 0 });
const day = () => ({ clasesDisp: 'Classes', day: 'Source label', bookings: missing ? [] : duplicate ? [row(), row(502, 901)] : [row()], timetable: [], seminars: [] });
const upcoming = () => ({ nextClasses: upcomingState === null ? [] : [{ id: 777, day: 'Sábado, 26 de Septiembre de 2026',
  time: '10:00 - 11:00', className: 'Open Box', bookState: upcomingState }], history: [] });

beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  reservationId = 900; sourceSessionId = 501; bookState = 1; cancelledId = null; duplicate = false; missing = false; upcomingState = 1; writes = []; scheduleReads = 0;
  response = () => { bookState = null; cancelledId = 900; upcomingState = null; return HttpResponse.json({ cancelState: 1 }); };
  upstream.use(
    appLogin(),
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({ data: { userData: { id: 42 }, auth: { authOK: true } } },
      { headers: { 'Set-Cookie': 'amhrdrauth=synthetic; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [
      { role: 'client', boid: 200, gym: 'Sample Gym', centre_url: 'sample-gym.aimharder.es' },
    ] }] })),
    http.get(`${appBase}/bookings`, () => { scheduleReads++; return HttpResponse.json(day()); }),
    http.get(`${appBase}/nextBookings`, () => HttpResponse.json(upcoming())),
    http.post(`${appBase}/cancelBook`, async ({ request }) => {
      writes.push(await request.text()); return response();
    }),
  );
});
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  upstream.resetHandlers(); vi.useRealTimers();
});
afterAll(() => upstream.close());

async function connect(gymId = 'sample-gym', requireConfirmation = true, extra: Record<string, string> = {}) {
  const server = createServer({ AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic',
    AIMHARDER_REQUIRE_BOOKING_CONFIRMATION: String(requireConfirmation), AIMHARDER_GYM_TIME_ZONES: JSON.stringify({ [gymId]: 'Europe/Madrid' }), ...extra });
  const client = new Client({ name: 'cancellation-execution-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
async function prepare(client: Client) {
  const result = await client.callTool({ name: 'prepare_booking_cancellation', arguments: {
    date: '2026-09-26', className: 'Open Box', startTime: '10:00', endTime: '11:00',
  } });
  return (result.structuredContent as { actionReference: string }).actionReference;
}
async function execute(client: Client, actionReference: string, extra: Record<string, unknown> = {}) {
  return client.callTool({ name: 'execute_booking_cancellation', arguments: { actionReference, confirmed: true, ...extra } });
}
async function executeLate(client: Client, actionReference: string, extra: Record<string, unknown> = {}) {
  return client.callTool({ name: 'execute_late_booking_cancellation', arguments: { actionReference, confirmedCreditLoss: true, ...extra } });
}

test('one confirmed cancellation uses the schedule reservation and fresh reads', async () => {
  const client = await connect();
  const reference = await prepare(client);
  const result = await execute(client, reference);
  expect(result.structuredContent).toMatchObject({ status: 'confirmed', observedState: 'cancelled', target: { className: 'Open Box' },
    credit: { balance: null, entitlementPeriod: null } });
  expect(writes).toHaveLength(1);
  expect(Object.fromEntries([...new URLSearchParams(writes[0])].filter(([key]) => key !== 'token'))).toEqual({ showClasesDisp: '0', id: '900', late: '0' });
  expect(new URLSearchParams(writes[0]).get('token')).toMatch(/^42\|/);
  expect(scheduleReads).toBe(3);
  expect(JSON.stringify(result)).not.toMatch(/idres|reservationId|sourceId|familyId|accountId|boxId|refunded/i);
  expect((await execute(client, reference)).isError).toBe(true);
  expect(writes).toHaveLength(1);
});

test('confirmation, selectors, expiry, changed reservation and ambiguity block writes', async () => {
  const client = await connect();
  let reference = await prepare(client);
  expect((await execute(client, reference, { confirmed: false })).isError).toBe(true);
  expect((await execute(client, reference, { familyId: 42 })).isError).toBe(true);
  expect((await execute(client, reference, { gymId: 'other-gym' })).isError).toBe(true);
  reservationId = 901;
  expect((await execute(client, reference)).structuredContent).toMatchObject({ status: 'stale' });
  reservationId = 900;
  reference = await prepare(client);
  duplicate = true;
  expect((await execute(client, reference)).structuredContent).toMatchObject({ status: 'stale' });
  duplicate = false;
  reference = await prepare(client);
  cancelledId = 900;
  expect((await execute(client, reference)).structuredContent).toMatchObject({ status: 'stale' });
  cancelledId = null;
  reference = await prepare(client);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 120_001);
  expect((await execute(client, reference)).isError).toBe(true);
  expect(writes).toHaveLength(0);
});

test('late credit warning remains pending with one standard write', async () => {
  response = () => HttpResponse.json({ cancelState: 2, errorMssg: 'private warning' });
  const client = await connect();
  const result = await execute(client, await prepare(client));
  expect(result.structuredContent).toMatchObject({ status: 'pending-credit-loss', observedState: 'booked' });
  expect(JSON.stringify(result)).not.toContain('private warning');
  expect(writes).toHaveLength(1);
  expect(new URLSearchParams(writes[0]).get('late')).toBe('0');
});

test('denial with unchanged reservation is rejected; conflicting views remain uncertain', async () => {
  response = () => HttpResponse.json({ cancelState: 3, errorMssg: 'private denial' });
  const client = await connect();
  expect((await execute(client, await prepare(client))).structuredContent).toMatchObject({ status: 'rejected', observedState: 'booked' });
  response = () => { bookState = null; cancelledId = 900; return HttpResponse.json({ cancelState: 1 }); };
  expect((await execute(client, await prepare(client))).structuredContent).toMatchObject({ status: 'uncertain' });
  expect(writes).toHaveLength(2);
});

test('a cancelled row for another reservation cannot confirm the attempted cancellation', async () => {
  response = () => { reservationId = 901; bookState = null; cancelledId = 901; upcomingState = null; return HttpResponse.json({ cancelState: 1 }); };
  const client = await connect();
  const result = await execute(client, await prepare(client));
  expect(result.structuredContent).toMatchObject({ status: 'uncertain', observedState: 'unknown' });
  expect(writes).toHaveLength(1);
});

test('a successful response and the same released session confirm when the source removes the reservation ID', async () => {
  response = () => { reservationId = null; bookState = null; cancelledId = null; upcomingState = null; return HttpResponse.json({ cancelState: 1 }); };
  const client = await connect();
  const result = await execute(client, await prepare(client));
  expect(result.structuredContent).toMatchObject({ status: 'confirmed', observedState: 'unbooked' });
  expect(writes).toHaveLength(1);
});

test('a different session or an upcoming booking cannot confirm a released reservation', async () => {
  const client = await connect();
  response = () => { sourceSessionId = 502; reservationId = null; bookState = null; upcomingState = null; return HttpResponse.json({ cancelState: 1 }); };
  expect((await execute(client, await prepare(client))).structuredContent).toMatchObject({ status: 'uncertain' });
  sourceSessionId = 501; reservationId = 900; bookState = 1; upcomingState = 1;
  response = () => { reservationId = null; bookState = null; return HttpResponse.json({ cancelState: 1 }); };
  expect((await execute(client, await prepare(client))).structuredContent).toMatchObject({ status: 'uncertain' });
  expect(writes).toHaveLength(2);
});

test('crossing the configured cancellation window after preparation requires a new warning', async () => {
  upstream.use(
    http.get(`${appBase}/bookings`, () => HttpResponse.json(day())),
    http.post(`${appBase}/cancelBook`, async ({ request }) => {
      writes.push(await request.text()); return response();
    }),
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T06:29:00Z'));
  const client = await connect('sample-gym', true, { AIMHARDER_CANCELLATION_WINDOW_MINUTES: '{"sample-gym":90}' });
  const reference = await prepare(client);
  vi.setSystemTime(new Date('2026-09-26T06:30:00Z'));
  expect((await execute(client, reference)).structuredContent).toMatchObject({ status: 'stale', observedState: 'booked' });
  expect(writes).toHaveLength(0);
  const newPreview = await client.callTool({ name: 'prepare_booking_cancellation', arguments: {
    date: '2026-09-26', className: 'Open Box', startTime: '10:00', endTime: '11:00',
  } });
  expect(JSON.stringify(newPreview.structuredContent)).toContain('90-minute cancellation window');
});

test.each(['unsupported', 'transport', 'authentication'] as const)('%s write outcome is uncertain with no replay', async (mode) => {
  response = () => mode === 'unsupported' ? HttpResponse.json({ other: 'private value' })
    : mode === 'authentication' ? new HttpResponse(null, { status: 401 }) : HttpResponse.error();
  const client = await connect();
  const result = await execute(client, await prepare(client));
  expect(result.structuredContent).toMatchObject({ status: 'uncertain' });
  expect(JSON.stringify(result)).not.toContain('private value');
  expect(writes).toHaveLength(1);
});

test('a fresh warning offers a separate late reference; refusing it sends no late write', async () => {
  response = () => HttpResponse.json({ cancelState: 2 });
  const client = await connect();
  const result = await execute(client, await prepare(client));
  expect(result.structuredContent).toMatchObject({ status: 'pending-credit-loss', observedState: 'booked',
    actionReference: expect.any(String), expiresAt: expect.any(String), target: { className: 'Open Box' } });
  expect(JSON.stringify(result)).toMatch(/credit loss/i);
  const reference = (result.structuredContent as { actionReference: string }).actionReference;
  expect((await executeLate(client, reference, { confirmedCreditLoss: false })).isError).toBe(true);
  expect((await executeLate(client, reference, { familyId: 42 })).isError).toBe(true);
  expect(writes).toHaveLength(1);
});

test('a changed, missing, cancelled, or ambiguous warning target stops before the late write', async () => {
  response = () => HttpResponse.json({ cancelState: 2 });
  const client = await connect();
  for (const change of [() => { reservationId = 901; }, () => { missing = true; }, () => { cancelledId = 900; }, () => { duplicate = true; }]) {
    reservationId = 900; cancelledId = null; duplicate = false; missing = false;
    const warned = await execute(client, await prepare(client));
    const reference = (warned.structuredContent as { actionReference: string }).actionReference;
    change();
    expect((await executeLate(client, reference)).structuredContent).toMatchObject({ status: 'stale' });
  }
  expect(writes).toHaveLength(4);
});

test('a warning with a changed or uncertain refreshed reservation offers no late reference', async () => {
  response = () => { reservationId = 901; return HttpResponse.json({ cancelState: 2 }); };
  const client = await connect();
  const result = await execute(client, await prepare(client));
  expect(result.structuredContent).toMatchObject({ status: 'uncertain' });
  expect(result.structuredContent).not.toHaveProperty('actionReference');
  expect(writes).toHaveLength(1);
});

test('an expired second reference cannot send a late request', async () => {
  response = () => HttpResponse.json({ cancelState: 2 });
  const client = await connect();
  const warned = await execute(client, await prepare(client));
  const reference = (warned.structuredContent as { actionReference: string }).actionReference;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 120_001);
  expect((await executeLate(client, reference)).isError).toBe(true);
  expect(writes).toHaveLength(1);
});

test.each([true, false])('confirmation policy %s covers standard and late cancellation with separate references', async requireConfirmation => {
  response = () => writes.length === 1 ? HttpResponse.json({ cancelState: 2 })
    : (bookState = null, cancelledId = 900, upcomingState = null, HttpResponse.json({ cancelState: 1 }));
  const client = await connect('sample-gym', requireConfirmation);
  const warned = await execute(client, await prepare(client), {});
  const reference = (warned.structuredContent as { actionReference: string }).actionReference;
  const result = await executeLate(client, reference, {});
  expect(result.structuredContent).toMatchObject({ status: 'confirmed', observedState: 'cancelled', credit: { balance: null } });
  expect(writes).toHaveLength(2);
  expect(writes.map(body => new URLSearchParams(body).get('late'))).toEqual(['0', '1']);
  expect((await executeLate(client, reference)).isError).toBe(true);
  expect(writes).toHaveLength(2);
  expect(JSON.stringify(result)).not.toMatch(/refunded|reservationId|idres/i);
});

test.each(['denied', 'timeout'] as const)('a %s late attempt is reconciled without another write', async (mode) => {
  response = () => writes.length === 1 ? HttpResponse.json({ cancelState: 2 })
    : mode === 'denied' ? HttpResponse.json({ cancelState: 3 }) : HttpResponse.error();
  const client = await connect();
  const warned = await execute(client, await prepare(client));
  const result = await executeLate(client, (warned.structuredContent as { actionReference: string }).actionReference);
  expect(result.structuredContent).toMatchObject({ status: mode === 'denied' ? 'rejected' : 'uncertain' });
  expect(writes).toHaveLength(2);
});

test('a repeated late warning remains uncertain rather than being called a denial', async () => {
  response = () => HttpResponse.json({ cancelState: 2 });
  const client = await connect();
  const warned = await execute(client, await prepare(client));
  const result = await executeLate(client, (warned.structuredContent as { actionReference: string }).actionReference);
  expect(result.structuredContent).toMatchObject({ status: 'uncertain', observedState: 'booked' });
  expect(result.structuredContent).not.toHaveProperty('actionReference');
  expect(writes).toHaveLength(2);
});

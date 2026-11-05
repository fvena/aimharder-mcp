import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { appBase, appLogin } from './support/app-api.js';

const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];
let scheduleReads = 0;
let writeCount = 0;
let sourceState: number | null = null;
let response: () => Response;
let upcomingState: number | null = null;
let changed = false;
let requestBody = '';
const row = () => ({ id: changed ? 502 : 501, classId: 10, className: 'Open Box', time: '10:00 - 11:00',
  ocupation: 8, limit: 20, enabled: 1, bookState: sourceState, cancelledId: null, resadmin: 0 });
const day = () => ({ clasesDisp: 'Classes', day: 'Source label', bookings: [row()], timetable: [], seminars: [] });
const upcoming = () => ({ nextClasses: upcomingState === null ? [] : [{ id: 900, day: 'Sábado, 26 de Septiembre de 2026',
  time: '10:00 - 11:00', className: 'Open Box', bookState: upcomingState }], history: [] });

beforeAll(() => upstream.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  scheduleReads = 0; writeCount = 0; sourceState = null; upcomingState = null; changed = false; requestBody = '';
  response = () => { sourceState = 1; upcomingState = 1; return HttpResponse.json({ bookState: 1 }); };
  upstream.use(
    appLogin(),
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({ data: { userData: { id: 42 }, auth: { authOK: true } } },
      { headers: { 'Set-Cookie': 'amhrdrauth=synthetic; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [
      { role: 'client', boid: 200, gym: 'Sample Gym', centre_url: 'sample-gym.aimharder.es' },
    ] }] })),
    http.get(`${appBase}/bookings`, () => { scheduleReads++; return HttpResponse.json(day()); }),
    http.get(`${appBase}/nextBookings`, () => HttpResponse.json(upcoming())),
    http.post(`${appBase}/book`, async ({ request }) => {
      writeCount++; requestBody = await request.text(); return response();
    }),
  );
});
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  upstream.resetHandlers(); vi.useRealTimers();
});
afterAll(() => upstream.close());

async function connect(requireConfirmation = true) {
  const server = createServer({ AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic',
    AIMHARDER_GYM_TIME_ZONES: '{"sample-gym":"Europe/Madrid"}', AIMHARDER_REQUIRE_BOOKING_CONFIRMATION: String(requireConfirmation) });
  const client = new Client({ name: 'booking-execution-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
async function prepare(client: Client) {
  const result = await client.callTool({ name: 'prepare_booking_creation', arguments: {
    date: '2026-09-26', className: 'Open Box', startTime: '10:00', endTime: '11:00',
  } });
  return (result.structuredContent as { actionReference: string }).actionReference;
}
async function execute(client: Client, actionReference: string, extra: Record<string, unknown> = {}) {
  return client.callTool({ name: 'execute_booking_creation', arguments: { actionReference, confirmed: true, ...extra } });
}

test.each([true, false])('booking confirmation policy %s preserves one write and fresh read-back', async requireConfirmation => {
  const client = await connect(requireConfirmation);
  const reference = await prepare(client);
  const result = await execute(client, reference, requireConfirmation ? {} : { confirmed: undefined });
  expect(result.structuredContent).toMatchObject({ status: 'confirmed', observedState: 'booked', target: { className: 'Open Box' } });
  expect(writeCount).toBe(1);
  expect(scheduleReads).toBe(3);
  expect(new URLSearchParams(requestBody).get('id')).toBe('501');
  expect(new URLSearchParams(requestBody).get('day')).toBe('20260926');
  expect(requestBody).not.toMatch(/family|box/i);
  expect(new URLSearchParams(requestBody).get('insist')).toBe('0');
  expect(new URLSearchParams(requestBody).get('token')).toMatch(/^42\|/);
  expect(JSON.stringify(result)).not.toMatch(/sourceId|accountId|boxId|credit/i);
  expect((await execute(client, reference)).isError).toBe(true);
  expect(writeCount).toBe(1);
});

test('default confirmation policy blocks omission without consuming the reference', async () => {
  const client = await connect();
  const reference = await prepare(client);
  expect((await execute(client, reference, { confirmed: undefined })).isError).toBe(true);
  expect(writeCount).toBe(0);
  expect((await execute(client, reference)).structuredContent).toMatchObject({ status: 'confirmed' });
});

test('an explicit false marker, selectors and changed targets block a write', async () => {
  const client = await connect();
  const reference = await prepare(client);
  expect((await execute(client, reference, { confirmed: false })).isError).toBe(true);
  expect((await execute(client, reference, { familyId: 1 })).isError).toBe(true);
  expect((await execute(client, reference, { gymId: 'other-gym' })).isError).toBe(true);
  changed = true;
  expect((await execute(client, reference)).structuredContent).toMatchObject({ status: 'stale' });
  expect(writeCount).toBe(0);
});

test('an expired public action reference cannot send a write', async () => {
  const client = await connect();
  const reference = await prepare(client);
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now + 120_001);
  expect((await execute(client, reference)).isError).toBe(true);
  expect(writeCount).toBe(0);
  vi.useRealTimers();
});

test('an already booked target prevents a duplicate write', async () => {
  const client = await connect();
  const reference = await prepare(client);
  sourceState = 1;
  expect((await execute(client, reference)).structuredContent).toMatchObject({ status: 'stale', observedState: 'booked' });
  expect(writeCount).toBe(0);
});

test('an existing upcoming entry blocks a duplicate even when the daily row still looks free', async () => {
  const client = await connect();
  const reference = await prepare(client);
  upcomingState = 1;
  expect((await execute(client, reference)).structuredContent).toMatchObject({ status: 'stale' });
  expect(writeCount).toBe(0);
});

test('an existing waitlist entry also blocks a second booking attempt', async () => {
  const client = await connect();
  const reference = await prepare(client);
  upcomingState = 0;
  expect((await execute(client, reference)).structuredContent).toMatchObject({ status: 'stale' });
  expect(writeCount).toBe(0);
});

test('explicit denial and unchanged fresh state are reported as rejected', async () => {
  response = () => HttpResponse.json({ bookState: -2, errorMssg: 'private source message' });
  const client = await connect();
  const result = await execute(client, await prepare(client));
  expect(result.structuredContent).toMatchObject({ status: 'rejected', observedState: 'unbooked' });
  expect(JSON.stringify(result)).not.toContain('private source message');
  expect(writeCount).toBe(1);
});

test('malformed or lost responses reconcile without another write', async () => {
  response = () => new HttpResponse('malformed', { status: 200 });
  const client = await connect();
  const result = await execute(client, await prepare(client));
  expect(result.structuredContent).toMatchObject({ status: 'uncertain' });
  expect(JSON.stringify(result)).not.toMatch(/credit/i);
  expect(writeCount).toBe(1);
});

test.each(['unauthorized', 'connection-lost'] as const)('a %s write outcome is reconciled without replay', async (mode) => {
  response = () => mode === 'unauthorized' ? new HttpResponse(null, { status: 401 }) : HttpResponse.error();
  const client = await connect();
  expect((await execute(client, await prepare(client))).structuredContent).toMatchObject({ status: 'uncertain' });
  expect(writeCount).toBe(1);
});

test('an unreadable follow-up view cannot establish a confirmed result', async () => {
  upstream.use(http.get(`${appBase}/nextBookings`, () =>
    HttpResponse.json(writeCount ? { secret: 'private view' } : upcoming())));
  const client = await connect();
  const result = await execute(client, await prepare(client));
  expect(result.structuredContent).toMatchObject({ status: 'uncertain', observedState: 'booked' });
  expect(JSON.stringify(result)).not.toContain('private view');
  expect(writeCount).toBe(1);
});

test('a source denial conflicting with a booked follow-up remains uncertain', async () => {
  response = () => { sourceState = 1; upcomingState = 1; return HttpResponse.json({ bookState: -2 }); };
  const client = await connect();
  expect((await execute(client, await prepare(client))).structuredContent).toMatchObject({ status: 'uncertain', observedState: 'booked' });
  expect(writeCount).toBe(1);
});

test('waitlist and conflicting follow-up views remain distinct and trigger no retry', async () => {
  response = () => { sourceState = 0; upcomingState = 0; return HttpResponse.json({ bookState: 0 }); };
  const client = await connect();
  expect((await execute(client, await prepare(client))).structuredContent).toMatchObject({ status: 'waitlisted' });
  expect(writeCount).toBe(1);
  sourceState = null; upcomingState = null;
  response = () => { sourceState = 1; upcomingState = 0; return HttpResponse.json({ bookState: 1 }); };
  expect((await execute(client, await prepare(client))).structuredContent).toMatchObject({ status: 'uncertain' });
  expect(writeCount).toBe(2);
});

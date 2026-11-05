import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { appBase, appLogin } from './support/app-api.js';

const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];
const requests: { method: string; url: URL }[] = [];
const membership = (slug = 'sample-gym', boid = 200) => ({
  id: 100, boid, role: 'client', gym: 'Gimnasio Ñ', centre_url: `${slug}.aimharder.es`,
});
beforeAll(() => upstream.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  requests.length = 0;
  upstream.use(
    appLogin(),
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({
      data: { userData: { id: 42 }, auth: { authOK: true } },
    }, { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership()] }] })),
    http.get(`${appBase}/nextBookings`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('token')).toMatch(/^42\|/);
      expect(new URL(request.url).searchParams.get('box')).toBe('200');
      return HttpResponse.json({ nextClasses: [booking()], history: [] });
    }),
  );
});
upstream.events.on('request:start', ({ request }) => requests.push({ method: request.method, url: new URL(request.url) }));
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  upstream.resetHandlers();
});
afterAll(() => upstream.close());
async function connect(extra: Record<string, string | undefined> = {}) {
  const server = createServer({
    AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic-password',
    AIMHARDER_GYM_TIME_ZONES: '{"sample-gym":"Europe/Madrid"}', ...extra,
  });
  const client = new Client({ name: 'booking-behavioral-harness', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
async function query(client: Client, args: Record<string, unknown> = {}) {
  return client.callTool({ name: 'get_upcoming_bookings', arguments: args });
}
const bookingRequests = () => requests.filter((r) => r.url.pathname === '/aplic/apiExternal/nextBookings');


const booking = (extra: Record<string, unknown> = {}) => ({
  id: 9001, day: 'Miércoles, 23 de Septiembre de 2026', time: '07:00 - 08:00',
  className: 'Metcon Ñ', bookState: 1, coachName: 'Private Coach', boxDir: 'Private address', ...extra,
});
function respond(rows: unknown[], extra = {}) {
  upstream.use(http.get(`${appBase}/nextBookings`, () => HttpResponse.json({ nextClasses: rows, history: [{ private: 'private-history' }], ...extra })));
}
test('returns one reservation with local times without inventing a class-session identifier', async () => {
  const result = await query(await connect());
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    coverage: { status: 'complete', scope: 'upstream-upcoming-view', startDate: null, endDate: null },
    bookingStatus: 'booked', bookings: [{ sourceBookingId: 9001, sessionId: null,
      date: '2026-09-23', startTime: '07:00', timeZone: 'Europe/Madrid',
      classType: { id: null, name: 'Metcon Ñ' }, state: 'booked', sourceState: 1 }],
  });
  expect(JSON.stringify(result)).not.toMatch(/Private Coach|Private address|private-history|attendanceCount/);
});
test('a valid empty view establishes no bookings only within that view', async () => {
  respond([]);
  expect((await query(await connect())).structuredContent).toMatchObject({ bookings: [], bookingStatus: 'none', coverage: { status: 'complete' } });
});
test('preserves multiple reservations and distinguishes waitlist and unknown states', async () => {
  respond([booking(), booking({ id: 9002, bookState: 0 }), booking({ id: 9003, bookState: 99 })]);
  expect((await query(await connect())).structuredContent).toMatchObject({ bookingStatus: 'booked', bookings: [
    { state: 'booked' }, { state: 'waitlisted' }, { state: 'unknown', sourceState: 99 },
  ] });
});
test.each([99, null, undefined])('does not infer no booking from unverified state %s', async (bookState) => {
  respond([booking({ bookState })]);
  expect((await query(await connect())).structuredContent).toMatchObject({ bookingStatus: 'unknown', bookings: [{ state: 'unknown' }] });
});
test('waitlist alone is not a confirmed reservation', async () => {
  respond([booking({ bookState: 0 })]);
  expect((await query(await connect())).structuredContent).toMatchObject({ bookingStatus: 'none', bookings: [{ state: 'waitlisted' }] });
});
test.each([{ nextPage: 2 }, { hasMore: true }, { resmsgs: ['private restriction'] }])('rejects incomplete or restricted coverage: %j', async (extra) => {
  respond([], extra); const result = await query(await connect());
  expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('private restriction');
});
test.each([
  [booking({ day: 'Wednesday, 23 September 2026' })], [booking({ day: 'Jueves, 23 de Septiembre de 2026' })],
  [booking({ time: '25:00 - 26:00' })], [booking({ id: null })], [booking(), booking()],
  [booking({ bookState: '1' })], [booking({ className: '' })],
].map((rows) => [rows] as const))('fails safely on malformed or unsupported records %#', async (rows) => {
  respond(rows);expect((await query(await connect())).isError).toBe(true);
});
test.each([403, 429, 500])('lookup failure is not no bookings: %s', async (status) => {
  upstream.use(http.get(`${appBase}/nextBookings`, () => new HttpResponse(null, { status })));
  const result = await query(await connect());expect(result.isError).toBe(true);expect(result.structuredContent).toBeUndefined();
});
test('uses the assumed gym zone when no override is configured', async () => {
  expect((await query(await connect({ AIMHARDER_GYM_TIME_ZONES: undefined }))).structuredContent).toMatchObject({ gym: { timeZone: 'Europe/Madrid', timeZoneStatus: 'assumed' } });
  expect(bookingRequests()).toHaveLength(1);
});
test('rejects unknown gyms and account selectors', async () => {
  const client = await connect();
  expect((await query(client, { gymId: 'foreign' })).isError).toBe(true);
  expect((await query(client, { familyId: 5 })).isError).toBe(true);
  expect(bookingRequests()).toHaveLength(0);
});
test('recovers once and rechecks membership', async () => {
  let calls = 0;
  upstream.use(http.get(`${appBase}/nextBookings`, () => ++calls === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json({ nextClasses: [booking()], history: [] })));
  expect((await query(await connect())).isError).not.toBe(true);
  expect(calls).toBe(2); expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/login')).toHaveLength(2); expect(requests.filter(r => r.url.pathname === '/api/login')).toHaveLength(1);
});

test('missing optional class details remain explicitly unknown', async () => {
  respond([booking({ className: undefined })]);
  expect((await query(await connect())).structuredContent).toMatchObject({ bookings: [{ classType: { id: null, name: null } }] });
});
test('default and explicit gyms route only through their verified membership', async () => {
  upstream.use(http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership(), membership('second-gym', 300)] }] })),
    http.get(`${appBase}/nextBookings`, ({ request }) => {
      const box = new URL(request.url).searchParams.get('box');
      return HttpResponse.json({ nextClasses: [booking({ id: box === '300' ? 9002 : 9001 })], history: [] });
    }));
  const client = await connect({ AIMHARDER_DEFAULT_GYM: 'sample-gym', AIMHARDER_GYM_TIME_ZONES: '{"sample-gym":"Europe/Madrid","second-gym":"Atlantic/Canary"}' });
  expect((await query(client)).structuredContent).toMatchObject({ gym: { id: 'sample-gym' }, bookings: [{ sourceBookingId: 9001 }] });
  expect((await query(client, { gymId: 'second-gym' })).structuredContent).toMatchObject({ gym: { id: 'second-gym' }, bookings: [{ sourceBookingId: 9002, timeZone: 'Atlantic/Canary' }] });
  expect((await query(client)).structuredContent).toMatchObject({ gym: { id: 'sample-gym' } });
  expect(bookingRequests().every(r => r.method === 'GET' && [...r.url.searchParams.keys()].sort().join() === 'box,token')).toBe(true);
  expect(bookingRequests().map(r => r.url.searchParams.get('box'))).toEqual(['200', '300', '200']);
});
test('exhausted recovery stops after two attempts', async () => {
  upstream.use(http.get(`${appBase}/nextBookings`, () => new HttpResponse(null, { status: 401 })));
  const result = await query(await connect());
  expect(JSON.stringify(result)).toContain('SESSION_EXPIRED');expect(bookingRequests()).toHaveLength(2);
});
test('a repeatedly expired app session stops after one app re-login', async () => {
  upstream.use(http.get(`${appBase}/nextBookings`, () => new HttpResponse(null, { status: 401 })));
  expect(JSON.stringify(await query(await connect(), { gymId: 'sample-gym' }))).toContain('SESSION_EXPIRED');
  expect(bookingRequests()).toHaveLength(2);
  expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/login')).toHaveLength(2);
});
test('membership removed before a query prevents the booking request', async () => {
  upstream.use(http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership('second-gym', 300)] }] })));
  expect(JSON.stringify(await query(await connect(), { gymId: 'sample-gym' }))).toContain('GYM_NOT_ACCESSIBLE');
  expect(bookingRequests()).toHaveLength(0);
});
test('identity mismatch prevents booking lookup', async () => {
  upstream.use(http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 99, roles: [membership()] }] })));
  expect(JSON.stringify(await query(await connect()))).toContain('IDENTITY_MISMATCH');expect(bookingRequests()).toHaveLength(0);
});
test.each([
  ['Domingo, 29 de Marzo de 2026', '2026-03-29'], ['Domingo, 25 de Octubre de 2026', '2026-10-25'],
  ['Martes, 29 de Febrero de 2028', '2028-02-29'], ['Viernes, 1 de Enero de 2027', '2027-01-01'],
])('preserves calendar dates and wall times across DST and date boundaries: %s', async (day, date) => {
  respond([booking({ day, time: '02:30 - 03:30' })]);
  expect((await query(await connect())).structuredContent).toMatchObject({ bookings: [{ date, startTime: '02:30', timeZone: 'Europe/Madrid' }] });
});
test.each([
  {}, { nextClasses: [] }, { nextClasses: null, history: [] }, { nextClasses: [], history: [], error: 'private-upstream-error' },
])('invalid envelopes never claim no bookings %#', async (body) => {
  upstream.use(http.get(`${appBase}/nextBookings`, () => HttpResponse.json(body)));
  const result = await query(await connect());expect(result.isError).toBe(true);expect(result.structuredContent).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('private-upstream-error');
});

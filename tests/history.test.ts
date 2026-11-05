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
      return HttpResponse.json({ nextClasses: [], history: [booking({ assist: 1, lateCancel: 0 })] });
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
  return client.callTool({ name: 'get_booking_history', arguments: args });
}
const bookingRequests = () => requests.filter((r) => r.url.pathname === '/aplic/apiExternal/nextBookings');


const booking = (extra: Record<string, unknown> = {}) => ({
  id: 9001, day: 'Miércoles, 23 de Septiembre de 2026', time: '07:00 - 08:00',
  className: 'Metcon Ñ', bookState: 1, coachName: 'Private Coach', boxDir: 'Private address', ...extra,
});
function respond(rows: unknown[], extra = {}) {
  upstream.use(http.get(`${appBase}/nextBookings`, () => HttpResponse.json({ nextClasses: [], history: rows, ...extra })));
}
test('returns chronological history and verified source labels without attendance claims', async () => {
  respond([booking({ id: 3, assist: 1, lateCancel: 1 }), booking({ id: 1, day: 'Martes, 22 de Septiembre de 2026', assist: 1, lateCancel: 0 })]);
  const result = await query(await connect());
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ coverage: { status: 'limited', retrieval: 'complete', scope: 'upstream-history-view', startDate: null, endDate: null }, bookings: [
    { sourceBookingId: 3, state: 'late-cancelled', attendance: 'unverified', sourceFlags: { assist: 1, lateCancel: 1 } },
    { sourceBookingId: 1, state: 'booked', date: '2026-09-22', timeZone: 'Europe/Madrid' },
  ] });
  expect(JSON.stringify(result)).not.toMatch(/Private Coach|Private address/);
});
test('empty source view is limited history, never complete empty lifetime history', async () => {
  respond([]); expect((await query(await connect())).structuredContent).toMatchObject({ bookings: [], coverage: { status: 'limited', retrieval: 'complete' } });
});
test('deduplicates identical rows and preserves recovered records on conflicting or malformed rows', async () => {
  respond([booking(), booking(), booking({ id: 2 }), booking({ id: 2, time: '08:00 - 09:00' }), { id: 9 }]);
  expect((await query(await connect())).structuredContent).toMatchObject({ bookings: [{ sourceBookingId: 9001 }], coverage: { retrieval: 'partial' } });
});
test('unknown flags never establish attendance or verified state', async () => {
  respond([booking({ lateCancel: 99, assist: 1 }), booking({ id: 2, bookState: 99 })]);
  const result = await query(await connect());
  expect(result.structuredContent).toMatchObject({ bookings: [{ sourceBookingId: 2, state: 'unknown', attendance: 'unverified' }, { sourceBookingId: 9001, state: 'unknown' }] });
});
test.each([403, 429, 500])('access failure %s is an error', async status => {
  upstream.use(http.get(`${appBase}/nextBookings`, () => new HttpResponse(null, { status })));
  expect((await query(await connect())).isError).toBe(true);
});
test('rejects unknown pagination instead of asserting coverage', async () => {
  respond([], { nextPage: 2 }); expect((await query(await connect())).isError).toBe(true);
});
test('uses an assumed timezone and rejects foreign gym and family selectors', async () => {
  expect((await query(await connect({ AIMHARDER_GYM_TIME_ZONES: undefined }))).structuredContent).toMatchObject({ gym: { timeZone: 'Europe/Madrid', timeZoneStatus: 'assumed' } });
  const client = await connect();
  expect((await query(client, { gymId: 'foreign' })).isError).toBe(true);
  expect((await query(client, { familyId: 2 })).isError).toBe(true);
  expect(bookingRequests()).toHaveLength(1);
});

test('does not retain a valid identity when another row with that identity is malformed', async () => {
  respond([booking(), booking({ time: 'invalid' }), booking({ id: 2 })]);
  expect((await query(await connect())).structuredContent).toMatchObject({ bookings: [{ sourceBookingId: 2 }], coverage: { retrieval: 'partial' } });
});
test('a wholly malformed nonempty view is an error', async () => {
  respond([{ id: 1 }]); expect((await query(await connect())).isError).toBe(true);
});

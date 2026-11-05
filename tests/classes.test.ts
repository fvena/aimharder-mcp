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
const session = (extra: Record<string, unknown> = {}) => ({
  id: 501, time: '07:00 - 08:00', timeid: '0700_60', classId: 10, className: 'Metcon',
  ocupation: 8, limit: 20, limitc: 20, enabled: 1, bookState: null,
  coachName: 'Sample Coach', zoomJoinPw: 'private-password', ...extra,
});
const daily = (bookings: unknown[] = [session()]) => ({
  clasesDisp: 'Clases disponibles', day: 'Source date label', bookings,
  timetable: [{ id: '0700_60', time: '07:00 - 08:00' }], seminars: [],
});
beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  requests.length = 0;
  upstream.use(
    appLogin(),
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({
      data: { userData: { id: 42 }, auth: { authOK: true } },
    }, { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership()] }] })),
    http.get(`${appBase}/bookings`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('token')).toMatch(/^42\|/);
      expect(new URL(request.url).searchParams.get('box')).toBe('200');
      return HttpResponse.json(daily());
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
  const client = new Client({ name: 'class-behavioral-harness', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
async function query(client: Client, args: Record<string, unknown> = {}) {
  return client.callTool({ name: 'get_class_sessions', arguments: { startDate: '2026-09-23', endDate: '2026-09-23', ...args } });
}
const classRequests = () => requests.filter((r) => r.url.pathname === '/aplic/apiExternal/bookings');

test('returns a complete inclusive week, preserving distinguishable sessions and source names', async () => {
  upstream.use(http.get(`${appBase}/bookings`, ({ request }) => {
    const day = new URL(request.url).searchParams.get('day');
    return HttpResponse.json(daily(day === '20260927' ? [] : [session(), session({ id: 502, classId: 11, className: 'Open Box', ocupation: 0 }), session({ id: 503, time: '19:00 - 20:00' })]));
  }));
  const result = await query(await connect(), { startDate: '2026-09-21', endDate: '2026-09-27' });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    gym: { id: 'sample-gym', timeZone: 'Europe/Madrid', timeZoneStatus: 'user-confirmed' },
    startDate: '2026-09-21', endDate: '2026-09-27', coverage: 'complete',
    sessions: expect.arrayContaining([{ sessionId: 'sample-gym:2026-09-23:501', sourceId: 501,
      date: '2026-09-23', startTime: '07:00', timeLabel: '07:00 - 08:00', timeZone: 'Europe/Madrid',
      classType: { id: 10, name: 'Metcon' }, occupancy: 8, capacity: 20, coach: 'Sample Coach' }]),
  });
  expect((result.structuredContent as { sessions: unknown[] }).sessions).toHaveLength(18);
  expect(classRequests().map((r) => r.url.searchParams.get('day'))).toEqual(['20260921','20260922','20260923','20260924','20260925','20260926','20260927']);
  expect(JSON.stringify(result)).not.toMatch(/private-password|bookState|attendanceCount|bookable/);
});

test('filters a specific start time and exact class name without choosing among matching sessions', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(daily([
    session(), session({ id: 502 }), session({ id: 503, className: 'Open Box' }), session({ id: 504, time: '19:00 - 20:00' }),
  ]))));
  const result = await query(await connect(), { startTime: '07:00', className: 'Metcon' });
  expect(result.isError).not.toBe(true);
  expect((result.structuredContent as { sessions: { sourceId: number }[] }).sessions.map((s) => s.sourceId)).toEqual([501, 502]);
});

test('distinguishes missing optional counts from zero and keeps the source name unchanged', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(daily([
    session({ ocupation: undefined, limit: null, className: '  Movilidad Ñ  ' }), session({ id: 502, ocupation: 0, limit: 0 }),
  ]))));
  const result = await query(await connect());
  expect(result.structuredContent).toMatchObject({ sessions: [
    { occupancy: null, capacity: null, classType: { name: '  Movilidad Ñ  ' } }, { occupancy: 0, capacity: 0 },
  ] });
});

test.each([
  ['2026-03-28', '2026-03-30', ['20260328','20260329','20260330']],
  ['2026-10-24', '2026-10-26', ['20261024','20261025','20261026']],
  ['2028-02-28', '2028-03-01', ['20280228','20280229','20280301']],
  ['2026-12-31', '2027-01-01', ['20261231','20270101']],
])('uses calendar dates across boundaries, including DST: %s to %s', async (startDate, endDate, days) => {
  const result = await query(await connect(), { startDate, endDate });
  expect(result.isError).not.toBe(true);
  expect(classRequests().map((r) => r.url.searchParams.get('day'))).toEqual(days);
  expect(result.structuredContent).toMatchObject({ gym: { timeZone: 'Europe/Madrid' } });
});

test.each([
  { startDate: '2026-02-29' }, { endDate: '2026-09-22' }, { startDate: '2026-09-23T00:00:00Z' },
  { startTime: '24:00' }, { className: '' }, { extra: true }, { gymId: 'https://evil.invalid' },
])('rejects invalid dates, filters and arguments before network access: %j', async (args) => {
  expect((await query(await connect(), args)).isError).toBe(true);
  expect(requests).toHaveLength(0);
});

test('uses an explicit assumed Europe/Madrid zone when none is configured', async () => {
  const result = await query(await connect({ AIMHARDER_GYM_TIME_ZONES: undefined }));
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ gym: { timeZone: 'Europe/Madrid', timeZoneStatus: 'assumed' }, sessions: [{ timeZone: 'Europe/Madrid' }] });
  expect(classRequests()).toHaveLength(1);
});

test('returns successful empty schedules only after a valid response', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json({ ...daily([]), resmsgs: [] })));
  expect((await query(await connect())).structuredContent).toMatchObject({ sessions: [], coverage: 'complete' });
});

test('reads capacity from the bracketed capacity label', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(daily([session({ ocupation: 16, limit: '16 (6)', limitc: 16 })]))));
  const result = await query(await connect());
  expect(result.isError).not.toBe(true);
  expect((result.structuredContent as { sessions: { occupancy: number; capacity: number }[] }).sessions.map(s => [s.occupancy, s.capacity])).toEqual([[16, 16]]);
});

test.each([
  {}, { bookings: null }, { bookings: [] , error: 'private-upstream-error' },
  { ...daily([]), resmsgs: ['restriction'] }, { ...daily([]), nextPage: 2 },
  daily([session({ ocupation: -1 })]), daily([session({ limit: '20' })]), daily([session({ limit: '16 (x)' })]), daily([session({ limit: '16(1)' })]),
  daily([session({ time: '25:00 - 26:00' })]), daily([session({ className: '' })]),
  daily([session(), session()]), daily([session({ id: null })]),
])('rejects malformed, restricted or unknown coverage responses: %#', async (body) => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(body)));
  const result = await query(await connect());
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private-upstream-error');
  expect(result.structuredContent).toBeUndefined();
});

test.each([403,429,500])('a failed later day does not become a complete or empty schedule: HTTP %s', async (status) => {
  upstream.use(http.get(`${appBase}/bookings`, ({ request }) =>
    new URL(request.url).searchParams.get('day') === '20260924' ? new HttpResponse(null, { status }) : HttpResponse.json(daily())));
  const result = await query(await connect(), { endDate: '2026-09-25' });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(classRequests()).toHaveLength(2);
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
});

test('selects another verified gym with its own box and confirmed zone, then returns to the default', async () => {
  upstream.use(
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership(), membership('second-gym', 300)] }] })),
    http.get(`${appBase}/bookings`, () => HttpResponse.json(daily())),
  );
  const client = await connect({ AIMHARDER_DEFAULT_GYM: 'sample-gym', AIMHARDER_GYM_TIME_ZONES: '{"sample-gym":"Europe/Madrid","second-gym":"America/New_York","unverified-gym":"UTC"}' });
  expect((await query(client, { gymId: 'second-gym' })).structuredContent).toMatchObject({ gym: { id: 'second-gym', timeZone: 'America/New_York' }, sessions: [{ timeZone: 'America/New_York' }] });
  expect((await query(client)).structuredContent).toMatchObject({ gym: { id: 'sample-gym', timeZone: 'Europe/Madrid' } });
  expect((await query(client, { gymId: 'unverified-gym' })).isError).toBe(true);
  expect(classRequests().map((r) => r.url.searchParams.get('box'))).toEqual(['300', '200']);
});

test('rechecks membership before every interval and never sends credentials to a gym', async () => {
  const client = await connect();
  await query(client);
  upstream.use(http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership('second-gym',300)] }] })));
  expect((await query(client, { gymId: 'sample-gym' })).isError).toBe(true);
  expect(classRequests()).toHaveLength(1);
  expect(requests.filter((r) => r.method === 'POST').map((r) => r.url.hostname)).toEqual(['login.aimharder.es']);
});

test('missing or conflicting numeric gym identifiers cannot select an arbitrary box', async () => {
  for (const roles of [[{ ...membership(), boid: undefined }], [membership(), membership('sample-gym', 999)]]) {
    upstream.use(http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles }] })));
    expect((await query(await connect())).isError).toBe(true);
  }
  expect(classRequests()).toHaveLength(0);
});

test('recovers one expired class query and refreshes gym access before retrying the interval', async () => {
  let calls = 0;
  upstream.use(http.get(`${appBase}/bookings`, () => ++calls === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json(daily())));
  expect((await query(await connect())).isError).not.toBe(true);
  expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/login')).toHaveLength(2);
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  expect(classRequests()).toHaveLength(2);
});

test('a day that stays expired after one app re-login fails the whole interval', async () => {
  upstream.use(
    http.get(`${appBase}/bookings`, ({ request }) => new URL(request.url).searchParams.get('day') === '20260924' ? new HttpResponse(null, { status: 401 }) : HttpResponse.json(daily())),
  );
  const result = await query(await connect(), { endDate: '2026-09-25' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('SESSION_EXPIRED');
  expect(result.structuredContent).toBeUndefined();
  expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/login')).toHaveLength(2);
  expect(classRequests().map(r => r.url.searchParams.get('day'))).toEqual(['20260923', '20260924', '20260924']);
});

test('stops a repeatedly expired class query after one retry', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => new HttpResponse(null, { status: 401 })));
  const result = await query(await connect());
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('SESSION_EXPIRED');
  expect(classRequests()).toHaveLength(2);
  expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/login')).toHaveLength(2);
});

test('serializes concurrent class and context queries through one session', async () => {
  const client = await connect();
  const results = await Promise.all([query(client), client.callTool({ name: 'get_account_context', arguments: {} }), query(client)]);
  expect(results.every((r) => r.isError !== true)).toBe(true);
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
});

test.each([
  new HttpResponse(null, { status: 302, headers: { Location: 'https://evil.invalid/collect' } }),
  new HttpResponse('<html>private-password</html>'),
  HttpResponse.error(),
])('rejects class redirects and transport failures with safe errors: %#', async (response) => {
  upstream.use(http.get(`${appBase}/bookings`, () => response));
  const result = await query(await connect());
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private-password');
  expect(requests.some((r) => r.url.hostname === 'evil.invalid')).toBe(false);
  expect(classRequests()).toHaveLength(1);
});

test.each(['{', '[]', '{"sample-gym":"Invalid/Zone"}', '{"sample-gym":null}', '{"https://evil.invalid":"Europe/Madrid"}', '{"sample-gym":"+01:00"}'])('rejects invalid time-zone configuration: %s', async (configuration) => {
  await expect(connect({ AIMHARDER_GYM_TIME_ZONES: configuration })).rejects.toThrow('IANA time zones');
  expect(requests).toHaveLength(0);
});

test('does not infer an instant for repeated or nonexistent DST wall times', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(daily([
    session({ time: '02:30 - 03:30' }), session({ id: 502, time: '02:30 - 03:30' }),
  ]))));
  for (const date of ['2026-03-29', '2026-10-25']) {
    const result = await query(await connect(), { startDate: date, endDate: date });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ sessions: [
      { date, startTime: '02:30', timeZone: 'Europe/Madrid' }, { date, startTime: '02:30', timeZone: 'Europe/Madrid' },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/2026-.*T02:30|utcOffset|startsAt/);
  }
});

test('a legitimate gym ID matching an object property uses the default rather than inheriting a mapping', async () => {
  upstream.use(http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership('constructor')] }] })));
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(daily())));
  const result = await query(await connect({ AIMHARDER_GYM_TIME_ZONES: '{}' }));
  expect(result.structuredContent).toMatchObject({ gym: { id: 'constructor', timeZone: 'Europe/Madrid', timeZoneStatus: 'assumed' } });
  expect(classRequests()).toHaveLength(1);
});

test('annotates sessions with the configured booking window only when configured', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(daily([session()]))));
  const configured = await query(await connect({ AIMHARDER_BOOKING_WINDOW_DAYS: '{"sample-gym":7}' }), { startDate: '2099-01-10', endDate: '2099-01-10' });
  const sessions = (configured.structuredContent as { sessions: Record<string, unknown>[] }).sessions;
  expect(sessions[0]).toMatchObject({ bookingOpensAt: `2099-01-03T${String(sessions[0]!.startTime)}`, bookingOpen: false });
  const plain = await query(await connect(), { startDate: '2099-01-10', endDate: '2099-01-10' });
  expect((plain.structuredContent as { sessions: Record<string, unknown>[] }).sessions[0]).not.toHaveProperty('bookingOpen');
});

test('reports the source coach name, or null when none is assigned', async () => {
  upstream.use(http.get(`${appBase}/bookings`, () => HttpResponse.json(daily([
    session(), session({ id: 502, coachName: null }), session({ id: 503, coachName: '   ' }), session({ id: 504, coachName: undefined }),
  ]))));
  const result = await query(await connect());
  expect((result.structuredContent as { sessions: { coach: string | null }[] }).sessions.map(s => s.coach)).toEqual(['Sample Coach', null, null, null]);
});

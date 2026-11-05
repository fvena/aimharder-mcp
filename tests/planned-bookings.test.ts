import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { appBase, appLogin } from './support/app-api.js';

const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];
const requests: { method: string; pathname: string; day: string | null }[] = [];
const plan = { 'sample-gym': { mon: { className: 'CROSS', startTime: '07:00' }, wed: { className: 'FUNCIONAL', startTime: '19:00' }, fri: { className: 'CROSS', startTime: '07:00' } } };
const row = (id: number, className: string, time: string, bookState: number | null = null) => ({
  id, classId: 10, className, time, ocupation: 8, limit: 20, enabled: 1, bookState, cancelledId: null, resadmin: 0, hidden: 0,
});
// Synthetic schedules by YYYYMMDD: Monday has the planned class, Wednesday's is already booked, Friday has none at 07:00.
let schedules: Record<string, unknown[]> = {};

beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  requests.length = 0;
  schedules = {
    '20261109': [row(601, 'CROSS', '07:00 - 08:00'), row(602, 'HYROX', '07:00 - 08:00')],
    '20261111': [row(603, 'FUNCIONAL', '19:00 - 20:00', 1)],
    '20261113': [row(604, 'CROSS', '08:00 - 09:00')],
  };
  upstream.use(
    appLogin(),
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({ data: { userData: { id: 42 }, auth: { authOK: true } } },
      { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [
      { role: 'client', boid: 200, gym: 'Sample Gym', centre_url: 'sample-gym.aimharder.es' },
    ] }] })),
    http.get(`${appBase}/bookings`, ({ request }) => HttpResponse.json({ clasesDisp: 'Classes', day: 'Source label',
      bookings: schedules[new URL(request.url).searchParams.get('day')!] ?? [], timetable: [], seminars: [] })),
    http.get(`${appBase}/nextBookings`, () => HttpResponse.json({ nextClasses: [], history: [] })),
    http.post(`${appBase}/book`, () => {
      schedules['20261109'] = [row(601, 'CROSS', '07:00 - 08:00', 1), row(602, 'HYROX', '07:00 - 08:00')];
      return HttpResponse.json({ bookState: 1 });
    }),
  );
});
upstream.events.on('request:start', ({ request }) => {
  const url = new URL(request.url);
  requests.push({ method: request.method, pathname: url.pathname, day: url.searchParams.get('day') });
});
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  upstream.resetHandlers(); vi.useRealTimers();
});
afterAll(() => upstream.close());

async function connect(extra: Record<string, string | undefined> = {}) {
  const server = createServer({ AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic-password',
    AIMHARDER_GYM_TIME_ZONES: '{"sample-gym":"Europe/Madrid"}', AIMHARDER_BOOKING_PLAN: JSON.stringify(plan), ...extra });
  const client = new Client({ name: 'planned-bookings-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
const nextWeek = { startDate: '2026-11-09', endDate: '2026-11-15' };
type Planned = { days: { date: string; weekday: string; status: string; target?: { endTime: string | null }; actionReference?: string; bookingOpensAt?: string }[]; notices: string[]; writeConfirmationRequired: boolean };
const appWrites = () => requests.filter(({ method, pathname }) => method === 'POST' && pathname.startsWith('/aplic/'));

test('previews the weekly plan day by day, reading only planned days and sending no write', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-05T08:00:00Z'));
  const client = await connect();
  const result = await client.callTool({ name: 'prepare_planned_bookings', arguments: nextWeek });
  expect(result.isError).not.toBe(true);
  const content = result.structuredContent as Planned;
  expect(content.days.map(day => [day.date, day.weekday, day.status])).toEqual([
    ['2026-11-09', 'mon', 'ready'], ['2026-11-10', 'tue', 'not-planned'], ['2026-11-11', 'wed', 'already-booked'],
    ['2026-11-12', 'thu', 'not-planned'], ['2026-11-13', 'fri', 'missing'], ['2026-11-14', 'sat', 'not-planned'], ['2026-11-15', 'sun', 'not-planned'],
  ]);
  expect(content.days[0]).toMatchObject({ target: { className: 'CROSS', startTime: '07:00', endTime: '08:00' }, actionReference: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(content.days.filter(day => day.actionReference)).toHaveLength(1);
  expect(content.writeConfirmationRequired).toBe(true);
  expect(requests.filter(({ pathname }) => pathname.endsWith('/bookings')).map(({ day }) => day)).toEqual(['20261109', '20261111', '20261113']);
  expect(appWrites()).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/sourceId|accountId|boxId/);
});

test('a planned day is booked through execute_booking_creation with its own reference', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-05T08:00:00Z'));
  const client = await connect();
  const content = (await client.callTool({ name: 'prepare_planned_bookings', arguments: nextWeek })).structuredContent as Planned;
  const result = await client.callTool({ name: 'execute_booking_creation', arguments: { actionReference: content.days[0]!.actionReference, confirmed: true } });
  expect(result.structuredContent).toMatchObject({ status: 'confirmed', target: { className: 'CROSS', date: '2026-11-09', startTime: '07:00', endTime: '08:00' } });
  expect(appWrites().map(({ pathname }) => pathname)).toEqual(['/aplic/apiExternal/book']);
});

test('reports not-yet-open days under the configured booking window without a reference', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-05T08:00:00Z'));
  const client = await connect({ AIMHARDER_BOOKING_WINDOW_DAYS: '{"sample-gym":2}' });
  const content = (await client.callTool({ name: 'prepare_planned_bookings', arguments: nextWeek })).structuredContent as Planned;
  expect(content.days[0]).toMatchObject({ status: 'not-yet-open', bookingOpensAt: '2026-11-07T07:00' });
  expect(content.days[0]!.actionReference).toBeUndefined();
});

test('without a plan every day is not-planned and no schedule is read', async () => {
  const client = await connect({ AIMHARDER_BOOKING_PLAN: undefined });
  const content = (await client.callTool({ name: 'prepare_planned_bookings', arguments: nextWeek })).structuredContent as Planned;
  expect(new Set(content.days.map(day => day.status))).toEqual(new Set(['not-planned']));
  expect(content.notices[0]).toContain('No booking plan is configured');
  expect(requests.filter(({ pathname }) => pathname.endsWith('/bookings'))).toEqual([]);
});

test('rejects invalid plans and ranges', async () => {
  for (const value of ['{"sample-gym":{"monday":{"className":"CROSS","startTime":"07:00"}}}', '{"sample-gym":{"mon":{"className":"CROSS","startTime":"7:00"}}}', 'not json']) {
    expect(() => createServer({ AIMHARDER_USERNAME: 'a', AIMHARDER_PASSWORD: 'b', AIMHARDER_BOOKING_PLAN: value })).toThrow();
  }
  const client = await connect();
  for (const args of [{ startDate: '2026-11-15', endDate: '2026-11-09' }, { startDate: '2026-11-01', endDate: '2026-11-15' }]) {
    expect((await client.callTool({ name: 'prepare_planned_bookings', arguments: args })).isError).toBe(true);
  }
});

test('account context reports the configured defaults for the selected gym', async () => {
  const client = await connect({ AIMHARDER_WORKOUT_CLASS: '{"sample-gym":"CROSS"}', AIMHARDER_PARTICIPANTS_FILTER: 'following' });
  const result = await client.callTool({ name: 'get_account_context', arguments: {} });
  expect(result.structuredContent).toMatchObject({ defaults: { workoutClass: 'CROSS', participantsFilter: 'following', bookingPlan: plan['sample-gym'] } });
  expect(client.getInstructions()).toContain('prepare_planned_bookings');
});

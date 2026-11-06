import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { appBase, appLogin } from './support/app-api.js';

const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];
const requests: URL[] = [];
const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const recordDate = (date: string) => `${Number(date.slice(8))} de ${months[Number(date.slice(5, 7)) - 1]} de ${date.slice(0, 4)}`;
// Synthetic day-workout lists by YYYYMMDD, and the intended date of each workout ID.
let days: Record<string, { id: number; wodClass?: string }[]> = {};
let detailDates = new Map<number, string>();

beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  requests.length = 0;
  days = {
    '20261105': [{ id: 14, wodClass: 'CROSS' }, { id: 24, wodClass: 'HYROX' }],
    '20261106': [{ id: 15, wodClass: 'CROSS' }, { id: 25, wodClass: 'FUNCTIONAL' }],
    '20261107': [{ id: 17, wodClass: 'CROSS' }, { id: 18, wodClass: 'CROSS' }],
  };
  detailDates = new Map([[14, '2026-11-05'], [15, '2026-11-06'], [17, '2026-11-07'], [18, '2026-11-07']]);
  upstream.use(
    appLogin(),
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({ data: { userData: { id: 42 }, auth: { authOK: true } } },
      { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [{ id: 100, boid: 200, role: 'client', gym: 'Sample Gym', centre_url: 'sample-gym.aimharder.es' }] }] })),
    http.get(`${appBase}/bookingwod`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect([params.get('userID'), params.get('timeLineContent')]).toEqual(['300', '7']);
      return HttpResponse.json({ elements: days[params.get('filterDay')!] ?? [] });
    }),
    http.get(`${appBase}/activity/workout`, ({ request }) => {
      const id = Number(new URL(request.url).searchParams.get('SEID'));
      return HttpResponse.json({ recordDate: recordDate(detailDates.get(id)!), publishDate: null, ejerRate: [], TIPOWODs: [{ notes: `Workout ${id}`, deleted: false }] });
    }),
  );
});
upstream.events.on('request:start', ({ request }) => requests.push(new URL(request.url)));
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  upstream.resetHandlers();
});
afterAll(() => upstream.close());

async function range(args: Record<string, unknown>) {
  const server = createServer({ AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic-password', AIMHARDER_TIME_ZONE: 'Europe/Madrid' });
  const client = new Client({ name: 'range-harness', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client.callTool({ name: 'get_published_workouts_range', arguments: { className: 'CROSS', ...args } });
}
type RangeResult = {
  days: { date: string; status: string; ambiguous: boolean; workouts: { provenance: { sourceId: number } }[] }[];
  classNamesInRange: string[]; coverage: { status: string; daysRead: number; scope: string };
};
const appCalls = (path: string) => requests.filter(url => url.pathname === `/aplic/apiExternal/${path}`);

test('reads one day-workout list per date and details only for the requested class', async () => {
  const result = await range({ from: '2026-11-05', to: '2026-11-08' });
  expect(result.isError).not.toBe(true);
  const content = result.structuredContent as RangeResult;
  expect(content.days.map(day => [day.date, day.status, day.ambiguous, day.workouts.map(w => w.provenance.sourceId)])).toEqual([
    ['2026-11-05', 'available', false, [14]], ['2026-11-06', 'available', false, [15]], ['2026-11-07', 'available', true, [17, 18]], ['2026-11-08', 'unavailable', false, []],
  ]);
  expect(appCalls('bookingwod').map(url => url.searchParams.get('filterDay'))).toEqual(['20261105', '20261106', '20261107', '20261108']);
  expect(appCalls('activity/workout').map(url => Number(url.searchParams.get('SEID'))).sort()).toEqual([14, 15, 17, 18]);
  expect(content.classNamesInRange).toEqual(['CROSS', 'FUNCTIONAL', 'HYROX']);
  expect(content.coverage).toMatchObject({ status: 'complete', scope: 'upstream-day-workouts', daysRead: 4 });
});

test('the detail recordDate decides the day, not the list it came from', async () => {
  detailDates.set(15, '2026-11-01');
  const content = (await range({ from: '2026-11-06', to: '2026-11-06' })).structuredContent as RangeResult;
  expect(content.days).toMatchObject([{ date: '2026-11-06', status: 'unavailable', workouts: [] }]);
});

test('a malformed day-workout list is a retrieval error, not an unavailable day', async () => {
  upstream.use(http.get(`${appBase}/bookingwod`, () => HttpResponse.json({ elements: [], nextPage: 2 })));
  const result = await range({ from: '2026-11-05', to: '2026-11-05' });
  expect(result.isError).toBe(true);
});

test('rejects reversed or overlong ranges before any upstream request', async () => {
  for (const args of [{ from: '2026-11-08', to: '2026-11-05' }, { from: '2026-11-01', to: '2026-11-15' }]) {
    const result = await range(args);
    expect(result.isError).toBe(true);
  }
  expect(requests).toEqual([]);
});

async function call(name: string, args: Record<string, unknown>, extra: Record<string, string> = {}) {
  const server = createServer({ AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic-password', AIMHARDER_TIME_ZONE: 'Europe/Madrid', ...extra });
  const client = new Client({ name: 'workout-class-harness', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client.callTool({ name, arguments: args });
}
const configured = { AIMHARDER_WORKOUT_CLASS: 'CROSS' };

test('without className the configured workout class applies, and the day lists every published class', async () => {
  const result = await call('get_published_workouts', { date: '2026-11-05' }, configured);
  expect(result.structuredContent).toMatchObject({ className: 'CROSS', classSource: 'configured', status: 'available', classNamesAvailable: ['CROSS', 'HYROX'] });
  expect(appCalls('activity/workout').map(url => Number(url.searchParams.get('SEID')))).toEqual([14]);
});

test('a requested className overrides the configured class', async () => {
  detailDates.set(24, '2026-11-05');
  const result = await call('get_published_workouts', { date: '2026-11-05', className: 'HYROX' }, configured);
  expect(result.structuredContent).toMatchObject({ className: 'HYROX', classSource: 'request', status: 'available' });
  expect(appCalls('activity/workout').map(url => Number(url.searchParams.get('SEID')))).toEqual([24]);
});

test('without className or configured class, only the published class names are read', async () => {
  const single = await call('get_published_workouts', { date: '2026-11-05' });
  expect(single.structuredContent).toMatchObject({ className: null, classSource: null, status: 'class-required', workouts: [], classNamesAvailable: ['CROSS', 'HYROX'] });
  const content = (await call('get_published_workouts_range', { from: '2026-11-05', to: '2026-11-06' })).structuredContent as RangeResult & { className: null };
  expect(content.className).toBeNull();
  expect(content.days.map(day => day.status)).toEqual(['class-required', 'class-required']);
  expect(content.classNamesInRange).toEqual(['CROSS', 'FUNCTIONAL', 'HYROX']);
  expect(appCalls('activity/workout')).toEqual([]);
});

test('the range tool uses the configured class too', async () => {
  const content = (await call('get_published_workouts_range', { from: '2026-11-05', to: '2026-11-06' }, configured)).structuredContent as RangeResult & { classSource: string };
  expect(content.classSource).toBe('configured');
  expect(content.days.map(day => day.workouts.map(w => w.provenance.sourceId))).toEqual([[14], [15]]);
});

test('rejects an invalid workout class configuration', () => {
  for (const value of ['', '   ', '{"sample-gym":"CROSS"}', 'x'.repeat(301)]) {
    expect(() => createServer({ AIMHARDER_USERNAME: 'a', AIMHARDER_PASSWORD: 'b', AIMHARDER_WORKOUT_CLASS: value })).toThrow();
  }
});

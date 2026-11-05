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
const older = Date.UTC(2025, 3, 2);
const latest = Date.UTC(2026, 8, 24);
const detail = (extra: Record<string, unknown> = {}) => ({
 id: '101', name: 'Barbell lift', chartUserId: 42, ud: 0,
 chartData1RM: [{ date: older, lbs: '120', idAction: 10 }, { date: latest, lbs: '100.5', idAction: 11 }],
 chartData3RM: [{ date: older, lbs: '90', idAction: 12 }], chartData5RM: [], chartData10RM: [],
 chartDataWOD: [{ date: latest, lbs: '4', idAction: 13 }],
 history: [{ date: older, idAction: 10, desc: '120 kg', record: 1 }, { date: latest, idAction: 11, desc: '100.5 kg', record: null }],
 chartUserName: 'private-name', chartUserPic: 'private-picture', privateProfile: 'private-profile',
 ...extra,
});

beforeAll(() => upstream.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
 requests.length = 0;
 upstream.use(
    appLogin(),
  http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({ data: { userData: { id: 42 }, auth: { authOK: true } } }, { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/' } })),
  http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [{ id: 100, boid: 200, role: 'client', gym: 'Sample Gym', centre_url: 'sample-gym.aimharder.es' }] }] })),
  http.get(`${appBase}/exercise/101/42/:token`, ({ request }) => {
   expect(new URL(request.url).pathname.split('/').at(-1)).toMatch(/^42\|/);
   return HttpResponse.json(detail());
  }),
 );
});
upstream.events.on('request:start', ({ request }) => requests.push({ method: request.method, url: new URL(request.url) }));
afterEach(async () => { for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); } upstream.resetHandlers(); });
afterAll(() => upstream.close());
async function connect(extra: Record<string, string | undefined> = {}) {
 const server = createServer({ AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic-password', AIMHARDER_GYM_TIME_ZONES: '{"sample-gym":"Europe/Madrid"}', ...extra });
 const client = new Client({ name: 'exercise-records-harness', version: '1.0.0' });
 const [a, b] = InMemoryTransport.createLinkedPair();
 connections.push({ client, server }); await server.connect(b); await client.connect(a);
 return client;
}
async function query(client: Client, args: Record<string, unknown> = {}) { return client.callTool({ name: 'get_exercise_1rm', arguments: { exerciseId: 101, ...args } }); }
function respond(body: Record<string, unknown>) { upstream.use(http.get(`${appBase}/exercise/101/42/:token`, () => HttpResponse.json(body))); }

test('returns the latest dated own-account 1RM with a corroborated physical unit and separate WOD context', async () => {
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 expect(result.structuredContent).toMatchObject({
  status: 'available', exercise: { sourceExerciseId: 101, name: 'Barbell lift' },
  latest1RM: { value: '100.5', unit: 'kg', sourceDate: '2026-09-24' },
  otherSeries: { '3RM': 1, '5RM': 0, '10RM': 0, WOD: 1 },
  coverage: { status: 'limited', scope: 'upstream-exercise-detail-view', history: 'unverified' },
 });
 expect(JSON.stringify(result)).not.toMatch(/private-name|private-picture|private-profile|120 kg|100\.5 kg/);
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/')).map(r => r.url.pathname.split('/').slice(0, 6).join('/'))).toEqual(['/aplic/apiExternal/exercise/101/42']);
 expect(requests.every(r => r.url.pathname === '/api/login' ? r.method === 'POST' : r.method === 'GET')).toBe(true);
});

test('reports no 1RM while distinguishing other RM and WOD series', async () => {
 respond(detail({ chartData1RM: [], chartData3RM: [{ date: older, lbs: '90', idAction: 12 }], chartDataWOD: [{ date: latest, lbs: '4', idAction: 13 }], history: [] }));
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'no-1rm', latest1RM: null, otherSeries: { '3RM': 1, WOD: 1 } });
});

test('an empty own-account view with no chart owner does not invent a 1RM', async () => {
 const { chartUserId: _owner, ...body } = detail({ chartData1RM: [], chartData3RM: [], chartDataWOD: [], history: [] });
 respond(body);
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'no-1rm', latest1RM: null, otherSeries: { WOD: 0 } });
});

test('does not assign a physical unit from the field named lbs or the unverified ud code alone', async () => {
 respond(detail({ history: [{ date: older, idAction: 10, desc: '120 kg' }] }));
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'unit-unverified', latest1RM: { value: '100.5', unit: null, sourceDate: '2026-09-24' } });
});

test('conflicting units for the selected source action remain unverified', async () => {
 respond(detail({ history: [{ date: latest, idAction: 11, desc: '100.5 kg and 100.5 lbs' }] }));
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'unit-unverified', latest1RM: { unit: null } });
});

test.each([
 { id: '102' }, { chartUserId: 99 }, { chartUserId: undefined },
 { chartData1RM: [{ date: latest, lbs: 'not-a-load', idAction: 11 }] },
 { chartData1RM: [{ date: latest + 1, lbs: '100', idAction: 11 }] },
 { chartData1RM: [{ date: latest, lbs: '100', idAction: 11 }, { date: latest, lbs: '101', idAction: 12 }] },
 { chartData1RM: Array.from({ length: 1001 }, () => ({ date: latest, lbs: '100', idAction: 11 })) },
 { chartDataWOD: null },
 { chartData3RM: [null] },
 { chartData3RM: [{ date: -1, lbs: '90', idAction: 12 }] },
 { chartData3RM: [{ date: older, lbs: 'invalid', idAction: 12 }] },
 { chartDataWOD: [{ date: -1, idAction: 13 }] },
])('rejects inconsistent identity or malformed exercise series data %o', async extra => {
 respond(detail(extra));
 expect((await query(await connect())).isError).toBe(true);
});

test.each([{ userId: 99 }, { url: 'https://elsewhere.invalid/' }, { exerciseId: '101' }, { exerciseId: 0 }, { exerciseId: Number.MAX_SAFE_INTEGER + 1 }, { gymId: 'other-gym' }])('rejects arbitrary selectors or invalid IDs %o', async args => {
 expect((await query(await connect(), args)).isError).toBe(true);
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(0);
});

test('retries one expired read only after renewing and verifying the same account', async () => {
 let calls = 0;
 upstream.use(http.get(`${appBase}/exercise/101/42/:token`, () => ++calls === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json(detail())));
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'available' });
 expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/login')).toHaveLength(2);
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(2);
});

test('stops after repeated expiry without exposing upstream response', async () => {
 upstream.use(http.get(`${appBase}/exercise/101/42/:token`, () => new HttpResponse(null, { status: 401 })));
 const result = await query(await connect());
 expect(result.isError).toBe(true);
 expect(JSON.stringify(result)).toContain('SESSION_EXPIRED');
 expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/login')).toHaveLength(2);
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(2);
});

test('name search selects one exact candidate using its source ID and the own-account detail route', async () => {
 upstream.use(http.get(`${appBase}/workoutAndEjers`, ({ request }) => {
  const params = new URL(request.url).searchParams;
  expect([...params.entries()].filter(([key]) => key !== 'token')).toEqual([['search', 'Barbell lift'], ['showWODs', '0'], ['byLetter', ''], ['filterType', '0']]);
  return HttpResponse.json({ term: 'Barbell lift', result: [{ id: 102, name: 'Barbell lift variant', type: 0 }, { id: 101, name: 'Barbell lift', type: 0 }] });
 }));
 const result = await (await connect()).callTool({ name: 'find_exercise_1rm', arguments: { name: 'Barbell lift' } });
 expect(result.structuredContent).toMatchObject({ status: 'selected', selected: { exercise: { sourceExerciseId: 101 }, latest1RM: { value: '100.5' } }, coverage: { status: 'limited' } });
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(1);
});

test('ambiguous search returns identities without reading or merging personal records; explicit selection is exact', async () => {
 upstream.use(http.get(`${appBase}/workoutAndEjers`, () => HttpResponse.json({ term: 'lift', result: [{ id: 101, name: 'Barbell lift', type: 0 }, { id: 102, name: 'Dumbbell lift', type: 0 }] })));
 const client = await connect();
 const ambiguous = await client.callTool({ name: 'find_exercise_1rm', arguments: { name: 'lift' } });
 expect(ambiguous.structuredContent).toMatchObject({ status: 'ambiguous', candidates: [{ sourceExerciseId: 101 }, { sourceExerciseId: 102 }], selected: null });
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(0);
 const selected = await client.callTool({ name: 'find_exercise_1rm', arguments: { name: 'lift', exerciseId: 101 } });
 expect(selected.structuredContent).toMatchObject({ status: 'selected', selected: { status: 'available' } });
 const missing = await client.callTool({ name: 'find_exercise_1rm', arguments: { name: 'lift', exerciseId: 999 } });
 expect(missing.structuredContent).toMatchObject({ status: 'selection-not-found', selected: null });
});

test('empty and full search views never claim catalog or record absence', async () => {
 const client = await connect();
 upstream.use(http.get(`${appBase}/workoutAndEjers`, () => HttpResponse.json({ term: 'unknown', result: [] })));
 expect((await client.callTool({ name: 'find_exercise_1rm', arguments: { name: 'unknown' } })).structuredContent).toMatchObject({ status: 'empty-view', coverage: { possibleTruncation: false } });
 upstream.use(http.get(`${appBase}/workoutAndEjers`, () => HttpResponse.json({ term: 'lift', result: Array.from({ length: 20 }, (_, i) => ({ id: i + 200, name: `Lift ${i}`, type: 0 })) })));
 expect((await client.callTool({ name: 'find_exercise_1rm', arguments: { name: 'lift' } })).structuredContent).toMatchObject({ status: 'ambiguous', coverage: { possibleTruncation: true, returnedCount: 20 } });
});

test('unsupported search and unsafe selectors do not query a personal record', async () => {
 const client = await connect();
 upstream.use(http.get(`${appBase}/workoutAndEjers`, () => HttpResponse.json({ term: 'lift', result: [{ id: 101, name: 'Barbell lift', type: 99 }] })));
 expect((await client.callTool({ name: 'find_exercise_1rm', arguments: { name: 'lift' } })).structuredContent).toMatchObject({ status: 'unsupported-view', selected: null });
 for (const arguments_ of [{ name: 'lift', userId: 42 }, { name: 'lift', url: 'https://invalid.example/' }, { name: 'x'.repeat(101) }]) {
  expect((await client.callTool({ name: 'find_exercise_1rm', arguments: arguments_ })).isError).toBe(true);
 }
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(0);
});

test('name search can select a candidate with no 1RM without confusing that with catalog absence', async () => {
 upstream.use(
  http.get(`${appBase}/workoutAndEjers`, () => HttpResponse.json({ term: 'Barbell lift', result: [{ id: 101, name: 'Barbell lift', type: 0 }] })),
  http.get(`${appBase}/exercise/101/42/:token`, () => HttpResponse.json(detail({ chartData1RM: [] }))),
 );
 expect((await (await connect()).callTool({ name: 'find_exercise_1rm', arguments: { name: 'Barbell lift' } })).structuredContent).toMatchObject({ status: 'selected', selected: { status: 'no-1rm' } });
});

test('progression keeps repetition series distinct and only marks source-identified records', async () => {
 const result = await (await connect()).callTool({ name: 'get_exercise_rm_progression', arguments: { exerciseId: 101, includeWod: true } });
 expect(result.structuredContent).toMatchObject({ series: { '1RM': [{ value: '120', newMark: true }, { value: '100.5', newMark: false }], '3RM': [{ value: '90', newMark: false }], '5RM': [], '10RM': [] }, wodContext: [{ sourceValue: '4' }] });
 expect(JSON.stringify(result)).not.toMatch(/private-name|private-picture|private-profile|120 kg|100\.5 kg/);
});

test('progression rejects conflicting markers and malformed dates', async () => {
 const client = await connect();
 respond(detail({ history: [{ date: older, idAction: 10, record: 1 }, { date: older, idAction: 10, record: 3 }] }));
 expect((await client.callTool({ name: 'get_exercise_rm_progression', arguments: { exerciseId: 101 } })).isError).toBe(true);
 respond(detail({ chartData3RM: [{ date: older + 1, lbs: '90', idAction: 12 }] }));
 expect((await client.callTool({ name: 'get_exercise_rm_progression', arguments: { exerciseId: 101 } })).isError).toBe(true);
});

test('duplicate identical source markers identify one point without inventing another mark', async () => {
 respond(detail({ history: [{ date: older, idAction: 10, record: 1 }, { date: older, idAction: 10, record: 1 }] }));
 const result = await (await connect()).callTool({ name: 'get_exercise_rm_progression', arguments: { exerciseId: 101 } });
 expect(result.structuredContent).toMatchObject({ series: { '1RM': [{ newMark: true }, { newMark: false }] } });
});

test('WOD-only detail has empty RM progression and optional separate context', async () => {
 respond(detail({ chartData1RM: [], chartData3RM: [], chartData5RM: [], chartData10RM: [], history: [] }));
 const client = await connect();
 const progression = await client.callTool({ name: 'get_exercise_rm_progression', arguments: { exerciseId: 101, includeWod: true } });
 expect(progression.structuredContent).toMatchObject({ series: { '1RM': [], '3RM': [], '5RM': [], '10RM': [] }, wodContext: [{ sourceValue: '4' }] });
 const withoutWod = await client.callTool({ name: 'get_exercise_rm_progression', arguments: { exerciseId: 101 } });
 expect(JSON.stringify(withoutWod.structuredContent)).not.toContain('wodContext');
});

test('progression rejects arbitrary member selectors before personal reads', async () => {
 const result = await (await connect()).callTool({ name: 'get_exercise_rm_progression', arguments: { exerciseId: 101, userId: 99 } });
 expect(result.isError).toBe(true);
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(0);
});

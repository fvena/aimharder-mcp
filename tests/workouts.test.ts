import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { appBase, appLogin, appToken } from './support/app-api.js';

const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];
const requests: { method: string; url: URL }[] = [];
const membership = (slug = 'sample-gym', boid = 200) => ({
  id: 100, boid, role: 'client', gym: 'Gimnasio Ñ', centre_url: `${slug}.aimharder.es`,
});
beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  requests.length = 0;
  upstream.use(
    appLogin(),
    http.get('https://sample-gym.aimharder.es/', () => HttpResponse.text('timeLineContent: 7, userID: 300')) ,
    http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail())),
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({
      data: { userData: { id: 42 }, auth: { authOK: true } },
    }, { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership()] }] })),
    http.get(`${appBase}/bookingwod`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('token')).toMatch(/^42\|/);
      expect(new URL(request.url).searchParams.get('userID')).toBe('300');
      return HttpResponse.json(feed());
    }),
  );
});
upstream.events.on('request:start', ({ request }) => requests.push({ method: request.method, url: new URL(request.url) }));
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  upstream.resetHandlers();
  vi.useRealTimers();
});
afterAll(() => upstream.close());
async function connect(extra: Record<string, string | undefined> = {}) {
  const server = createServer({
    AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic-password',
    AIMHARDER_TIME_ZONE: 'Europe/Madrid', ...extra,
  });
  const client = new Client({ name: 'booking-behavioral-harness', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
async function query(client: Client, args: Record<string, unknown> = {}) {
  return client.callTool({ name: 'get_published_workouts', arguments: { date: '2026-09-23', className: 'WOD', ...args } });
}
const post = (extra = {}) => ({ id: 8001, day: '23 Sep', when: '20560923210000', wodClass: 'WOD', ejerRate: [], TIPOWODs: [{ title: 'Fuerza Ñ', notes: '3 rondas\nDescansa 60 segundos', deleted: 'false' }], ...extra });
const detail = (extra = {}) => ({ recordDate: '23 de Septiembre de 2026', publishDate: '22 de Septiembre de 2026', ejerRate: [{ ejerName: 'Sentadilla', tipoWOD: 0, valor1: ['10'], formaReg: 0 }], TIPOWODs: [{ notes: '3 rondas\nDescansa 60 segundos', deleted: false }], ...extra });
// App day-workout list envelope (`bookingwod`).
const feed = (elements = [post()]) => ({ elements });

test('preserves a repeated complex between runs in the base prescription and each difficulty', async () => {
 const labels = ['SCALED', 'INTERMEDIATE', 'RX'];
 const exercises = ['Run', 'Movement A', 'Movement B', 'Movement C', 'Run'].map((ejerName, index) => {
  const grouped = index > 0 && index < 4;
  const row = { ejerName, tipoWOD: 0, valor1: [grouped ? '6' : '500'], ...(grouped ? { complex: 2, complexrep: '4' } : {}) };
  return { ...row, privateProfile: 'private-complex-canary', scaledver: labels.map((_, variant) => ({ ...row,
   ...(grouped ? { complex: String(variant + 2), complexrep: String(variant + 4) } : {}),
  })) };
 });
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({
  TIPOWODs: [{ type: 1, deleted: false, rondas: 1, scaledops: labels }], ejerRate: exercises,
 }))));
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 const workout = (result.structuredContent as { workouts: { exercises: { name: string; prescription: Record<string, unknown> }[]; variants: { label: string; exercises: { name: string; prescription: Record<string, unknown> }[] }[] }[] }).workouts[0]!;
 const complex = (rows: typeof workout.exercises) => rows.map(row => [row.name, row.prescription.complex, row.prescription.complexrep]);
 expect(complex(workout.exercises)).toEqual([
  ['Run', undefined, undefined], ['Movement A', 2, '4'], ['Movement B', 2, '4'], ['Movement C', 2, '4'], ['Run', undefined, undefined],
 ]);
 expect(workout.variants.map(variant => variant.label)).toEqual(labels);
 workout.variants.forEach((variant, index) => {
  expect(complex(variant.exercises)).toEqual([
   ['Run', undefined, undefined], ...['Movement A', 'Movement B', 'Movement C'].map(name => [name, String(index + 2), String(index + 4)]), ['Run', undefined, undefined],
  ]);
 });
 expect(JSON.stringify(result)).not.toContain('private-complex-canary');
 expect(requests.every(request => request.method === 'GET' || request.url.pathname === '/api/login')).toBe(true);
});

test('keeps absent, null and zero complex fields distinct without inheriting base values into replacements', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({
  TIPOWODs: [{ deleted: false, scaledops: ['OPTION'] }],
  ejerRate: [{ ejerName: 'Base', tipoWOD: 0, complex: 0, complexrep: null, scaledver: [{ ejerName: 'Replacement', tipoWOD: 0 }] }],
 }))));
 const result = await query(await connect());
 expect(result.structuredContent).toMatchObject({ workouts: [{ exercises: [{ prescription: { complex: 0, complexrep: null } }],
  variants: [{ exercises: [{ name: 'Replacement', prescription: {} }] }],
 }] });
 const workout = (result.structuredContent as { workouts: { variants: { exercises: { prescription: Record<string, unknown> }[] }[] }[] }).workouts[0]!;
 expect(workout.variants[0]!.exercises[0]!.prescription).not.toHaveProperty('complex');
 expect(workout.variants[0]!.exercises[0]!.prescription).not.toHaveProperty('complexrep');
});

test('keeps EMOM sequential and cycling modes distinct without copying a base mode into replacements', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({
  TIPOWODs: [
   { deleted: false, type: 3, timecap: 1, time: 0, rondas: 2, reps: 0, scaledops: ['CYCLING', 'UNSPECIFIED'], scaledver: [
    { deleted: false, type: '3', timecap: 1, time: 0, rondas: 2, reps: '1' },
    { deleted: false, type: 3, timecap: 1, time: 0, rondas: 2 },
   ] },
   { deleted: false, type: 3, reps: 1 },
   { deleted: false, type: 3, reps: null },
   { deleted: false, type: 3 },
   { deleted: false, type: 10, reps: [99] },
  ],
  ejerRate: ['Movement A', 'Movement B'].map((ejerName, index) => {
   const row = { ejerName, tipoWOD: 0, valor1: ['8'], round: index + 1, roundrepeat: 6 };
   return { ...row, scaledver: [row, row] };
  }),
 }))));
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 const workout = (result.structuredContent as { workouts: { blocks: { prescription: Record<string, unknown> }[]; variants: { blocks: { prescription: Record<string, unknown> }[] }[] }[] }).workouts[0]!;
 expect(workout.blocks[0]!.prescription).toMatchObject({ type: 3, reps: 0, timecap: 1, time: 0, rondas: 2 });
 expect(workout.blocks[1]!.prescription).toMatchObject({ reps: 1 });
 expect(workout.blocks[2]!.prescription).toHaveProperty('reps', null);
 expect(workout.blocks[3]!.prescription).not.toHaveProperty('reps');
 expect(workout.blocks[4]!.prescription).not.toHaveProperty('reps');
 expect(workout.variants[0]!.blocks[0]!.prescription).toMatchObject({ type: '3', reps: '1' });
 expect(workout.variants[1]!.blocks[0]!.prescription).not.toHaveProperty('reps');
 expect(requests.every(request => request.method === 'GET' || request.url.pathname === '/api/login')).toBe(true);
});
function respond(elements: unknown[]) { upstream.use(http.get(`${appBase}/bookingwod`, () => HttpResponse.json(feed(elements as ReturnType<typeof post>[])))); }
function personalRecord(id: number, value = '100.5', unit = 'kg') {
 const date = Date.UTC(2026, 8, 24);
 return { id: String(id), name: 'Source lift', chartUserId: 42, chartData1RM: [{ date: Date.UTC(2026, 8, 1), lbs: '200', idAction: 899 }, { date, lbs: value, idAction: 900 }], chartData3RM: [], chartData5RM: [], chartData10RM: [], chartDataWOD: [], history: [{ date, idAction: 900, desc: `${value} ${unit}` }], privateProfile: 'private-profile' };
}
function todayWorkout(exercises: unknown[], extra: Record<string, unknown> = {}) {
 return detail({ recordDate: '27 de Septiembre de 2026', ejerRate: exercises, ...extra });
}
function percentExercise(id: unknown, valor2: unknown, extra: Record<string, unknown> = {}) {
 return { ejerId: id, ejerName: 'Source lift', tipoWOD: 0, formaReg: 4, tipoud: 4, valor2, ...extra };
}
function setToday() { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-26T22:30:00Z')); }

test('today and future use the latest exact-ID 1RM with precise arithmetic; past preserves only the prescription', async () => {
 setToday();
 upstream.use(
  http.get(`${appBase}/activity/workout`, () => HttpResponse.json(todayWorkout([percentExercise(101, '85')]))),
  http.get(`${appBase}/exercise/101/42/:token`, () => HttpResponse.json(personalRecord(101))),
 );
 const client = await connect();
 const result = await query(client, { date: '2026-09-27' });
 expect(result.structuredContent).toMatchObject({ enrichment: { status: 'complete', eligibleExercises: 1 }, workouts: [{ exercises: [{ prescription: { valor2: '85', loadUnit: '%RM' }, personalLoad: { status: 'available', alternatives: [{ originalPercent: '85', calculatedLoad: '85.425', unit: 'kg', basis: { value: '100.5', sourceDate: '2026-09-24', sourceExerciseId: 101 } }] } }] }] });
 expect(JSON.stringify(result)).not.toContain('private-profile');
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/')).map(r => r.url.pathname.split('/').slice(0, 6).join('/'))).toEqual(['/aplic/apiExternal/exercise/101/42']);
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({ recordDate: '26 de Septiembre de 2026', ejerRate: [percentExercise(101, '85')] }))));
 const past = await query(client, { date: '2026-09-26' });
 expect(past.structuredContent).toMatchObject({ enrichment: { status: 'not-applicable' }, workouts: [{ exercises: [{ prescription: { valor2: '85' } }] }] });
 expect(JSON.stringify(past.structuredContent)).not.toContain('personalLoad');
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(1);
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({ recordDate: '28 de Septiembre de 2026', ejerRate: [percentExercise(101, '85')] }))));
 const future = await query(client, { date: '2026-09-28' });
 expect(future.structuredContent).toMatchObject({ enrichment: { status: 'complete' }, workouts: [{ exercises: [{ personalLoad: { status: 'available' } }] }] });
});

test('keeps every publication and labeled variant with exact source IDs and bounded deduplicated reads', async () => {
 setToday();
 respond([post(), post({ id: 8002 })]);
 upstream.use(
  http.get(`${appBase}/activity/workout`, () => HttpResponse.json(todayWorkout([percentExercise(101, '80', { scaledver: [percentExercise(102, '60')] })], { TIPOWODs: [{ notes: 'Original', deleted: false, scaledops: ['SCALED'] }] }))),
  http.get(`${appBase}/exercise/101/42/:token`, () => HttpResponse.json(personalRecord(101))),
  http.get(`${appBase}/exercise/102/42/:token`, () => HttpResponse.json(personalRecord(102, '50', 'lbs'))),
 );
 const result = await query(await connect(), { date: '2026-09-27' });
 expect(result.structuredContent).toMatchObject({ ambiguous: true, enrichment: { status: 'complete', eligibleExercises: 4 }, workouts: [{ exercises: [{ personalLoad: { alternatives: [{ calculatedLoad: '80.4', unit: 'kg' }] } }], variants: [{ label: 'SCALED', exercises: [{ sourceExerciseId: 102, personalLoad: { alternatives: [{ calculatedLoad: '30', unit: 'lbs' }] } }] }] }, {}] });
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(2);
});

test('split source fields produce both labeled loads and equal slash pairs produce one', async () => {
 setToday();
 upstream.use(
  http.get(`${appBase}/activity/workout`, () => HttpResponse.json(todayWorkout([percentExercise(101, '85/85', { valor2h: '85', valor2m: '75' }), percentExercise(101, '85/85')]))),
  http.get(`${appBase}/exercise/101/42/:token`, () => HttpResponse.json(personalRecord(101))),
 );
 const result = await query(await connect(), { date: '2026-09-27' });
 expect(result.structuredContent).toMatchObject({ enrichment: { status: 'complete' }, workouts: [{ exercises: [
  { personalLoad: { alternatives: [{ sourceField: 'valor2h', sourceLabel: 'male', originalPercent: '85', calculatedLoad: '85.425' }, { sourceField: 'valor2m', sourceLabel: 'female', originalPercent: '75', calculatedLoad: '75.375' }] } },
  { personalLoad: { alternatives: [{ originalPercent: '85/85', calculatedLoad: '85.425' }] } },
 ] }] });
});

test('unequal unstructured pairs, unknown units, missing IDs and read failures retain original workouts with unavailable reasons', async () => {
 setToday();
 upstream.use(
  http.get(`${appBase}/activity/workout`, () => HttpResponse.json(todayWorkout([percentExercise(101, '85/75'), percentExercise(102, '70'), percentExercise(null, '60'), percentExercise(103, '50')]))),
  http.get(`${appBase}/exercise/101/42/:token`, () => HttpResponse.json(personalRecord(101))),
  http.get(`${appBase}/exercise/102/42/:token`, () => HttpResponse.json({ ...personalRecord(102), history: [] })),
  http.get(`${appBase}/exercise/103/42/:token`, () => new HttpResponse(null, { status: 500 })),
 );
 const result = await query(await connect(), { date: '2026-09-27' });
 expect(result.isError).not.toBe(true);
 expect(result.structuredContent).toMatchObject({ enrichment: { status: 'incomplete', unavailableExercises: 4 }, workouts: [{ exercises: [
  { prescription: { valor2: '85/75' }, personalLoad: { alternatives: [{ status: 'unavailable', reason: 'unstructured-or-unequal-percentage', calculatedLoad: null }] } },
  { personalLoad: { alternatives: [{ reason: 'physical-unit-unverified' }] } },
  { sourceExerciseId: null, personalLoad: { alternatives: [{ reason: 'source-exercise-id-unavailable' }] } },
  { personalLoad: { alternatives: [{ reason: 'personal-read-failed' }] } },
 ] }] });
});

test('identity mismatch and access denial during enrichment stop the workout query', async () => {
 setToday();
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(todayWorkout([percentExercise(101, '85')]))));
 const client = await connect();
 upstream.use(http.get(`${appBase}/exercise/101/42/:token`, () => HttpResponse.json({ ...personalRecord(101), chartUserId: 99 })));
 const mismatch = await query(client, { date: '2026-09-27' });
 expect(mismatch.isError).toBe(true);
 expect(JSON.stringify(mismatch)).toContain('IDENTITY_MISMATCH');
 upstream.use(http.get(`${appBase}/exercise/101/42/:token`, () => new HttpResponse(null, { status: 403 })));
 const denied = await query(client, { date: '2026-09-27' });
 expect(denied.isError).toBe(true);
 expect(JSON.stringify(denied)).toContain('ACCESS_RESTRICTED');
});

test('failed identity verification during session recovery is not downgraded to incomplete enrichment', async () => {
 setToday();
 let loginCount = 0;
 upstream.use(
  http.get(`${appBase}/activity/workout`, () => HttpResponse.json(todayWorkout([percentExercise(101, '85')]))),
  http.get(`${appBase}/exercise/101/42/:token`, () => new HttpResponse(null, { status: 401 })),
  http.get(`${appBase}/login`, () => { const userId = ++loginCount === 1 ? 42 : 99; return HttpResponse.json({ cookie: appToken(userId), userId, clientBoxes: [{ id: 200, idrel: 300, url: 'sample-gym', name: 'Sample Gym' }] }); }),
 );
 const result = await query(await connect(), { date: '2026-09-27' });
 expect(result.isError).toBe(true);
 expect(JSON.stringify(result)).toContain('IDENTITY_MISMATCH');
 expect(loginCount).toBe(2);
});

test('split alternatives retain original values and individual unavailable statuses when one percentage is malformed', async () => {
 setToday();
 upstream.use(
  http.get(`${appBase}/activity/workout`, () => HttpResponse.json(todayWorkout([percentExercise(101, '80/??', { valor2h: '80', valor2m: 'bad' })]))),
  http.get(`${appBase}/exercise/101/42/:token`, () => HttpResponse.json(personalRecord(101))),
 );
 const result = await query(await connect(), { date: '2026-09-27' });
 expect(result.structuredContent).toMatchObject({ enrichment: { status: 'incomplete' }, workouts: [{ exercises: [{ prescription: { valor2: '80/??', valor2h: '80', valor2m: 'bad' }, personalLoad: { status: 'partial', alternatives: [{ calculatedLoad: '80.4' }, { status: 'unavailable', reason: 'unsupported-percentage', calculatedLoad: null }] } }] }] });
});

test('split percentages on a labeled variant retain both unavailable branches for no RM, unknown unit and read failure', async () => {
 setToday();
 upstream.use(
  http.get(`${appBase}/activity/workout`, () => HttpResponse.json(todayWorkout([
   percentExercise(101, '80', { scaledver: [percentExercise(102, '80/70', { valor2h: '80', valor2m: '70' })] }),
   percentExercise(103, '80', { valor2h: '80', valor2m: '70', scaledver: [percentExercise(103, '80', { valor2h: '80', valor2m: '70' })] }),
   percentExercise(104, '80', { valor2h: '80', valor2m: '70', scaledver: [percentExercise(104, '80', { valor2h: '80', valor2m: '70' })] }),
  ], { TIPOWODs: [{ notes: 'Block', deleted: false, scaledops: ['SCALED'] }] }))),
  http.get(`${appBase}/exercise/:id/42/:token`, ({ params }) => {
   const id = Number(params.id);
   if (id === 102) return HttpResponse.json({ ...personalRecord(id), chartData1RM: [] });
   if (id === 103) return HttpResponse.json({ ...personalRecord(id), history: [] });
   if (id === 104) return new HttpResponse(null, { status: 500 });
   return HttpResponse.json(personalRecord(id));
  }),
 );
 const result = await query(await connect(), { date: '2026-09-27' });
 expect(result.structuredContent).toMatchObject({ enrichment: { status: 'incomplete' }, workouts: [{ variants: [{ label: 'SCALED', exercises: [
  { sourceExerciseId: 102, prescription: { valor2h: '80', valor2m: '70' }, personalLoad: { alternatives: [{ reason: 'no-1rm-in-returned-view' }, { reason: 'no-1rm-in-returned-view' }] } },
  { sourceExerciseId: 103, personalLoad: { alternatives: [{ reason: 'physical-unit-unverified' }, { reason: 'physical-unit-unverified' }] } },
  { sourceExerciseId: 104, personalLoad: { alternatives: [{ reason: 'personal-read-failed' }, { reason: 'personal-read-failed' }] } },
 ] }] }] });
});

test('limits unique personal reads and marks excess exact IDs unavailable', async () => {
 setToday();
 upstream.use(
  http.get(`${appBase}/activity/workout`, () => HttpResponse.json(todayWorkout(Array.from({ length: 25 }, (_, i) => percentExercise(100 + i, '50'))))),
  http.get(`${appBase}/exercise/:id/42/:token`, ({ params }) => HttpResponse.json(personalRecord(Number(params.id)))),
 );
 const result = await query(await connect(), { date: '2026-09-27' });
 expect(result.structuredContent).toMatchObject({ enrichment: { status: 'incomplete', eligibleExercises: 25, availableExercises: 24, unavailableExercises: 1 } });
 expect(requests.filter(r => r.url.pathname.startsWith('/aplic/apiExternal/exercise/'))).toHaveLength(24);
 const body = result.structuredContent as { workouts: { exercises: { personalLoad: { alternatives: { reason: string | null }[] } }[] }[] };
 expect(body.workouts[0]!.exercises[24]!.personalLoad.alternatives[0]!.reason).toBe('personal-read-limit');
});
test('returns original future workout content with verified date, class and provenance, without a unique session', async () => {
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 expect(result.structuredContent).toMatchObject({ status: 'available', ambiguous: false, workouts: [{ date: '2026-09-23', className: 'WOD', sessionId: null, titles: [], blocks: [{ notes: '3 rondas\nDescansa 60 segundos' }], exercises: [{ name: 'Sentadilla', prescription: { valor1: ['10'] } }], provenance: { sourceId: 8001, dateField: 'recordDate' } }] });
});
test('exposes only source exercise IDs on base, shared, and replacement exercises', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({
  TIPOWODs: [{ notes: 'Shared', deleted: false }, { notes: 'Levels', deleted: false, scaledops: ['SCALED', 'RX'] }],
  ejerRate: [
   { ejerId: 101, ejerName: 'Shared lift', tipoWOD: 0, valor1: ['5'] },
   { ejerId: 102, ejerName: 'Lift', tipoWOD: 1, valor2: '85', scaledver: [
    { ejerId: 201, ejerName: 'Lift', tipoWOD: 1, valor2: '65' },
    { ejerId: 'bad-id', ejerName: 'Lift', tipoWOD: 1, valor2: '85' },
   ] },
   { ejerName: 'Shared lift', tipoWOD: 0 },
  ],
 }))));
 respond([post(), post({ id: 8002 })]);
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 const workouts = (result.structuredContent as { workouts: { exercises: { sourceExerciseId: number | null; prescription: Record<string, unknown> }[]; variants: { exercises: { sourceExerciseId: number | null; prescription: Record<string, unknown> }[] }[] }[] }).workouts;
 expect(workouts).toHaveLength(2);
 for (const workout of workouts) {
  expect(workout.exercises.map(e => e.sourceExerciseId)).toEqual([101, 102, null]);
  expect(workout.variants.map(v => v.exercises.map(e => e.sourceExerciseId))).toEqual([[101, 201, null], [101, null, null]]);
  expect(workout.exercises[1]?.prescription.valor2).toBe('85');
  expect(workout.variants[0]?.exercises[1]?.prescription.valor2).toBe('65');
 }
 expect(result.structuredContent).toMatchObject({ ambiguous: true });
});
test('announcements cannot establish applicability from future timestamps', async () => {
 respond([{ id: 1, highlight: 1, when: '20560923210000', desc: 'Announcement' }]);
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'unavailable', workouts: [], coverage: { scope: 'upstream-day-workouts', status: 'complete' } });
});
test('distinct publications remain ambiguous even with unverified correction hints', async () => {
 respond([post(), post({ id: 8002, correctionOf: 8001 })]);
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'available', ambiguous: true, workouts: [{}, {}] });
});
test('unsupported dates do not become unavailable', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({ recordDate: 'Sep 23, 2026' }))));
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'unsupported', workouts: [] });
});
test('detail failure is failed retrieval, not unpublished', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => new HttpResponse(null, { status: 500 })));
 expect((await query(await connect())).isError).toBe(true);
});
test('uses an assumed zone and rejects arbitrary publisher selection', async () => {
 expect((await query(await connect({ AIMHARDER_TIME_ZONE: undefined }))).structuredContent).toMatchObject({ gym: { timeZone: 'Europe/Madrid', timeZoneStatus: 'assumed' } });
 expect((await query(await connect(), { userID: 77 })).isError).toBe(true);
 expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/bookingwod')).toHaveLength(1);
});

test('empty and deleted content is unavailable in the retrieved view', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({ ejerRate: [], TIPOWODs: [{ notes: 'deleted', deleted: true }] }))));
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'unavailable', workouts: [] });
});
test('a day-workout entry without a class is ignored, not unsupported', async () => {
 respond([{ id: 9001 }]);
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'unavailable', coverage: { interpretation: 'verified' } });
 expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/activity/workout')).toHaveLength(0);
});
test('preserves block prescriptions and excludes unrelated private details', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({ userName: 'private-name', comments: ['private-comment'], TIPOWODs: [{ notes: 'Completa 5 rondas', deleted: false, timecap: 1200, rondas: 5, rx: true }] }))));
 const result = await query(await connect());
 expect(result.structuredContent).toMatchObject({ workouts: [{ blocks: [{ notes: 'Completa 5 rondas', prescription: { timecap: 1200, rondas: 5, rx: true } }] }] });
 expect(JSON.stringify(result)).not.toMatch(/private-name|private-comment/);
});
test('labels load values using the source exercise format and unit code', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({
  ejerRate: [
   { ejerName: 'Barbell lift', tipoWOD: 0, formaReg: 4, valor1: ['3', '3', '3'], valor2: '85/85', tipoud: 4 },
   { ejerName: 'Dumbbell lift', tipoWOD: 0, formaReg: 4, valor1: ['20'], valor2: '15/10', valor2h: '15', valor2m: '10', tipoud: 0 },
   { ejerName: 'Carry', tipoWOD: 0, formaReg: 6, valor1: ['50'], valor2: '30', tipoud: 0, tipoud2: 1 },
   { ejerName: 'Rest', tipoWOD: 0, formaReg: 1, valor1: ['30', '30', '30'] },
   { ejerName: 'Minute rest', tipoWOD: 0, formaReg: 1, valor1: ['60'] },
   { ejerName: 'Unspecified rest', tipoWOD: 0, formaReg: 1, valor1: [''] },
   { ejerName: 'Unweighted lunge', tipoWOD: 0, formaReg: 4, valor1: ['10', '10', '10'], valor2: null, tipoud: 1 },
   { ejerName: 'Unweighted carry', tipoWOD: 0, formaReg: 6, valor1: ['30', '30', '30'], valor2: null, tipoud: 0, tipoud2: 0 },
   { ejerName: 'Unrecognized unit', tipoWOD: 0, formaReg: 4, valor2: '8', tipoud: 99 },
   { ejerName: 'Ordinary repetitions', tipoWOD: 0, formaReg: 3, valor1: ['10'], tipoud: 0 },
  ],
 }))));
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 expect(result.structuredContent).toMatchObject({ workouts: [{ exercises: [
  { prescription: { valor1: ['3', '3', '3'], valueUnit: 'reps', valor2: '85/85', tipoud: 4, loadUnit: '%RM' } },
  { prescription: { valor2: '15/10', valor2h: '15', valor2m: '10', tipoud: 0, valueUnit: 'reps', loadUnit: 'kg' } },
  { prescription: { valor2: '30', tipoud: 0, tipoud2: 1, valueUnit: 'm', loadUnit: 'lbs' } },
  { prescription: { valor1: ['30', '30', '30'], valueUnit: 's' } },
  { prescription: { valor1: ['60'], valueUnit: 's' } },
  { prescription: { valor1: [''] } },
  { prescription: { valor1: ['10', '10', '10'], valueUnit: 'reps', valor2: null, tipoud: 1 } },
  { prescription: { valor1: ['30', '30', '30'], valueUnit: 'm', valor2: null, tipoud: 0, tipoud2: 0 } },
  { prescription: { valor2: '8', tipoud: 99 } },
  { prescription: { valor1: ['10'], tipoud: 0, valueUnit: 'reps' } },
 ] }] });
 const exercises = (result.structuredContent as { workouts: { exercises: { prescription: Record<string, unknown> }[] }[] }).workouts[0]!.exercises;
 expect(exercises[5]!.prescription).not.toHaveProperty('valueUnit');
 expect(exercises[6]!.prescription).not.toHaveProperty('loadUnit');
 expect(exercises[7]!.prescription).not.toHaveProperty('loadUnit');
 expect(exercises[8]!.prescription).not.toHaveProperty('loadUnit');
 expect(exercises[9]!.prescription).not.toHaveProperty('loadUnit');
});
test.each(['WOD', 'Metcon'])('returns complete source-labeled %s difficulty variants', async className => {
 respond([post({ wodClass: className })]);
 const labels = ['SCALED', 'INTERMEDIO', 'RX'];
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({
  TIPOWODs: [
   { notes: 'Warm up', deleted: false },
   { notes: '15 min AMRAP', deleted: false, scaledops: labels, scaledver: labels.map(() => ({ notes: '15 min AMRAP', deleted: false })) },
  ],
  ejerRate: [
   { ejerName: '5 pull-ups', tipoWOD: 0, valor1: ['5'] },
   { ejerName: 'Dumbbell lift', tipoWOD: 1, formaReg: 4, valor1: ['20'], valor2: '10', tipoud: 0, scaledver: [
    { ejerName: 'Dumbbell lift', tipoWOD: 1, formaReg: 4, valor1: ['20'], valor2: '10', tipoud: 0, privateProfile: 'exclude-me' },
    { ejerName: 'Dumbbell lift', tipoWOD: 1, formaReg: 4, valor1: ['20'], valor2: '12', tipoud: 0 },
    { ejerName: 'Dumbbell lift', tipoWOD: 1, formaReg: 4, valor1: ['20'], valor2: '15', tipoud: 0 },
   ] },
  ],
 }))));
 const result = await query(await connect(), { className });
 expect(result.isError).not.toBe(true);
 const workout = (result.structuredContent as { workouts: { exercises: unknown[]; variants: { label: string; blocks: { notes: string }[]; exercises: { name: string; prescription: Record<string, unknown> }[] }[] }[] }).workouts[0]!;
 expect(workout.variants.map(variant => variant.label)).toEqual(labels);
 expect(workout.variants.map(variant => variant.exercises.map(exercise => [exercise.name, exercise.prescription.valor2, exercise.prescription.valueUnit, exercise.prescription.loadUnit]))).toEqual([
  [['5 pull-ups', undefined, undefined, undefined], ['Dumbbell lift', '10', 'reps', 'kg']],
  [['5 pull-ups', undefined, undefined, undefined], ['Dumbbell lift', '12', 'reps', 'kg']],
  [['5 pull-ups', undefined, undefined, undefined], ['Dumbbell lift', '15', 'reps', 'kg']],
 ]);
 expect(workout.variants.every(variant => variant.blocks[0]?.notes === 'Warm up')).toBe(true);
 expect(JSON.stringify(result)).not.toContain('exclude-me');
});
test('falls back to shared blocks while retaining the source prescription separately', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({
  TIPOWODs: [{ notes: 'Shared', deleted: false, scaledops: ['SCALED', 'RX'], scaledver: [null, { notes: 'RX note', deleted: false }] }],
  ejerRate: [{ ejerName: 'Shared move', tipoWOD: 0, scaledver: [
   { ejerName: 'Scaled move', tipoWOD: 0 }, { ejerName: 'RX move', tipoWOD: 0 },
  ] }],
 }))));
 const result = await query(await connect());
 expect(result.structuredContent).toMatchObject({ workouts: [{
  blocks: [{ notes: 'Shared' }], exercises: [{ name: 'Shared move' }],
  variants: [
   { label: 'SCALED', blocks: [{ notes: 'Shared' }], exercises: [{ name: 'Scaled move' }] },
   { label: 'RX', blocks: [{ notes: 'RX note' }], exercises: [{ name: 'RX move' }] },
  ],
 }] });
});
test('malformed variant exercise does not produce a misleading partial level', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({
  TIPOWODs: [{ notes: 'Workout', deleted: false, scaledops: ['SCALED'], scaledver: [null] }],
  ejerRate: [{ ejerName: 'Move', tipoWOD: 0, scaledver: [] }],
 }))));
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'unsupported', workouts: [] });
});
test('publication date cannot replace a different intended workout date', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail({ recordDate: '24 de Septiembre de 2026', publishDate: '23 de Septiembre de 2026' }))));
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'unavailable', workouts: [] });
});
test('known content survives unsupported alternatives with explicit interpretation warning', async () => {
 respond([post(), post({ id: 8002 })]);
 upstream.use(http.get(`${appBase}/activity/workout`, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.get('SEID') === '8001' ? detail() : {})));
 expect((await query(await connect())).structuredContent).toMatchObject({ status: 'available', coverage: { interpretation: 'unsupported' }, workouts: [{}] });
});
test.each([{}, { timeLineFormat: '0', timeLineContent: '7', elements: [], curDate: '', nextPage: 2 }])('invalid feed is a retrieval error', async body => {
 upstream.use(http.get(`${appBase}/bookingwod`, () => HttpResponse.json(body)));
 expect((await query(await connect())).isError).toBe(true);
});
test('takes the publisher from the app login without reading the gym page', async () => {
 await query(await connect());
 expect(requests.filter(r => r.url.hostname === 'sample-gym.aimharder.es' && r.url.pathname === '/')).toHaveLength(0);
 expect(requests.find(r => r.url.pathname === '/aplic/apiExternal/bookingwod')!.url.searchParams.get('userID')).toBe('300');
});
test.each(['timeLineContent: 7, userID: 300; timeLineContent: 7, userID: 301', '<html>Login</html>'])('without the box in the app login, does not invent a publisher from an unsupported homepage', async page => {
 upstream.use(appLogin(42, []), http.get('https://sample-gym.aimharder.es/', () => HttpResponse.text(page)));
 expect((await query(await connect())).isError).toBe(true);
 expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/bookingwod')).toHaveLength(0);
});
test('one app re-login recovers an expired detail read', async () => {
 let calls = 0;
 upstream.use(http.get(`${appBase}/activity/workout`, () => ++calls === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json(detail())));
 expect((await query(await connect())).isError).not.toBe(true);
 expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/login')).toHaveLength(2);
});
test('repeated expiry stops without returning unavailable', async () => {
 upstream.use(http.get(`${appBase}/activity/workout`, () => new HttpResponse(null, { status: 401 })));
 expect((await query(await connect())).isError).toBe(true);
 expect(requests.filter(r => r.url.pathname === '/aplic/apiExternal/login')).toHaveLength(2);
});
test('all operations remain the selected gym read-only allowlist', async () => {
 await query(await connect());
 for (const r of requests) {
  if (r.url.pathname === '/api/login') expect(r.method).toBe('POST');
  else expect(r.method).toBe('GET');
  expect(['/api/login', '/api/whoami', '/aplic/apiExternal/login', '/aplic/apiExternal/bookingwod', '/aplic/apiExternal/activity/workout']).toContain(r.url.pathname);
 }
});
test('routes only to the chosen verified gym and preserves its configured zone', async () => {
 upstream.use(
  http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership(), membership('other-gym', 201)] }] })),
  http.get('https://other-gym.aimharder.es/', () => HttpResponse.text('timeLineContent: 7, userID: 301')),
  http.get(`${appBase}/bookingwod`, ({ request }) => {
   expect(new URL(request.url).searchParams.get('userID')).toBe('301'); return HttpResponse.json(feed());
  }),
  http.get(`${appBase}/activity/workout`, () => HttpResponse.json(detail())),
 );
 const client = await connect({ AIMHARDER_GYM: 'other-gym', AIMHARDER_TIME_ZONE: 'Atlantic/Canary' });
 expect((await query(client)).structuredContent).toMatchObject({ gym: { id: 'other-gym' }, workouts: [{ timeZone: 'Atlantic/Canary' }] });
 expect((await query(await connect({ AIMHARDER_GYM: 'foreign-gym' }))).isError).toBe(true);
 expect(requests.filter(r => r.url.hostname === 'foreign-gym.aimharder.es')).toHaveLength(0);
});

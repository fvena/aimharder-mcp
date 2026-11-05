import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];
const requests: { method: string; url: URL; body?: FormData }[] = [];
const app = 'https://aimharder.com/aplic/apiExternal';
const token = (n = 1) => `42|${Math.floor(Date.now() / 1000) + 90 * 86_400}|${String(n).repeat(32).slice(0, 32)}`;
let issued = 0;
// The last token the simulated login issued; compared as issued, so a second boundary cannot change it.
let issuedToken = '';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const spanish = (date: string) => `${Number(date.slice(8))} de ${months[Number(date.slice(5, 7)) - 1]} de ${date.slice(0, 4)}`;
const session = (extra: Record<string, unknown> = {}) => ({ id: 840420, classId: 10, className: 'CROSS', time: '14:00 - 15:00', ocupation: 2, limit: 14, coachName: 'Sample Coach', ...extra });

beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  requests.length = 0; issued = 0; issuedToken = '';
  upstream.use(
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({ data: { userData: { id: 42 }, auth: { authOK: true } } },
      { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [{ role: 'client', boid: 200, gym: 'Sample Gym', centre_url: 'sample-gym.aimharder.es' }] }] })),
    http.get(`${app}/bookings`, () => HttpResponse.json({ bookings: [session(), session({ id: 840421, time: '18:00 - 19:00', coachName: null })] })),
    http.get(`${app}/exercise/18/42/:token`, () => HttpResponse.json({ id: 18, name: 'Bench Press', chartUserId: 42,
      chartData1RM: [], chartData3RM: [], chartData5RM: [], chartData10RM: [], chartDataWOD: [], history: [] })),
    http.get(`${app}/login`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get('mail')).toBe('account@example.invalid');
      if (params.get('pw') !== 'synthetic-password') return HttpResponse.json({ error: 'Correo electrónico y/o contraseña incorrecto' });
      issued++;
      issuedToken = token(issued);
      return HttpResponse.json({ cookie: issuedToken, userId: 42, clientBoxes: [] });
    }),
    http.get(`${app}/classAthleteBookings`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get('token')).toBe(issuedToken);
      expect([params.get('hcid'), params.get('box')]).toEqual(['840420', '200']);
      return HttpResponse.json({ athletes: [{ id: 1, usid: 42, name: 'Account Holder', pic: 'https://example.invalid/a.jpg', state: 1, insignias: null },
        { id: 2, usid: 77, name: 'Training Partner', pic: 'https://example.invalid/b.jpg', state: 1, insignias: null }] });
    }),
  );
});
upstream.events.on('request:start', async ({ request }) => {
  const entry: { method: string; url: URL; body?: FormData } = { method: request.method, url: new URL(request.url) };
  requests.push(entry);
  if (request.method === 'POST' && entry.url.pathname.endsWith('/activity')) entry.body = await request.clone().formData();
});
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
  upstream.resetHandlers();
});
afterAll(() => upstream.close());

async function connect(extra: Record<string, string> = {}) {
  const server = createServer({ AIMHARDER_USERNAME: 'account@example.invalid', AIMHARDER_PASSWORD: 'synthetic-password',
    AIMHARDER_GYM_TIME_ZONES: '{"sample-gym":"Europe/Madrid"}', ...extra });
  const client = new Client({ name: 'app-api-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
const appCalls = (path: string) => requests.filter(r => r.url.origin === 'https://aimharder.com' && r.url.pathname === `/aplic/apiExternal/${path}`);
type Participants = { status: string; session: { coach: string | null; occupancy: number } | null; participants: { userId: number; name: string; sourceState: number | null }[] };

test('lists participants of one exact session through one app login, without photos', async () => {
  const client = await connect();
  for (let i = 0; i < 2; i++) {
    const result = await client.callTool({ name: 'get_class_participants', arguments: { date: '2026-11-05', className: 'CROSS', startTime: '14:00' } });
    expect(result.isError).not.toBe(true);
    const content = result.structuredContent as Participants;
    expect(content).toMatchObject({ status: 'available', session: { coach: 'Sample Coach', occupancy: 2 } });
    expect(content.participants).toEqual([{ userId: 42, name: 'Account Holder', sourceState: 1 }, { userId: 77, name: 'Training Partner', sourceState: 1 }]);
    expect(JSON.stringify(result)).not.toContain('example.invalid/');
  }
  expect(appCalls('login')).toHaveLength(1);
});

test('reports missing sessions without requesting participants', async () => {
  const result = await (await connect()).callTool({ name: 'get_class_participants', arguments: { date: '2026-11-05', className: 'CROSS', startTime: '07:00' } });
  expect(result.structuredContent).toMatchObject({ status: 'missing', session: null, participants: [] });
  expect(appCalls('classAthleteBookings')).toHaveLength(0);
});

test('signs in again once when the app answers logout', async () => {
  let calls = 0;
  upstream.use(http.get(`${app}/classAthleteBookings`, () => (++calls === 1 ? HttpResponse.json({ logout: 1 }) : HttpResponse.json({ athletes: [] }))));
  const result = await (await connect()).callTool({ name: 'get_class_participants', arguments: { date: '2026-11-05', className: 'CROSS', startTime: '14:00' } });
  expect(result.structuredContent).toMatchObject({ status: 'available', participants: [] });
  expect(appCalls('login')).toHaveLength(2);
});

test('stops when the app account differs from the web account, and never exposes credentials', async () => {
  upstream.use(
    http.get(`${app}/login`, () => HttpResponse.json({ cookie: `99|${Math.floor(Date.now() / 1000) + 86_400}|${'a'.repeat(32)}`, userId: 99 })),
    http.get(`${app}/classAthleteBookings`, () => HttpResponse.json({ athletes: [] })),
  );
  const result = await (await connect()).callTool({ name: 'get_class_participants', arguments: { date: '2026-11-05', className: 'CROSS', startTime: '14:00' } });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('IDENTITY_MISMATCH');
  expect(JSON.stringify(result)).not.toMatch(/synthetic-password|account@example/);
});

test('reports a failed app login as an authentication error', async () => {
  upstream.use(http.get(`${app}/login`, () => HttpResponse.json({ error: 'Correo electrónico y/o contraseña incorrecto' })));
  const result = await (await connect()).callTool({ name: 'get_class_participants', arguments: { date: '2026-11-05', className: 'CROSS', startTime: '14:00' } });
  expect(JSON.stringify(result)).toContain('AUTHENTICATION_FAILED');
});

test('previews an exercise result without writing, then saves it once after confirmation', async () => {
  upstream.use(
    http.post(`${app}/activity`, () => HttpResponse.text(Buffer.from(JSON.stringify({ errors: [], errorWODsID: [], errorWODsType: [], errorEjerID: [], id: '555' })).toString('base64'))),
    http.get(`${app}/activity/workout`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('SEID')).toBe('555');
      return HttpResponse.json({ userId: 42, recordDate: spanish(today) });
    }),
  );
  const client = await connect();
  const preview = await client.callTool({ name: 'prepare_exercise_result', arguments: { exerciseId: 18, date: today, sets: 5, reps: 6, loadKg: 62.5 } });
  expect(preview.isError).not.toBe(true);
  expect(preview.structuredContent).toMatchObject({ status: 'ready', exercise: { sourceExerciseId: 18, name: 'Bench Press' }, sets: 5, reps: 6, loadKg: 62.5, latest1RM: null, writeConfirmationRequired: true });
  expect(appCalls('activity')).toHaveLength(0);
  const reference = (preview.structuredContent as { actionReference: string }).actionReference;

  const unconfirmed = await client.callTool({ name: 'execute_exercise_result', arguments: { actionReference: reference } });
  expect(unconfirmed.isError).toBe(true);
  expect(appCalls('activity')).toHaveLength(0);

  const saved = await client.callTool({ name: 'execute_exercise_result', arguments: { actionReference: reference, confirmed: true } });
  expect(saved.structuredContent).toMatchObject({ status: 'confirmed', activityId: 555 });
  const [post] = appCalls('activity');
  const form = post!.body!;
  expect(form.get('selectedDate')).toBe(today.replaceAll('-', ''));
  expect(form.get('boxLocation')).toBe('200');
  expect(JSON.parse(String(form.get('ejerRate')))).toEqual([expect.objectContaining({ ejerId: 18, ejerName: 'Bench Press', formaReg: 4, valor1: ['6', '6', '6', '6', '6'], valor2: '62.5', tipoud: 0 })]);
  expect(JSON.parse(String(form.get('TIPOWODs')))).toEqual([expect.objectContaining({ type: 6, sstipo: 1, deleted: false })]);
  expect(form.get('token')).toBe(issuedToken);

  const reused = await client.callTool({ name: 'execute_exercise_result', arguments: { actionReference: reference, confirmed: true } });
  expect(JSON.stringify(reused)).toContain('EXERCISE_RESULT_REFERENCE_INVALID');
  expect(appCalls('activity')).toHaveLength(1);
});

test('reports rejected and unreadable saves without retrying', async () => {
  let responses = [JSON.stringify({ errors: ['bad'], id: '0' }), 'not json'];
  upstream.use(http.post(`${app}/activity`, () => HttpResponse.text(responses.shift()!)));
  const client = await connect();
  for (const expected of ['rejected', 'uncertain']) {
    const preview = await client.callTool({ name: 'prepare_exercise_result', arguments: { exerciseId: 18, date: today, sets: 3, reps: 5, loadKg: 80 } });
    const reference = (preview.structuredContent as { actionReference: string }).actionReference;
    const result = await client.callTool({ name: 'execute_exercise_result', arguments: { actionReference: reference, confirmed: true } });
    expect(result.structuredContent).toMatchObject({ status: expected, activityId: null });
  }
  expect(appCalls('activity')).toHaveLength(2);
  responses = [];
});

test('rejects future dates and invalid loads before any request', async () => {
  const client = await connect();
  for (const args of [{ exerciseId: 18, date: '2999-01-01', sets: 1, reps: 1, loadKg: 50 }, { exerciseId: 18, date: today, sets: 1, reps: 1, loadKg: 50.1 }]) {
    const result = await client.callTool({ name: 'prepare_exercise_result', arguments: args });
    expect(result.isError).toBe(true);
  }
  expect(appCalls('activity')).toHaveLength(0);
});

describe('deleting an own activity', () => {
  let calendarIds: number[] = [];
  const detail = (id: number) => ({ userId: 42, boxId: 200, recordDate: spanish(today), publishDate: null,
    TIPOWODs: [{ type: 6, deleted: false, notes: null }], ejerRate: [{ ejerName: 'Back Squat', ejerId: 64, tipoWOD: 0, valor1: ['1'], valor2: '90', formaReg: 4, tipoud: 0 }], id });
  beforeEach(() => {
    calendarIds = [555];
    upstream.use(
      http.get('https://aimharder.es/api/activityCalendar', () => HttpResponse.json({ workouts: calendarIds.length ? { [today]: { rates: { ids: calendarIds }, TIPOWODs: {} } } : [] })),
      http.get('https://aimharder.es/api/activity/workout', ({ request }) => HttpResponse.json(detail(Number(new URL(request.url).searchParams.get('SEID'))))),
      http.post(`${app}/activity/555/:token`, ({ params }) => {
        expect(params.token).toBe(issuedToken);
        calendarIds = [];
        return new HttpResponse('', { status: 200 });
      }),
    );
  });
  const deletions = () => requests.filter(r => r.method === 'POST' && r.url.pathname.startsWith('/aplic/apiExternal/activity/555/'));

  test('previews the activity without writing, then deletes it once after confirmation', async () => {
    const client = await connect();
    const preview = await client.callTool({ name: 'prepare_exercise_result_deletion', arguments: { date: today, activityId: 555 } });
    expect(preview.structuredContent).toMatchObject({ status: 'ready', activityId: 555, exercises: [{ name: 'Back Squat', sourceExerciseId: 64, sets: ['1'], load: '90' }], writeConfirmationRequired: true });
    expect(deletions()).toHaveLength(0);
    const reference = (preview.structuredContent as { actionReference: string }).actionReference;
    const unconfirmed = await client.callTool({ name: 'execute_exercise_result_deletion', arguments: { actionReference: reference } });
    expect(unconfirmed.isError).toBe(true);
    const result = await client.callTool({ name: 'execute_exercise_result_deletion', arguments: { actionReference: reference, confirmed: true } });
    expect(result.structuredContent).toMatchObject({ status: 'confirmed', preview: { activityId: 555 } });
    expect(deletions()).toHaveLength(1);
  });

  test('returns stale without sending when the activity is already gone, and missing for unknown IDs', async () => {
    const client = await connect();
    const preview = await client.callTool({ name: 'prepare_exercise_result_deletion', arguments: { date: today, activityId: 555 } });
    calendarIds = [];
    const reference = (preview.structuredContent as { actionReference: string }).actionReference;
    const result = await client.callTool({ name: 'execute_exercise_result_deletion', arguments: { actionReference: reference, confirmed: true } });
    expect(result.structuredContent).toMatchObject({ status: 'stale' });
    const missing = await client.callTool({ name: 'prepare_exercise_result_deletion', arguments: { date: today, activityId: 777 } });
    expect(missing.structuredContent).toMatchObject({ status: 'missing' });
    expect(deletions()).toHaveLength(0);
  });

  test('reports uncertain when the activity is still listed after the request', async () => {
    upstream.use(http.post(`${app}/activity/555/:token`, () => new HttpResponse('', { status: 200 })));
    const client = await connect();
    const preview = await client.callTool({ name: 'prepare_exercise_result_deletion', arguments: { date: today, activityId: 555 } });
    const reference = (preview.structuredContent as { actionReference: string }).actionReference;
    const result = await client.callTool({ name: 'execute_exercise_result_deletion', arguments: { actionReference: reference, confirmed: true } });
    expect(result.structuredContent).toMatchObject({ status: 'uncertain' });
    expect(deletions()).toHaveLength(1);
  });
});

describe('filtering participants to followed athletes', () => {
  const participantsArgs = { date: '2026-11-05', className: 'CROSS', startTime: '14:00' };
  beforeEach(() => {
    upstream.use(http.get(`${app}/user/list`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect([params.get('type'), params.get('relId'), params.get('token')]).toEqual(['1', '42', issuedToken]);
      // Page 0: the gym account and one athlete; page 1 ends the list.
      return HttpResponse.json(params.get('page') === '0'
        ? { type: 1, relId: '42', users: [{ id: 300, isBox: 1, name: 'Sample Gym' }, { id: 77, isBox: 0, name: 'Training Partner' }] }
        : { type: 1, relId: '42', users: [] });
    }));
  });
  type Filtered = Participants & { filter: string; totalParticipants: number; notices: string[] };

  test('returns only followed athletes, reading every page and ignoring gym accounts', async () => {
    const result = await (await connect()).callTool({ name: 'get_class_participants', arguments: { ...participantsArgs, filter: 'following' } });
    expect(result.isError).not.toBe(true);
    const content = result.structuredContent as Filtered;
    expect(content).toMatchObject({ status: 'available', filter: 'following', totalParticipants: 2 });
    expect(content.participants.map(p => p.userId)).toEqual([77]);
    expect(appCalls('user/list').map(r => r.url.searchParams.get('page'))).toEqual(['0', '1']);
    expect(content.notices.join(' ')).toContain('1 of 2 participants');
  });

  test('uses the configured default, and an explicit filter overrides it', async () => {
    const client = await connect({ AIMHARDER_PARTICIPANTS_FILTER: 'following' });
    const byDefault = await client.callTool({ name: 'get_class_participants', arguments: participantsArgs });
    expect((byDefault.structuredContent as Filtered).participants.map(p => p.userId)).toEqual([77]);
    const calls = appCalls('user/list').length;
    const everyone = await client.callTool({ name: 'get_class_participants', arguments: { ...participantsArgs, filter: 'all' } });
    expect(everyone.structuredContent).toMatchObject({ filter: 'all', totalParticipants: 2 });
    expect((everyone.structuredContent as Filtered).participants).toHaveLength(2);
    expect(appCalls('user/list')).toHaveLength(calls);
  });

  test('without configuration lists everyone and does not read the followed list', async () => {
    const result = await (await connect()).callTool({ name: 'get_class_participants', arguments: participantsArgs });
    expect(result.structuredContent).toMatchObject({ filter: 'all', totalParticipants: 2 });
    expect(appCalls('user/list')).toHaveLength(0);
  });

  test('a malformed followed list is an error, not an empty result', async () => {
    upstream.use(http.get(`${app}/user/list`, () => HttpResponse.json({ type: 1, people: [] })));
    const result = await (await connect()).callTool({ name: 'get_class_participants', arguments: { ...participantsArgs, filter: 'following' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('INVALID_FOLLOWING_RESPONSE');
  });

  test('adds configured friends to followed athletes, even with a private profile', async () => {
    upstream.use(http.get(`${app}/user/list`, () => HttpResponse.json({ type: 1, relId: '42', users: [] })));
    const client = await connect({ AIMHARDER_FRIENDS: '{"77":"Partner with a private profile"}' });
    const result = await client.callTool({ name: 'get_class_participants', arguments: { ...participantsArgs, filter: 'following' } });
    expect((result.structuredContent as Filtered).participants.map(p => p.userId)).toEqual([77]);
    const context = await client.callTool({ name: 'get_account_context', arguments: {} });
    expect(context.structuredContent).toMatchObject({ defaults: { friends: 1 } });
    expect(JSON.stringify(context)).not.toContain('Partner with a private profile');
  });

  test('rejects an invalid friends list', async () => {
    for (const friends of ['["77"]', '{"0":"Zero"}', '{"77":""}', 'not json']) {
      await expect(connect({ AIMHARDER_FRIENDS: friends })).rejects.toMatchObject({ code: 'INVALID_FRIENDS_CONFIGURATION' });
    }
  });

  test('rejects an invalid filter value and configuration', async () => {
    const result = await (await connect()).callTool({ name: 'get_class_participants', arguments: { ...participantsArgs, filter: 'friends' } });
    expect(result.isError).toBe(true);
    await expect(connect({ AIMHARDER_PARTICIPANTS_FILTER: 'friends' })).rejects.toMatchObject({ code: 'INVALID_PARTICIPANTS_FILTER_CONFIGURATION' });
  });
});

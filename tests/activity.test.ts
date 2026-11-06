import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

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
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({
      data: { userData: { id: 42 }, auth: { authOK: true } },
    }, { headers: { 'Set-Cookie': 'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/' } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [{ id: 42, roles: [membership()] }] })),
    http.get('https://aimharder.es/api/activityCalendar', ({ request }) => {
      expect(request.headers.get('cookie')).toContain('amhrdrauth=synthetic-cookie');
      return HttpResponse.json({ workouts: {} });
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
    AIMHARDER_TIME_ZONE: 'Europe/Madrid', ...extra,
  });
  const client = new Client({ name: 'booking-behavioral-harness', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(b); await client.connect(a);
  return client;
}
async function query(client: Client, args: Record<string, unknown> = {}) {
  return client.callTool({ name: 'get_personal_activity', arguments: { startDate: '2026-03-01', endDate: '2026-03-31', ...args } });
}

const detail = (id = 1, extra = {}) => ({ userId: 42, boxId: 200, recordDate: '29 de Marzo de 2026', publishDate: '30 de Marzo de 2026', TIPOWODs: [{ notes: 'Sentadilla Ñ', deleted: false }], ejerRate: [{ ejerName: 'Sentadilla Ñ', tipoWOD: 0, valor1: ['5'] }], ...extra });
function calendar(days: Record<string, number[]>) { return { workouts: Object.fromEntries(Object.entries(days).map(([date, ids]) => [date, { rates: { ids }, TIPOWODs: {} }])) }; }
function respond(days: Record<string, number[]>) {
 upstream.use(http.get('https://aimharder.es/api/activityCalendar', () => HttpResponse.json(calendar(days))), http.get('https://aimharder.es/api/activity/workout', () => HttpResponse.json(detail())));
}
test('retains source complex membership and repetition count in verified own activity', async () => {
 respond({ '2026-03-29': [1] });
 upstream.use(http.get('https://aimharder.es/api/activity/workout', () => HttpResponse.json(detail(1, {
  ejerRate: [
   { ejerName: 'Run', tipoWOD: 0, valor1: ['500'] },
   { ejerName: 'Movement A', tipoWOD: 0, complex: 2, complexrep: '4', valor1: ['6'] },
   { ejerName: 'Movement B', tipoWOD: 0, complex: 2, complexrep: '4', valor1: ['12'] },
   { ejerName: 'Run', tipoWOD: 0, valor1: ['500'] },
  ],
 }))));
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 expect(result.structuredContent).toMatchObject({ entries: [{ exercises: [
  { name: 'Run' }, { name: 'Movement A', prescription: { complex: 2, complexrep: '4' } },
  { name: 'Movement B', prescription: { complex: 2, complexrep: '4' } }, { name: 'Run' },
 ] }] });
});
test('retains the raw EMOM grouping selector separately from own recorded completed rounds', async () => {
 respond({ '2026-03-29': [1] });
 upstream.use(http.get('https://aimharder.es/api/activity/workout', () => HttpResponse.json(detail(1, {
  TIPOWODs: [{ deleted: false, type: 3, timecap: 1, time: 0, rondas: 2, reps: 1, res: 5 }],
 }))));
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 expect(result.structuredContent).toMatchObject({ entries: [{ blocks: [{
  prescription: { type: 3, reps: 1, timecap: 1, rondas: 2 }, result: { res: 5, reps: 1 },
 }] }] });
 expect(requests.every(request => request.method === 'GET' || request.url.pathname === '/api/login')).toBe(true);
});
test('returns personal entries with original detail, explicit dates and no session claim', async () => {
 respond({ '2026-03-29': [1, 1, 2] });
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 expect(result.structuredContent).toMatchObject({ entries: [{ sourceActivityId: 1, date: '2026-03-29', startTime: null, trainingSessionId: null, exercises: [{ name: 'Sentadilla Ñ' }] }, { sourceActivityId: 2 }], coverage: { status: 'complete', completedDates: expect.arrayContaining(['2026-03-01','2026-03-31']) } });
});
test('unused opaque calendar decoration does not block independently verified own activity', async () => {
 respond({ '2026-03-29': [1] });
 upstream.use(http.get('https://aimharder.es/api/activityCalendar', () => HttpResponse.json({ workouts: {
  '2026-03-29': { rates: { ids: [1] }, TIPOWODs: { 'anonymous-decoration': { text: 'untrusted-opaque-calendar-canary', arbitrary: ['not-an-entry-reference'] } } },
 } })));
 const result = await query(await connect(), { startDate: '2026-03-29', endDate: '2026-03-29' });
 expect(result.isError).not.toBe(true);
 expect(result.structuredContent).toMatchObject({ entries: [{ sourceActivityId: 1, date: '2026-03-29', exercises: [{ name: 'Sentadilla Ñ' }] }],
  coverage: { status: 'complete', completedDates: ['2026-03-29'], reason: null } });
 expect(JSON.stringify(result)).not.toMatch(/anonymous-decoration|untrusted-opaque-calendar-canary|not-an-entry-reference/);
 expect(requests.filter(request => request.url.pathname === '/api/activity/workout')).toHaveLength(1);
});
test.each([undefined, null, [], ['untrusted-container']])('calendar decoration still requires an object: %j', async decoration => {
 upstream.use(http.get('https://aimharder.es/api/activityCalendar', () => HttpResponse.json({ workouts: {
  '2026-03-29': { rates: { ids: [1] }, TIPOWODs: decoration },
 } })));
 const result = await query(await connect(), { startDate: '2026-03-29', endDate: '2026-03-29' });
 expect(result.isError).toBe(true);
 expect(JSON.stringify(result)).toContain('INVALID_ACTIVITY_RESPONSE');
 expect(JSON.stringify(result)).not.toContain('untrusted-container');
 expect(requests.filter(request => request.url.pathname === '/api/activity/workout')).toHaveLength(0);
});
test.each([{startDate:'2026-03-29',endDate:'2026-03-29'}, {startDate:'2026-03-01',endDate:'2026-03-31'}, {startDate:'2026-03-15',endDate:'2026-04-14'}])('accepts inclusive bounded range with DST %o', async args => {
 const result=await query(await connect(),args);expect(result.isError).not.toBe(true);expect(result.structuredContent).toMatchObject({entries:[],coverage:{status:'complete'}});
});
test.each([{startDate:'2026-03-01',endDate:'2026-04-01'},{startDate:'2026-03-02',endDate:'2026-03-01'},{startDate:'2026-02-30',endDate:'2026-03-01'}])('rejects invalid range %o before HTTP', async args => {
 expect((await query(await connect(),args)).isError).toBe(true);expect(requests).toHaveLength(0);
});
test('month partitions terminate, include both endpoints, and deduplicate identity only', async () => {
 const months: string[]=[];
 upstream.use(http.get('https://aimharder.es/api/activityCalendar', ({request}) => {
  const month=new URL(request.url).searchParams.get('month')!; months.push(month);
  return HttpResponse.json(calendar(month==='2'?{'2026-03-31':[1,1,2]}:{'2026-04-01':[3]}));
 }), http.get('https://aimharder.es/api/activity/workout', ({request}) => HttpResponse.json(detail(1,{recordDate:new URL(request.url).searchParams.get('SEID')==='3'?'1 de Abril de 2026':'31 de Marzo de 2026'}))));
 const result=await query(await connect(),{startDate:'2026-03-31',endDate:'2026-04-01'});
 expect(result.structuredContent).toMatchObject({entries:[{sourceActivityId:3},{sourceActivityId:1},{sourceActivityId:2}],coverage:{status:'complete',completedDates:['2026-03-31','2026-04-01']}});
 expect(months).toEqual(['2','3']);
 expect(requests.filter(r=>r.url.pathname==='/api/activity/workout')).toHaveLength(3);
});
test('can span three month partitions within 31 dates',async()=>{
 expect((await query(await connect(),{startDate:'2026-01-31',endDate:'2026-03-02'})).isError).not.toBe(true);
 expect(requests.filter(r=>r.url.pathname==='/api/activityCalendar').map(r=>r.url.searchParams.get('month'))).toEqual(['0','1','2']);
});
test.each([{}, {workouts:{},nextPage:2}, {workouts:{'2026-03-29':{rates:{ids:['bad']}}}}, calendar({'2026-04-01':[1]}), calendar({'2026-03-01':[1],'2026-03-02':[1]})])('malformed first partition is an error %o',async body=>{
 upstream.use(http.get('https://aimharder.es/api/activityCalendar',()=>HttpResponse.json(body)));
 expect((await query(await connect())).isError).toBe(true);
});
test.each([403,429,500])('failed first partition %s is an error',async status=>{
 upstream.use(http.get('https://aimharder.es/api/activityCalendar',()=>new HttpResponse(null,{status})));
 expect((await query(await connect())).isError).toBe(true);
});
test('retains earlier entries and only completed dates on later partition failure',async()=>{
 respond({'2026-03-29':[1]});
 upstream.use(http.get('https://aimharder.es/api/activityCalendar',({request})=>new URL(request.url).searchParams.get('month')==='2'?HttpResponse.json(calendar({'2026-03-29':[1]})):new HttpResponse(null,{status:500})));
 expect((await query(await connect(),{startDate:'2026-03-29',endDate:'2026-04-01'})).structuredContent).toMatchObject({entries:[{sourceActivityId:1}],coverage:{status:'incomplete',completedDates:['2026-03-29','2026-03-30','2026-03-31'],reason:expect.any(String)}});
});
test('keeps earlier entries from the failed day without claiming that day covered',async()=>{
 respond({'2026-03-29':[1,2]});
 upstream.use(http.get('https://aimharder.es/api/activity/workout',({request})=>new URL(request.url).searchParams.get('SEID')==='1'?HttpResponse.json(detail()):HttpResponse.json({secret:'never reflected'})));
 const result=await query(await connect(),{startDate:'2026-03-29',endDate:'2026-03-29'});
 expect(result.structuredContent).toMatchObject({entries:[{sourceActivityId:1}],coverage:{status:'incomplete',completedDates:[]}});expect(JSON.stringify(result)).not.toContain('never reflected');
});
test('filters verified other-gym activity but rejects wrong-account details',async()=>{
 respond({'2026-03-29':[1]});
 upstream.use(http.get('https://aimharder.es/api/activity/workout',()=>HttpResponse.json(detail(1,{boxId:201}))));
 expect((await query(await connect())).structuredContent).toMatchObject({entries:[],coverage:{status:'complete'}});
 upstream.use(http.get('https://aimharder.es/api/activity/workout',()=>HttpResponse.json(detail(1,{userId:43}))));
 expect((await query(await connect())).structuredContent).toMatchObject({entries:[],coverage:{status:'incomplete'}});
});
test('rejects record-date mismatch instead of using publication timing',async()=>{
 respond({'2026-03-30':[1]});
 expect((await query(await connect())).structuredContent).toMatchObject({entries:[],coverage:{status:'incomplete'}});
});
test('uses an assumed gym zone and disallows arbitrary selectors',async()=>{
 expect((await query(await connect({AIMHARDER_TIME_ZONE: undefined}))).structuredContent).toMatchObject({gym:{timeZone:'Europe/Madrid',timeZoneStatus:'assumed'}});
 expect((await query(await connect(),{gymId:'foreign'})).isError).toBe(true);
 expect((await query(await connect(),{userID:4})).isError).toBe(true);
 expect(requests.filter(r=>r.url.pathname==='/api/activityCalendar')).toHaveLength(1);
});
test('retries only the expired detail once while preserving earlier entries',async()=>{
 respond({'2026-03-29':[1,2]});let second=0;
 upstream.use(http.get('https://aimharder.es/api/activity/workout',({request})=>new URL(request.url).searchParams.get('SEID')==='2'&&++second===1?new HttpResponse(null,{status:401}):HttpResponse.json(detail())));
 const result=await query(await connect());expect(result.structuredContent).toMatchObject({entries:[{sourceActivityId:1},{sourceActivityId:2}],coverage:{status:'complete'}});
 expect(requests.filter(r=>r.url.pathname==='/api/login')).toHaveLength(2);
 expect(requests.filter(r=>r.url.searchParams.get('SEID')==='1')).toHaveLength(1);
});
test('one recovery budget spans discovery and later detail expiry',async()=>{
 respond({'2026-03-29':[1,2]});let discovery=0;
 upstream.use(http.get('https://aimharder.es/api/whoami',()=>++discovery===1?new HttpResponse(null,{status:401}):HttpResponse.json({data:[{id:42,roles:[membership()]}]})),http.get('https://aimharder.es/api/activity/workout',({request})=>new URL(request.url).searchParams.get('SEID')==='2'?new HttpResponse(null,{status:401}):HttpResponse.json(detail())));
 expect((await query(await connect())).structuredContent).toMatchObject({entries:[{sourceActivityId:1}],coverage:{status:'incomplete'}});
 expect(requests.filter(r=>r.url.pathname==='/api/login')).toHaveLength(2);
});
test.each(['expiry','login','membership','identity'])('later recovery failure %s keeps recovered entries',async failure=>{
 respond({'2026-03-29':[1,2]});let logins=0;let discoveries=0;let failures=0;
 upstream.use(http.post('https://login.aimharder.es/api/login',()=>++logins===2&&failure==='login'?new HttpResponse(null,{status:403}):HttpResponse.json({data:{userData:{id:failure==='identity'&&logins===2?43:42},auth:{authOK:true}}},{headers:{'Set-Cookie':'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/'}})), http.get('https://aimharder.es/api/whoami',()=>HttpResponse.json({data:[{id:failure==='identity'&&logins===2?43:42,roles:[membership('sample-gym',++discoveries>1&&failure==='membership'?201:200)]}]})),http.get('https://aimharder.es/api/activity/workout',({request})=>new URL(request.url).searchParams.get('SEID')==='2'&&(failure==='expiry'||++failures===1)?new HttpResponse(null,{status:401}):HttpResponse.json(detail())));
 expect((await query(await connect())).structuredContent).toMatchObject({entries:[{sourceActivityId:1}],coverage:{status:'incomplete'}});expect(logins).toBe(2);
});
test('empty array calendar is a complete empty period',async()=>{
 upstream.use(http.get('https://aimharder.es/api/activityCalendar',()=>HttpResponse.json({workouts:[]})));
 expect((await query(await connect())).structuredContent).toMatchObject({entries:[],coverage:{status:'complete'}});
});
test('the chosen verified gym uses detail membership IDs without forwarding selectors',async()=>{
 respond({'2026-03-29':[1]});
 upstream.use(http.get('https://aimharder.es/api/whoami',()=>HttpResponse.json({data:[{id:42,roles:[membership(),membership('other-gym',201)]}]})),http.get('https://aimharder.es/api/activity/workout',()=>HttpResponse.json(detail(1,{boxId:201}))));
 const result=await query(await connect({AIMHARDER_GYM:'other-gym',AIMHARDER_TIME_ZONE:'Europe/London'}));
 expect(result.structuredContent).toMatchObject({gym:{id:'other-gym'},entries:[{timeZone:'Europe/London'}],coverage:{status:'complete'}});
 for(const request of requests.filter(r=>r.url.pathname.includes('/api/activity'))) expect([...request.url.searchParams.keys()].every(k=>['month','year','SEID'].includes(k))).toBe(true);
});
test('bounded detail recovery reports the limit and never claims remaining dates',async()=>{
 respond({'2026-03-29':Array.from({length:500},(_,i)=>i+1),'2026-03-30':[501]});
 const result=await query(await connect(),{startDate:'2026-03-29',endDate:'2026-03-30'});
 expect(result.structuredContent).toMatchObject({coverage:{status:'incomplete',completedDates:['2026-03-29'],reason:expect.stringContaining('500')}});
 expect((result.structuredContent as {entries:unknown[]}).entries.length).toBe(500);
 expect(requests.filter(r=>r.url.pathname==='/api/activity/workout')).toHaveLength(500);
});

test.each([{rates:{ids:[],nextPage:[]},TIPOWODs:{}},{rates:{ids:[]},TIPOWODs:{},partial:true}])('unknown nested continuation or partial metadata is rejected',async day=>{
 upstream.use(http.get('https://aimharder.es/api/activityCalendar',()=>HttpResponse.json({workouts:{'2026-03-29':day}})));
 expect((await query(await connect())).isError).toBe(true);
});
test('conflicting identity across month partitions stops without duplicate records',async()=>{
 respond({'2026-03-29':[1]});
 upstream.use(http.get('https://aimharder.es/api/activityCalendar',({request})=>HttpResponse.json(calendar(new URL(request.url).searchParams.get('month')==='2'?{'2026-03-29':[1]}:{'2026-04-01':[1]}))));
 expect((await query(await connect(),{startDate:'2026-03-29',endDate:'2026-04-01'})).structuredContent).toMatchObject({entries:[{sourceActivityId:1}],coverage:{status:'incomplete',completedDates:['2026-03-29','2026-03-30','2026-03-31']}});
});

test('returns allowlisted block results without leaking rankings or guessing units', async () => {
 respond({ '2026-03-29': [1] });
 upstream.use(http.get('https://aimharder.es/api/activity/workout', () => HttpResponse.json(detail(1, {
  TIPOWODs: [
   { notes: 'Texto libre', deleted: false, res: null, reps: null, time: null, rx: false, rxstr: '' },
   { notes: 'Rounds For Time', deleted: false, res: null, reps: 4, time: 1234, rondas: null, rx: false, rxstr: 'SCALED', pwid: 999 },
   { notes: 'Removed', deleted: true, res: 99, reps: 99, time: 99, rx: true, rxstr: 'private-deleted-result' },
  ],
  userName: 'private-profile', PRs: { private: 'private-ranking' }, chartData: { private: 'private-chart' },
 }))));
 const result = await query(await connect());
 expect(result.isError).not.toBe(true);
 expect(result.structuredContent).toMatchObject({ entries: [{ blocks: [
  { result: { res: null, reps: null, time: null, rx: false, rxstr: '' } },
  { result: { res: null, reps: 4, time: 1234, rondas: null, rx: false, rxstr: 'SCALED' } },
  { notes: null, prescription: {}, result: {} },
 ] }], coverage: { status: 'complete' } });
 const serialized = JSON.stringify(result);
 for (const value of ['private-profile', 'private-ranking', 'private-chart', 'private-deleted-result', 'pwid']) expect(serialized).not.toContain(value);
});

test.each([{}, { res: 0, reps: 0, time: 0, rondas: 0, rx: false, rxstr: '' }, { rx: true, rxstr: 'RX' }])('preserves missing, zero and RX result fields %o', async fields => {
 respond({ '2026-03-29': [1] });
 upstream.use(http.get('https://aimharder.es/api/activity/workout', () => HttpResponse.json(detail(1, { TIPOWODs: [{ notes: '', deleted: false, ...fields }] }))));
 const result = await query(await connect());
 const entries = (result.structuredContent as { entries: { blocks: { result: unknown }[] }[] }).entries;
 expect(entries[0]!.blocks[0]!.result).toEqual(fields);
});

test.each([{ res: {} }, { reps: 'unknown' }, { rxstr: [] }])('invalid result data preserves earlier entries with incomplete coverage %o', async fields => {
 respond({ '2026-03-29': [1, 2] });
 upstream.use(http.get('https://aimharder.es/api/activity/workout', ({ request }) => HttpResponse.json(detail(1,
  new URL(request.url).searchParams.get('SEID') === '2' ? { TIPOWODs: [{ notes: '', deleted: false, ...fields }] } : {},
 ))));
 expect((await query(await connect(), { startDate: '2026-03-29', endDate: '2026-03-29' })).structuredContent).toMatchObject({
  entries: [{ sourceActivityId: 1 }], coverage: { status: 'incomplete', completedDates: [] },
 });
});



test('joins result descriptions by block ID and activity ID, excluding unrelated history', async () => {
 respond({ '2026-03-29': [1] });
 upstream.use(http.get('https://aimharder.es/api/activity/workout', () => HttpResponse.json(detail(1, {
  TIPOWODs: [{ id: 81, deleted: false }, { id: 82, deleted: false }, { id: 83, deleted: true }],
  chartData: {
   81: [{ idAction: 2, desc: 'private-history' }, { idAction: 1, desc: '7R', unrelated: 'private-extra' }],
   82: [{ idAction: 1, desc: 'custom gym notation' }],
   83: [{ idAction: 1, desc: 'private-deleted' }],
   84: [{ idAction: 1, desc: 'private-other-block' }],
  },
 }))));
 const client = await connect();
 const result = await query(client);
 expect(result.structuredContent).toMatchObject({ entries: [{ blocks: [{ result: { desc: '7R' } }, { result: { desc: 'custom gym notation' } }, { result: {} }] }], coverage: { status: 'complete' } });
 expect(JSON.stringify(result)).not.toContain('private-');
});

test.each([
 [[], {}],
 [[{ idAction: 2, desc: 'other activity' }], {}],
 [[{ idAction: 1, desc: null }], { desc: null }],
 [[{ idAction: 1, desc: '' }], { desc: '' }],
 [[{ idAction: 1, desc: '7R' }, { idAction: 1, desc: '7R' }], { desc: '7R' }],
])('preserves absent, null, empty and duplicate matching descriptions', async (rows, expected) => {
 respond({ '2026-03-29': [1] });
 upstream.use(http.get('https://aimharder.es/api/activity/workout', () => HttpResponse.json(detail(1, {
  TIPOWODs: [{ id: 81, deleted: false }], chartData: { 81: rows },
 }))));
 const result = await query(await connect());
 expect((result.structuredContent as { entries: { blocks: { result: unknown }[] }[] }).entries[0]!.blocks[0]!.result).toEqual(expected);
});

test.each([{ rows: [{ idAction: 1, desc: 7 }] }, { rows: [{ idAction: 1, desc: '7R' }, { idAction: 1, desc: '8R' }] }])('invalid or conflicting current descriptions cause incomplete coverage', async ({ rows }) => {
 respond({ '2026-03-29': [1] });
 upstream.use(http.get('https://aimharder.es/api/activity/workout', () => HttpResponse.json(detail(1, {
  TIPOWODs: [{ id: 81, deleted: false }], chartData: { 81: rows },
 }))));
 expect((await query(await connect())).structuredContent).toMatchObject({ entries: [], coverage: { status: 'incomplete' } });
});

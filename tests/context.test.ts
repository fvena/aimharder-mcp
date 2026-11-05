import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const username = 'account@example.invalid';
const password = 'synthetic-password';
const cookie = 'synthetic-cookie';
const loginUrl = 'https://login.aimharder.es/api/login';
const whoamiUrl = 'https://aimharder.es/api/whoami';
const gym = (slug = 'sample-gym', name = 'Gimnasio de prueba') => ({
  id: 100, role: 'client', gym: name, centre_url: `${slug}.aimharder.es`, boid: 200,
  perm_hash: 'synthetic-permission-token',
});
const account = (roles: unknown[] = [gym()]) => ({
  id: 42, name: 'Private Fixture Name', photo: 'private-photo', roles,
});
const login = () => HttpResponse.json({
  data: { userData: account(), auth: { authOK: true, refreshToken: 'synthetic-refresh-token' } },
}, { headers: { 'Set-Cookie': `amhrdrauth=${cookie}; Domain=.aimharder.es; Path=/; HttpOnly` } });
const requests: { method: string; url: string; cookie: string | null }[] = [];
const upstream = setupServer();
const connections: { client: Client; server: ReturnType<typeof createServer> }[] = [];

beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  requests.length = 0;
  upstream.use(
    http.post(loginUrl, async ({ request }) => {
      expect(await request.json()).toMatchObject({ username, password, iniframe: 0 });
      return login();
    }),
    http.get(whoamiUrl, ({ request }) => {
      expect(request.headers.get('cookie')).toContain(`amhrdrauth=${cookie}`);
      return HttpResponse.json({ data: [account()] });
    }),
  );
});
upstream.events.on('request:start', ({ request }) => {
  requests.push({ method: request.method, url: request.url, cookie: request.headers.get('cookie') });
});
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
  upstream.resetHandlers();
});
afterAll(() => upstream.close());

async function connect(extra: Record<string, string> = {}) {
  const server = createServer({ AIMHARDER_USERNAME: username, AIMHARDER_PASSWORD: password, ...extra });
  const client = new Client({ name: 'behavioral-harness', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
async function query(client: Client, args: Record<string, unknown> = {}) {
  return client.callTool({ name: 'get_account_context', arguments: args });
}

test('discovers the only gym through MCP, preserves its name, and reuses the session', async () => {
  const client = await connect();
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual(['get_account_context', 'get_class_sessions', 'get_class_participants', 'prepare_booking_creation', 'execute_booking_creation', 'prepare_booking_cancellation', 'execute_booking_cancellation', 'execute_late_booking_cancellation', 'get_upcoming_bookings', 'get_booking_history', 'get_published_workouts', 'get_published_workouts_range', 'prepare_exercise_result', 'execute_exercise_result', 'prepare_exercise_result_deletion', 'execute_exercise_result_deletion', 'get_exercise_1rm', 'find_exercise_1rm', 'get_exercise_rm_progression', 'get_personal_activity']);
  const result = await query(client);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    account: { authenticated: true },
    selectedGym: { id: 'sample-gym', name: 'Gimnasio de prueba', timeZone: 'Europe/Madrid', timeZoneStatus: 'assumed' },
    gyms: [{ id: 'sample-gym' }],
  });
  for (const privateValue of [username, password, cookie, 'Private Fixture Name', 'private-photo', 'synthetic-refresh-token', 'synthetic-permission-token']) {
    expect(JSON.stringify(result)).not.toContain(privateValue);
  }
  await query(client);
  expect(requests.map(({ method, url }) => [method, url])).toEqual([
    ['POST', loginUrl], ['GET', whoamiUrl], ['GET', whoamiUrl],
  ]);
});

test('requires a valid default for several gyms and allows a per-query override', async () => {
  upstream.use(http.get(whoamiUrl, () => HttpResponse.json({ data: [account([gym(), gym('second-gym', 'Segundo gimnasio')])] })));
  const missing = await query(await connect());
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing)).toContain('DEFAULT_GYM_REQUIRED');
  const client = await connect({ AIMHARDER_DEFAULT_GYM: 'sample-gym' });
  expect((await query(client)).structuredContent).toMatchObject({ selectedGym: { id: 'sample-gym' } });
  expect((await query(client, { gymId: 'second-gym' })).structuredContent).toMatchObject({ selectedGym: { id: 'second-gym' } });
  expect((await query(client)).structuredContent).toMatchObject({ selectedGym: { id: 'sample-gym' } });
});

test('recovers an expired session once and stops when the retry also expires', async () => {
  let calls = 0;
  upstream.use(http.get(whoamiUrl, () => HttpResponse.json({ data: calls++ === 0 ? [] : [account()] })));
  expect((await query(await connect())).isError).not.toBe(true);
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(2);
  requests.length = 0;
  upstream.use(http.get(whoamiUrl, () => HttpResponse.json({ data: [] })));
  const result = await query(await connect());
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('SESSION_EXPIRED');
  expect(requests.map((r) => r.method)).toEqual(['POST', 'GET', 'POST', 'GET']);
});

test.each([
  { AIMHARDER_USERNAME: '' }, { AIMHARDER_PASSWORD: '   ' },
  { AIMHARDER_DEFAULT_GYM: '' }, { AIMHARDER_DEFAULT_GYM: 'https://untrusted.invalid' },
])('rejects invalid required configuration before network access: %j', async (extra) => {
  await expect(connect(extra)).rejects.toThrow('Set AIMHARDER_USERNAME');
  expect(requests).toHaveLength(0);
});

test('rejects missing credentials before exposing tools', () => {
  expect(() => createServer({})).toThrow('Set AIMHARDER_USERNAME');
  expect(requests).toHaveLength(0);
});

test('rejects unknown explicit and configured gyms without requesting their hosts', async () => {
  const client = await connect();
  const result = await query(client, { gymId: 'unverified-gym' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('GYM_NOT_ACCESSIBLE');
  const invalidDefault = await query(await connect({ AIMHARDER_DEFAULT_GYM: 'unverified-gym' }), { gymId: 'sample-gym' });
  expect(invalidDefault.isError).toBe(true);
  expect(requests.every((r) => [loginUrl, whoamiUrl].includes(r.url))).toBe(true);
});

test('includes discovered gym IDs when a default needs configuring', async () => {
  upstream.use(http.get(whoamiUrl, () => HttpResponse.json({ data: [account([gym(), gym('second-gym')])] })));
  const result = await query(await connect(), { gymId: 'sample-gym' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('second-gym');
});

test.each([
  { data: [account([])] },
  { data: [account([{ ...gym(), role: 'admin' }])] },
  { data: [account([{ ...gym(), centre_url: 'https://evil.invalid' }])] },
  { data: [account([{ ...gym(), gym: null }])] },
  { data: [account([{ ...gym(), centre_url: 'other.aimharder.com' }])] },
  { data: [account([gym(), gym('sample-gym', 'Conflicting name')])] },
  { data: [account(), account()] },
  { data: [{ ...account(), id: 99 }] },
  { data: [{ id: 42 }] },
  { data: {} },
  { data: null },
  {},
])('rejects unsupported or malformed discovery without retrying: %#', async (body) => {
  upstream.use(http.get(whoamiUrl, () => HttpResponse.json(body)));
  expect((await query(await connect())).isError).toBe(true);
  expect(requests.map((r) => r.method)).toEqual(['POST', 'GET']);
});

test('deduplicates identical memberships and preserves the original gym name', async () => {
  upstream.use(http.get(whoamiUrl, () => HttpResponse.json({ data: [account([gym('sample-gym', '  Gimnasio Ñ  '), gym('sample-gym', '  Gimnasio Ñ  ')])] })));
  const result = await query(await connect());
  expect(result.structuredContent).toMatchObject({ gyms: [{ name: '  Gimnasio Ñ  ' }] });
  expect((result.structuredContent as { gyms: unknown[] }).gyms).toHaveLength(1);
});

test.each([401, 403, 429, 500])('stops on login HTTP %s and does not repeat authentication on the next tool call', async (status) => {
  upstream.use(http.post(loginUrl, () => HttpResponse.json({ error: password }, { status })));
  const client = await connect();
  for (let i = 0; i < 2; i++) {
    const result = await query(client);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(password);
  }
  expect(requests.map((r) => r.method)).toEqual(['POST']);
});

test.each([
  { error: 'private-account@example.invalid', password },
  { data: { auth: { authOK: false }, challenge: 'two-factor', token: cookie } },
  { data: { auth: { authOK: true }, userData: { id: '42' } } },
  { data: { auth: { authOK: true }, userData: { id: 42 } } },
])('stops on unsupported login/challenge or missing usable cookie: %#', async (body) => {
  upstream.use(http.post(loginUrl, () => HttpResponse.json(body)));
  const result = await query(await connect());
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('AUTHENTICATION_FAILED');
  expect(requests).toHaveLength(1);
});

test('stops if reauthentication is rejected', async () => {
  let logins = 0;
  upstream.use(
    http.post(loginUrl, () => logins++ === 0 ? login() : HttpResponse.json({ error: password }, { status: 401 })),
    http.get(whoamiUrl, () => HttpResponse.json({ data: [] })),
  );
  expect((await query(await connect())).isError).toBe(true);
  expect(requests.map((r) => r.method)).toEqual(['POST', 'GET', 'POST']);
});

test('bounds recovery of HTTP 401 and sends a new cookie on the query retry', async () => {
  let logins = 0;
  let queries = 0;
  upstream.use(
    http.post(loginUrl, () => {
      const response = login();
      response.headers.set('Set-Cookie', `amhrdrauth=session-${++logins}; Domain=.aimharder.es; Path=/; HttpOnly`);
      return response;
    }),
    http.get(whoamiUrl, () => ++queries === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json({ data: [account()] })),
  );
  expect((await query(await connect())).isError).not.toBe(true);
  expect(requests.map((r) => r.cookie)).toEqual([null, 'amhrdrauth=session-1', null, 'amhrdrauth=session-2']);
});

test.each([403, 429, 500])('does not reauthenticate on query HTTP %s', async (status) => {
  upstream.use(http.get(whoamiUrl, () => HttpResponse.json({ error: cookie }, { status })));
  const result = await query(await connect());
  expect(result.isError).toBe(true);
  expect(requests).toHaveLength(2);
});

test.each([loginUrl, whoamiUrl])('does not follow redirects or forward secrets from %s', async (url) => {
  upstream.use(http.all(url, () => new HttpResponse(null, { status: 307, headers: { Location: 'https://evil.invalid/collect' } })));
  const result = await query(await connect());
  expect(result.isError).toBe(true);
  expect(requests.every((r) => [loginUrl, whoamiUrl].includes(r.url))).toBe(true);
});

test.each([
  new HttpResponse('<html>private-account@example.invalid synthetic-cookie</html>'),
  new HttpResponse('{"private":"synthetic-password"'),
  new HttpResponse('x'.repeat(1_048_577)),
  HttpResponse.error(),
])('returns safe errors for invalid bodies and network failures: %#', async (response) => {
  upstream.use(http.get(whoamiUrl, () => response));
  const result = await query(await connect());
  expect(result.isError).toBe(true);
  for (const secret of [password, cookie, 'private-account@example.invalid']) {
    expect(JSON.stringify(result)).not.toContain(secret);
  }
  expect(requests).toHaveLength(2);
});

test('handles concurrent MCP requests with one account session', async () => {
  const client = await connect();
  const results = await Promise.all([query(client), query(client), query(client)]);
  expect(results.every((result) => result.isError !== true)).toBe(true);
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
});

test('does not log private upstream data on success or error', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let output = '';
  try {
    const client = await connect();
    await query(client);
    upstream.use(http.get(whoamiUrl, () => HttpResponse.json({ error: { password, cookie, name: 'Private Fixture Name' } }, { status: 500 })));
    const result = await query(client);
    output = JSON.stringify([stdout.mock.calls, stderr.mock.calls, result]);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  for (const value of [username, password, cookie, 'Private Fixture Name', 'synthetic-refresh-token', 'synthetic-permission-token']) {
    expect(output).not.toContain(value);
  }
});

test.each([
  'amhrdrauth=synthetic-cookie; Domain=evil.invalid; Path=/',
  'amhrdrauth=synthetic-cookie; Path=/',
  'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/other',
  'amhrdrauth=synthetic-cookie; Domain=.aimharder.es; Path=/; Max-Age=0',
])('rejects unusable or invalid cookie scope: %#', async (setCookie) => {
  upstream.use(http.post(loginUrl, () => {
    const response = login();
    response.headers.set('Set-Cookie', setCookie);
    return response;
  }));
  expect((await query(await connect())).isError).toBe(true);
  expect(requests).toHaveLength(1);
});

test('refreshes membership discovery instead of caching access across queries', async () => {
  const client = await connect();
  expect((await query(client)).isError).not.toBe(true);
  upstream.use(http.get(whoamiUrl, () => HttpResponse.json({ data: [account([gym('new-gym')])] })));
  expect((await query(client, { gymId: 'sample-gym' })).isError).toBe(true);
  expect((await query(client)).structuredContent).toMatchObject({ selectedGym: { id: 'new-gym' } });
  expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
});

test.each([{ gymId: 'https://evil.invalid' }, { gymId: 123 }, { extra: 'unexpected' }])('rejects invalid MCP tool arguments before authentication: %#', async (args) => {
  const result = await query(await connect(), args);
  expect(result.isError).toBe(true);
  expect(requests).toHaveLength(0);
});

test.each([undefined, 'true', 'false'])('account context reports write confirmation configuration %s', async value => {
 const client=await connect(value === undefined ? {} : { AIMHARDER_REQUIRE_BOOKING_CONFIRMATION: value });
 expect((await query(client)).structuredContent).toMatchObject({writeConfirmationPolicy:{bookingCreation:value !== 'false'}});
});
test.each(['', '0', 'yes', 'FALSE'])('invalid confirmation configuration %s is rejected before authentication', value => {
 expect(()=>createServer({AIMHARDER_USERNAME:username,AIMHARDER_PASSWORD:password,AIMHARDER_REQUIRE_BOOKING_CONFIRMATION:value})).toThrow();
 expect(requests).toHaveLength(0);
});

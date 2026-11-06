import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, type Server } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../src/http-server.js';

const username = 'account@example.invalid';
const password = 'synthetic-password';
const ownerSecret = 'synthetic-owner-secret-0123456789';
const cookie = 'synthetic-cookie';
const claudeCallback = 'https://claude.ai/api/mcp/auth_callback';
const account = { id: 42, name: 'Private Fixture Name', photo: 'private-photo', roles: [{
  id: 100, role: 'client', gym: 'Gimnasio de prueba', centre_url: 'sample-gym.aimharder.es', boid: 200, perm_hash: 'synthetic-permission-token',
}] };

const upstream = setupServer(http.all(/^http:\/\/(localhost|127\.0\.0\.1):\d+\//, () => passthrough()));
const servers: { server: HttpServer; close: () => void }[] = [];
let port = 0;
let dataDir = '';

beforeAll(() => upstream.listen({ onUnhandledFrame: 'error' }));
beforeEach(async () => {
  port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), 'aimharder-mcp-test-'));
  upstream.use(
    http.post('https://login.aimharder.es/api/login', () => HttpResponse.json({
      data: { userData: account, auth: { authOK: true, refreshToken: 'synthetic-refresh-token' } },
    }, { headers: { 'Set-Cookie': `amhrdrauth=${cookie}; Domain=.aimharder.es; Path=/; HttpOnly` } })),
    http.get('https://aimharder.es/api/whoami', () => HttpResponse.json({ data: [account] })),
  );
});
afterEach(async () => {
  await stopAll();
  rmSync(dataDir, { recursive: true, force: true });
  upstream.resetHandlers();
});
afterAll(() => upstream.close());

async function stopAll() {
  for (const { server, close } of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    close();
  }
  // Let the client's keep-alive pool see the closed sockets before the next server takes the port.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function freePort() {
  return new Promise<number>((resolve) => {
    const probe: Server = createNetServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

const environment = (extra: Record<string, string> = {}) => ({
  AIMHARDER_USERNAME: username, AIMHARDER_PASSWORD: password,
  MCP_PUBLIC_URL: `http://localhost:${port}`, MCP_OWNER_SECRET: ownerSecret, PORT: String(port), MCP_DATA_DIR: dataDir, ...extra,
});

async function start(extra: Record<string, string> = {}) {
  const { app, config, close } = createHttpApp(environment(extra));
  const server = await new Promise<HttpServer>((resolve) => { const s = app.listen(config.port, '127.0.0.1', () => resolve(s)); });
  servers.push({ server, close });
  return `http://localhost:${port}`;
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(base: string, redirectUris = [claudeCallback]) {
  return fetch(`${base}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'Claude', token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'] }),
  });
}

async function authorize(base: string, clientId: string, challenge: string) {
  const url = new URL(`${base}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: claudeCallback, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'synthetic-state', resource: `${base}/mcp`,
  })) url.searchParams.set(key, value);
  const page = await fetch(url);
  expect(page.status).toBe(200);
  const html = await page.text();
  const approval = /name="approval" value="([^"]+)"/.exec(html)?.[1];
  expect(approval).toBeDefined();
  return { html, approval: approval! };
}

const approve = (base: string, approval: string, user = username, secret = password) => fetch(`${base}/authorize/approve`, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ approval, username: user, password: secret }),
});

const token = (base: string, body: Record<string, string>) => fetch(`${base}/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
});

/** Run the whole connector flow the way Claude or ChatGPT does and return the issued tokens. */
async function connectOwner(base: string, user = username, secret = password) {
  const registration = await (await register(base)).json() as { client_id: string; client_secret: string };
  const { verifier, challenge } = pkce();
  const { approval } = await authorize(base, registration.client_id, challenge);
  const approved = await approve(base, approval, user, secret);
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get('location')!);
  expect(location.origin + location.pathname).toBe(claudeCallback);
  expect(location.searchParams.get('state')).toBe('synthetic-state');
  const code = location.searchParams.get('code')!;
  const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: claudeCallback, resource: `${base}/mcp`, client_id: registration.client_id, client_secret: registration.client_secret };
  const response = await token(base, exchange);
  expect(response.status).toBe(200);
  const tokens = await response.json() as { access_token: string; refresh_token: string; token_type: string };
  return { registration, exchange, tokens };
}

async function mcpClient(base: string, accessToken: string) {
  const client = new Client({ name: 'http-harness', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

test('advertises OAuth discovery for the MCP endpoint', async () => {
  const base = await start();
  const unauthorized = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('www-authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [`${base}/`] });
  const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  expect(metadata).toMatchObject({
    issuer: `${base}/`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'],
  });
});

test('connects a client approved with the owner\'s AimHarder account and serves the tools', async () => {
  const base = await start();
  const { tokens } = await connectOwner(base);
  expect(tokens.token_type).toBe('Bearer');
  const client = await mcpClient(base, tokens.access_token);
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toContain('get_account_context');
  const result = await client.callTool({ name: 'get_account_context', arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ gym: { id: 'sample-gym' }, settingsUrl: `${base}/settings` });
  for (const privateValue of [password, cookie, ownerSecret]) expect(JSON.stringify(result)).not.toContain(privateValue);
  await client.close();
});

test('rejects a wrong password, or the owner secret, without issuing a code', async () => {
  const base = await start();
  const registration = await (await register(base)).json() as { client_id: string };
  const { approval } = await authorize(base, registration.client_id, pkce().challenge);
  for (const secret of ['not-the-password', ownerSecret]) {
    const denied = await approve(base, approval, username, secret);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('location')).toBeNull();
    expect(await denied.text()).toContain('no son correctos');
  }
  const forged = await approve(base, 'forged-approval');
  expect(forged.status).toBe(400);
});

test('limits failed sign-in attempts', async () => {
  const base = await start();
  const registration = await (await register(base)).json() as { client_id: string };
  const { approval } = await authorize(base, registration.client_id, pkce().challenge);
  for (let attempt = 0; attempt < 10; attempt += 1) expect((await approve(base, approval, username, 'wrong-password')).status).toBe(401);
  expect((await approve(base, approval)).status).toBe(429);
});

test('accepts only Claude, ChatGPT, configured or loopback redirect URIs', async () => {
  const base = await start({ MCP_OAUTH_REDIRECT_URIS: 'https://client.example.invalid/callback' });
  expect((await register(base, ['https://attacker.example.invalid/callback'])).status).toBe(400);
  expect((await register(base, ['https://chatgpt.com/connector/oauth/test-callback'])).status).toBe(201);
  expect((await register(base, ['https://chatgpt.com/connector/oauth/test-callback?next=elsewhere'])).status).toBe(400);
  expect((await register(base, ['https://chatgpt.com/connector_platform_oauth_redirect'])).status).toBe(201);
  expect((await register(base, ['https://client.example.invalid/callback'])).status).toBe(201);
  expect((await register(base, ['http://127.0.0.1:43210/callback'])).status).toBe(201);
  const registration = await (await register(base)).json() as { client_id: string };
  const other = new URL(`${base}/authorize`);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: registration.client_id, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_challenge: pkce().challenge, code_challenge_method: 'S256' })) other.searchParams.set(key, value);
  expect((await fetch(other)).status).toBe(400);
});

test('uses each authorization code once, rotates refresh tokens and rejects tampered tokens', async () => {
  const base = await start();
  const { registration, exchange, tokens } = await connectOwner(base);
  const replay = await token(base, exchange);
  expect(replay.status).toBe(400);
  expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
  const refreshed = await token(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: registration.client_id, client_secret: registration.client_secret });
  expect(refreshed.status).toBe(200);
  const next = await refreshed.json() as { access_token: string };
  const client = await mcpClient(base, next.access_token);
  await client.close();
  for (const bad of [tokens.refresh_token, `${tokens.access_token.slice(0, -2)}xx`]) {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${bad}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(response.status).toBe(401);
  }
});

test('revokes every connection when the owner secret changes, and keeps them across restarts', async () => {
  const base = await start();
  const { tokens } = await connectOwner(base);
  await stopAll();
  await start();
  const kept = await mcpClient(base, tokens.access_token);
  await kept.close();
  await stopAll();
  await start({ MCP_OWNER_SECRET: 'another-synthetic-owner-secret' });
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(401);
});

test('rejects requests for other host names', async () => {
  const base = await start();
  const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
  expect(response.status).toBe(403);
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
});

test('validates the HTTP configuration before listening', () => {
  for (const extra of [
    { MCP_OWNER_SECRET: 'short' },
    { MCP_PUBLIC_URL: 'http://example.invalid' },
    { MCP_PUBLIC_URL: 'https://example.invalid/mcp' },
    { PORT: '70000' },
    { MCP_OAUTH_REDIRECT_URIS: 'http://example.invalid/callback' },
  ]) expect(() => createHttpApp(environment(extra))).toThrow(expect.objectContaining({ code: 'INVALID_HTTP_CONFIGURATION' }));
  expect(() => createHttpApp({ ...environment(), AIMHARDER_PASSWORD: '' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
});

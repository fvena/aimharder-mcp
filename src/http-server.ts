import { scryptSync } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { Accounts, ownerSub } from './accounts.js';
import { readConfiguration, readHttpConfiguration } from './config.js';
import { AccountsOAuthProvider, sendApprovalPage } from './oauth.js';
import { createServerForContext } from './server.js';
import { Store } from './store.js';
import { webRouter } from './web/routes.js';

/** Keys derived from MCP_OWNER_SECRET: one signs OAuth and session tokens, the other encrypts members' credentials. */
function deriveKey(secret: string, purpose: string) {
  return scryptSync(secret, `aimharder-mcp/${purpose}/v1`, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/**
 * The remote transport: Streamable HTTP at `/mcp` for the owner and the members they invited, behind an OAuth server
 * where each person signs in with their AimHarder account, plus the web pages for invitations and settings.
 *
 * Stateless MCP: each request gets its own MCP server over the signed-in account's context, so preview references
 * survive across requests and connections. Run a single instance: previews and AimHarder sessions live in memory, and
 * members, invitations and settings live in one SQLite file under MCP_DATA_DIR.
 */
export function createHttpApp(environment: Record<string, string | undefined>) {
  const config = readHttpConfiguration(environment);
  const store = new Store(config.dataDir, deriveKey(config.ownerSecret, 'credentials-key'));
  const accounts = new Accounts(readConfiguration(environment), store, new URL('/settings', config.publicUrl).href);
  const provider = new AccountsOAuthProvider(config, accounts, deriveKey(config.ownerSecret, 'oauth-signing-key'));
  const app = express();
  app.disable('x-powered-by');
  // TLS ends at the hosting proxy (or tunnel) in front of this process; trust its client address for rate limits.
  app.set('trust proxy', 1);
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.use(hostHeaderValidation([config.publicUrl.hostname]));
  app.use(mcpAuthRouter({ provider, issuerUrl: config.publicUrl, resourceServerUrl: config.mcpUrl, resourceName: 'AimHarder MCP' }));
  // Failed sign-ins (connector approval, settings and invitations) share one limit per client address.
  const signInLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true,
    standardHeaders: true, legacyHeaders: false,
    handler: (_req, res) => { res.status(429).type('text/plain; charset=utf-8').send('Demasiados intentos fallidos. Inténtalo de nuevo dentro de 15 minutos.'); },
  });
  app.post('/authorize/approve', signInLimit, express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await provider.approve(body.approval, body.username, body.password);
    if ('redirect' in result) { res.set('Cache-Control', 'no-store').redirect(302, result.redirect); return; }
    if (result.error === 'expired') { res.status(400).type('text/plain; charset=utf-8').send('Esta autorización ha caducado. Vuelve a conectar desde tu asistente.'); return; }
    sendApprovalPage(res, { approval: result.approval, clientName: result.clientName, redirectUri: result.redirectUri, denial: result.reason });
  });
  const auth = requireBearerAuth({
    verifier: provider, expectedResource: config.mcpUrl,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  });
  app.all('/mcp', auth, express.json({ limit: '1mb' }), async (req, res) => {
    const sub = typeof req.auth?.extra?.sub === 'string' ? req.auth.extra.sub : ownerSub;
    const ctx = accounts.context(sub);
    if (!ctx) { res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Sign in again' }, id: null }); return; }
    const server = createServerForContext(ctx);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  app.use(webRouter(config, accounts, provider, signInLimit));
  return { app, config, close: () => store.close() };
}

/** Start listening; resolves once the port is bound. */
export async function startHttpServer(environment: Record<string, string | undefined>) {
  const { app, config } = createHttpApp(environment);
  return new Promise<{ server: Server; config: typeof config }>((resolve, reject) => {
    const server = app.listen(config.port, config.host, (error?: Error) => (error ? reject(error) : resolve({ server, config })));
  });
}

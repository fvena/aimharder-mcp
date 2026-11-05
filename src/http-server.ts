import type { Server } from 'node:http';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { readHttpConfiguration } from './config.js';
import { OwnerOAuthProvider, sendApprovalPage } from './oauth.js';
import { createServerFactory } from './server.js';

/**
 * The remote transport: Streamable HTTP at `/mcp`, protected by the owner's OAuth server.
 *
 * Stateless: each request gets its own MCP server over one shared account context, so preview references
 * survive across requests and connections. Run a single instance; previews and AimHarder sessions live in memory.
 */
export function createHttpApp(environment: Record<string, string | undefined>) {
  const config = readHttpConfiguration(environment);
  const newServer = createServerFactory(environment);
  const provider = new OwnerOAuthProvider(config);
  const app = express();
  app.disable('x-powered-by');
  // TLS ends at the hosting proxy (or tunnel) in front of this process; trust its client address for rate limits.
  app.set('trust proxy', 1);
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.use(hostHeaderValidation([config.publicUrl.hostname]));
  app.use(mcpAuthRouter({ provider, issuerUrl: config.publicUrl, resourceServerUrl: config.mcpUrl, resourceName: 'AimHarder MCP' }));
  app.post('/authorize/approve',
    express.urlencoded({ extended: false, limit: '16kb' }),
    rateLimit({
      windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, keyGenerator: () => 'owner',
      standardHeaders: true, legacyHeaders: false,
      handler: (_req, res) => { res.status(429).type('text/plain').send('Too many failed attempts. Try again in 15 minutes.'); },
    }),
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await provider.approve(body.approval, body.secret);
      if ('redirect' in result) { res.set('Cache-Control', 'no-store').redirect(302, result.redirect); return; }
      if (result.error === 'expired') { res.status(400).type('text/plain').send('This authorization request expired. Start the connection again from your client.'); return; }
      sendApprovalPage(res, { approval: result.approval, clientName: result.clientName, redirectUri: result.redirectUri, error: 'Wrong owner secret.' });
    });
  const auth = requireBearerAuth({
    verifier: provider, expectedResource: config.mcpUrl,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  });
  app.all('/mcp', auth, express.json({ limit: '1mb' }), async (req, res) => {
    const server = newServer();
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  return { app, config };
}

/** Start listening; resolves once the port is bound. */
export async function startHttpServer(environment: Record<string, string | undefined>) {
  const { app, config } = createHttpApp(environment);
  return new Promise<{ server: Server; config: typeof config }>((resolve, reject) => {
    const server = app.listen(config.port, config.host, (error?: Error) => (error ? reject(error) : resolve({ server, config })));
  });
}

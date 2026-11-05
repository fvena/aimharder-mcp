import { createHash, createHmac, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { isAllowedRedirectUri, type HttpConfiguration } from './config.js';

const accessTokenSeconds = 60 * 60;
const refreshTokenSeconds = 30 * 24 * 60 * 60;
const codeSeconds = 5 * 60;
const approvalSeconds = 10 * 60;

const registrationClaims = z.object({
  kind: z.literal('client'), redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().max(200).optional(), public: z.boolean(), iat: z.number(),
});
const approvalClaims = z.object({
  kind: z.literal('approval'), client_id: z.string(), redirect_uri: z.string(), code_challenge: z.string(),
  state: z.string().optional(), scope: z.string(), client_name: z.string().optional(),
});
const codeClaims = approvalClaims.extend({ kind: z.literal('code'), jti: z.string(), exp: z.number() });
const refreshClaims = z.object({ kind: z.literal('refresh'), client_id: z.string(), scope: z.string() });
const accessClaims = z.object({ kind: z.literal('access'), client_id: z.string(), scope: z.string(), exp: z.number() });

/**
 * OAuth 2.1 authorization server for a single owner, without storage.
 *
 * Client registrations, approvals, codes and tokens are HS256 tokens signed with a key derived (scrypt) from
 * MCP_OWNER_SECRET, each with its own `kind`, so a restart keeps every connection and changing the secret revokes them all.
 * Approving a client requires the owner secret. Authorization codes are single-use within this process.
 */
export class OwnerOAuthProvider implements OAuthServerProvider {
  readonly #key: Uint8Array;
  readonly #ownerDigest: Buffer;
  readonly #usedCodes = new Map<string, number>();
  readonly #issuer: string;
  readonly #resource: string;

  constructor(private readonly config: HttpConfiguration) {
    this.#key = scryptSync(config.ownerSecret, 'aimharder-mcp/oauth-signing-key/v1', 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    this.#ownerDigest = createHash('sha256').update(config.ownerSecret).digest();
    this.#issuer = config.publicUrl.href;
    this.#resource = config.mcpUrl.href;
  }

  get resource() { return this.#resource; }

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: async (clientId) => {
      const claims = await this.#verify(clientId, registrationClaims);
      if (!claims || !claims.redirect_uris.every((uri) => isAllowedRedirectUri(uri, this.config.redirectUris))) return undefined;
      return {
        client_id: clientId, client_id_issued_at: claims.iat, redirect_uris: claims.redirect_uris,
        ...(claims.client_name === undefined ? {} : { client_name: claims.client_name }),
        token_endpoint_auth_method: claims.public ? 'none' : 'client_secret_post',
        ...(claims.public ? {} : { client_secret: this.#clientSecret(clientId), client_secret_expires_at: 0 }),
      };
    },
    registerClient: async (client) => {
      const redirectUris = client.redirect_uris.map(String);
      if (redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every((uri) => isAllowedRedirectUri(uri, this.config.redirectUris))) {
        throw new InvalidClientMetadataError('redirect_uris must be Claude, ChatGPT, configured or loopback callback URLs');
      }
      const isPublic = client.token_endpoint_auth_method === 'none';
      const clientName = client.client_name?.slice(0, 200);
      const clientId = await this.#sign({
        kind: 'client', redirect_uris: redirectUris, public: isPublic, ...(clientName === undefined ? {} : { client_name: clientName }),
      });
      const issuedAt = Math.floor(Date.now() / 1000);
      return {
        ...client, redirect_uris: redirectUris, client_id: clientId, client_id_issued_at: issuedAt,
        token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_post',
        ...(isPublic ? { client_secret: undefined, client_secret_expires_at: undefined } : { client_secret: this.#clientSecret(clientId), client_secret_expires_at: 0 }),
      };
    },
  };

  /** Show the approval page; the owner approves with the owner secret (see `approve`). */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (params.resource && params.resource.href !== this.#resource) throw new InvalidTargetError('Unknown resource');
    const approval = await this.#sign({
      kind: 'approval', client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge,
      scope: (params.scopes ?? []).join(' '), ...(params.state === undefined ? {} : { state: params.state }),
      ...(client.client_name === undefined ? {} : { client_name: client.client_name }),
    }, approvalSeconds);
    sendApprovalPage(res, { approval, clientName: client.client_name, redirectUri: params.redirectUri });
  }

  /** Check the owner secret for a pending approval and return the redirect carrying a single-use code, or the reason it failed. */
  async approve(approval: unknown, secret: unknown): Promise<{ redirect: string } | { error: 'expired' } | { error: 'denied'; approval: string; clientName?: string | undefined; redirectUri: string }> {
    const claims = typeof approval === 'string' ? await this.#verify(approval, approvalClaims) : undefined;
    if (typeof approval !== 'string' || !claims) return { error: 'expired' };
    if (typeof secret !== 'string' || !this.#isOwnerSecret(secret)) return { error: 'denied', approval, clientName: claims.client_name, redirectUri: claims.redirect_uri };
    const code = await this.#sign({ ...claims, kind: 'code', jti: randomUUID() }, codeSeconds);
    const redirect = new URL(claims.redirect_uri);
    redirect.searchParams.set('code', code);
    if (claims.state !== undefined) redirect.searchParams.set('state', claims.state);
    redirect.searchParams.set('iss', this.#issuer);
    return { redirect: redirect.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    return (await this.#code(client, code)).code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const claims = await this.#code(client, code);
    if (redirectUri !== undefined && redirectUri !== claims.redirect_uri) throw new InvalidGrantError('redirect_uri does not match');
    if (resource && resource.href !== this.#resource) throw new InvalidTargetError('Unknown resource');
    this.#forgetExpiredCodes();
    if (this.#usedCodes.has(claims.jti)) throw new InvalidGrantError('Authorization code already used');
    this.#usedCodes.set(claims.jti, claims.exp);
    return this.#tokens(client.client_id, claims.scope);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const claims = await this.#verify(refreshToken, refreshClaims);
    if (!claims || claims.client_id !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    if (resource && resource.href !== this.#resource) throw new InvalidTargetError('Unknown resource');
    return this.#tokens(client.client_id, claims.scope);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = await this.#verify(token, accessClaims, this.#resource);
    if (!claims) throw new InvalidTokenError('Invalid access token');
    return { token, clientId: claims.client_id, scopes: claims.scope ? claims.scope.split(' ') : [], expiresAt: claims.exp, resource: new URL(this.#resource) };
  }

  async #tokens(clientId: string, scope: string): Promise<OAuthTokens> {
    return {
      access_token: await this.#sign({ kind: 'access', client_id: clientId, scope }, accessTokenSeconds, this.#resource),
      token_type: 'Bearer', expires_in: accessTokenSeconds,
      refresh_token: await this.#sign({ kind: 'refresh', client_id: clientId, scope }, refreshTokenSeconds),
      ...(scope ? { scope } : {}),
    };
  }

  async #code(client: OAuthClientInformationFull, code: string) {
    const claims = await this.#verify(code, codeClaims);
    if (!claims || claims.client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return claims;
  }

  #forgetExpiredCodes() {
    const now = Date.now() / 1000;
    for (const [jti, exp] of this.#usedCodes) if (exp < now) this.#usedCodes.delete(jti);
  }

  #isOwnerSecret(secret: string) {
    return timingSafeEqual(createHash('sha256').update(secret).digest(), this.#ownerDigest);
  }

  #clientSecret(clientId: string) {
    return createHmac('sha256', this.#key).update(`client-secret:${clientId}`).digest('base64url');
  }

  async #sign(claims: Record<string, unknown>, lifetimeSeconds?: number, audience?: string) {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuer(this.#issuer).setIssuedAt();
    if (lifetimeSeconds !== undefined) jwt = jwt.setExpirationTime(`${lifetimeSeconds}s`);
    if (audience !== undefined) jwt = jwt.setAudience(audience);
    return jwt.sign(this.#key);
  }

  async #verify<T extends z.ZodType>(token: string, schema: T, audience?: string): Promise<z.infer<T> | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.#key, { issuer: this.#issuer, algorithms: ['HS256'], ...(audience === undefined ? {} : { audience }) });
      const parsed = schema.safeParse(payload);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Approval page. The client name is untrusted and shown escaped; the redirect host shows where access is granted. */
export function sendApprovalPage(res: Response, page: { approval: string; clientName?: string | undefined; redirectUri: string; error?: string }) {
  const host = new URL(page.redirectUri).host;
  const client = page.clientName ? `<strong>${escapeHtml(page.clientName)}</strong> (${escapeHtml(host)})` : `<strong>${escapeHtml(host)}</strong>`;
  res.status(page.error ? 401 : 200)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
    .set('X-Frame-Options', 'DENY')
    .set('Referrer-Policy', 'no-referrer')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize AimHarder MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin-top:.5rem}.error{color:#b00020}</style>
</head><body><h1>Authorize AimHarder MCP</h1>
<p>${client} is asking to use this server: it can read your classes, bookings, workouts and results, and prepare bookings, cancellations and results that you confirm in the chat.</p>
${page.error ? `<p class="error">${escapeHtml(page.error)}</p>` : ''}
<form method="post" action="/authorize/approve">
<input type="hidden" name="approval" value="${escapeHtml(page.approval)}">
<label for="secret">Owner secret (MCP_OWNER_SECRET)</label>
<input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Authorize</button>
</form></body></html>`);
}

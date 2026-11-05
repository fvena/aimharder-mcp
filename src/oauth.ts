import { createHmac, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { isAllowedRedirectUri, type HttpConfiguration } from './config.js';
import { ownerSub, type Accounts, type SignInError } from './accounts.js';
import { escapeHtml, sendPublicPage, signInForm } from './web/html.js';

const accessTokenSeconds = 60 * 60;
const refreshTokenSeconds = 30 * 24 * 60 * 60;
const codeSeconds = 5 * 60;
const approvalSeconds = 10 * 60;
const sessionSeconds = 12 * 60 * 60;

const registrationClaims = z.object({
  kind: z.literal('client'), redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().max(200).optional(), public: z.boolean(), iat: z.number(),
});
const approvalClaims = z.object({
  kind: z.literal('approval'), client_id: z.string(), redirect_uri: z.string(), code_challenge: z.string(),
  state: z.string().optional(), scope: z.string(), client_name: z.string().optional(),
});
// Tokens name the account (`sub`) and its generation (`gen`). Tokens issued before accounts existed have neither and belong to the owner.
const identity = { sub: z.string().optional(), gen: z.string().optional() };
const codeClaims = approvalClaims.extend({ kind: z.literal('code'), jti: z.string(), exp: z.number(), sub: z.string(), gen: z.string() });
const refreshClaims = z.object({ kind: z.literal('refresh'), client_id: z.string(), scope: z.string(), ...identity });
const accessClaims = z.object({ kind: z.literal('access'), client_id: z.string(), scope: z.string(), exp: z.number(), ...identity });
const sessionClaims = z.object({ kind: z.literal('session'), sub: z.string(), gen: z.string() });

export type ApprovalDenial = SignInError;

/**
 * OAuth 2.1 authorization server for the owner and the members they invited.
 *
 * Client registrations, approvals, codes, tokens and web sessions are HS256 tokens signed with a key derived from
 * MCP_OWNER_SECRET, each with its own `kind`, so a restart keeps every connection and changing the secret revokes them all.
 * Approving a client requires signing in with an invited AimHarder account. A token is accepted only while its account
 * exists with the same generation. Authorization codes are single-use within this process.
 */
export class AccountsOAuthProvider implements OAuthServerProvider {
  readonly #usedCodes = new Map<string, number>();
  readonly #issuer: string;
  readonly #resource: string;

  constructor(private readonly config: HttpConfiguration, private readonly accounts: Accounts, private readonly key: Uint8Array) {
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

  /** Show the approval page; the account holder approves by signing in (see `approve`). */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (params.resource && params.resource.href !== this.#resource) throw new InvalidTargetError('Unknown resource');
    const approval = await this.#sign({
      kind: 'approval', client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge,
      scope: (params.scopes ?? []).join(' '), ...(params.state === undefined ? {} : { state: params.state }),
      ...(client.client_name === undefined ? {} : { client_name: client.client_name }),
    }, approvalSeconds);
    sendApprovalPage(res, { approval, clientName: client.client_name, redirectUri: params.redirectUri });
  }

  /** Sign in for a pending approval and return the redirect carrying a single-use code, or the reason it failed. */
  async approve(approval: unknown, username: unknown, password: unknown): Promise<{ redirect: string } | { error: 'expired' } | { error: 'denied'; reason: ApprovalDenial; approval: string; clientName?: string | undefined; redirectUri: string }> {
    const claims = typeof approval === 'string' ? await this.#verify(approval, approvalClaims) : undefined;
    if (typeof approval !== 'string' || !claims) return { error: 'expired' };
    const signedIn = typeof username === 'string' && typeof password === 'string' && username.trim() && password
      ? await this.accounts.signIn(username.trim(), password) : { error: 'credentials' as const };
    if ('error' in signedIn) return { error: 'denied', reason: signedIn.error, approval, clientName: claims.client_name, redirectUri: claims.redirect_uri };
    const gen = this.accounts.generation(signedIn.sub)!;
    const code = await this.#sign({ ...claims, kind: 'code', jti: randomUUID(), sub: signedIn.sub, gen }, codeSeconds);
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
    const sub = this.#account(claims);
    if (!sub) throw new InvalidGrantError('The account no longer has access');
    return this.#tokens(client.client_id, claims.scope, sub);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const claims = await this.#verify(refreshToken, refreshClaims);
    if (!claims || claims.client_id !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    if (resource && resource.href !== this.#resource) throw new InvalidTargetError('Unknown resource');
    const sub = this.#account(claims);
    if (!sub) throw new InvalidGrantError('The account no longer has access');
    return this.#tokens(client.client_id, claims.scope, sub);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = await this.#verify(token, accessClaims, this.#resource);
    const sub = claims && this.#account(claims);
    if (!claims || !sub) throw new InvalidTokenError('Invalid access token');
    return { token, clientId: claims.client_id, scopes: claims.scope ? claims.scope.split(' ') : [], expiresAt: claims.exp, resource: new URL(this.#resource), extra: { sub } };
  }

  /** A signed web session cookie value for the settings pages. */
  session(sub: string) {
    return this.#sign({ kind: 'session', sub, gen: this.accounts.generation(sub) }, sessionSeconds);
  }

  /** The account of a web session, while it still exists with the same generation. */
  async sessionAccount(token: string | undefined) {
    const claims = token ? await this.#verify(token, sessionClaims) : undefined;
    return claims && this.#account(claims);
  }

  static readonly sessionSeconds = sessionSeconds;

  /** The account a token belongs to, if it still exists with the generation the token was issued for. */
  #account(claims: { sub?: string | undefined; gen?: string | undefined }) {
    const sub = claims.sub ?? ownerSub;
    const current = this.accounts.generation(sub);
    return current !== undefined && current === (claims.gen ?? ownerSub) ? sub : undefined;
  }

  async #tokens(clientId: string, scope: string, sub: string): Promise<OAuthTokens> {
    const gen = this.accounts.generation(sub);
    return {
      access_token: await this.#sign({ kind: 'access', client_id: clientId, scope, sub, gen }, accessTokenSeconds, this.#resource),
      token_type: 'Bearer', expires_in: accessTokenSeconds,
      refresh_token: await this.#sign({ kind: 'refresh', client_id: clientId, scope, sub, gen }, refreshTokenSeconds),
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

  #clientSecret(clientId: string) {
    return createHmac('sha256', this.key).update(`client-secret:${clientId}`).digest('base64url');
  }

  async #sign(claims: Record<string, unknown>, lifetimeSeconds?: number, audience?: string) {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuer(this.#issuer).setIssuedAt();
    if (lifetimeSeconds !== undefined) jwt = jwt.setExpirationTime(`${lifetimeSeconds}s`);
    if (audience !== undefined) jwt = jwt.setAudience(audience);
    return jwt.sign(this.key);
  }

  async #verify<T extends z.ZodType>(token: string, schema: T, audience?: string): Promise<z.infer<T> | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: this.#issuer, algorithms: ['HS256'], ...(audience === undefined ? {} : { audience }) });
      const parsed = schema.safeParse(payload);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}

const denials: Record<ApprovalDenial, string> = {
  credentials: 'El correo o la contraseña no son correctos. Usa los mismos que en la app de AimHarder.',
  'not-invited': 'Esta cuenta de AimHarder no tiene acceso a este servidor. Pide una invitación a quien lo administra.',
  unavailable: 'No se ha podido comprobar tu cuenta porque AimHarder no responde. Inténtalo de nuevo en unos minutos.',
};

/** Approval page. The client name is untrusted and shown escaped; the redirect host shows where access is granted. */
export function sendApprovalPage(res: Response, page: { approval: string; clientName?: string | undefined; redirectUri: string; denial?: ApprovalDenial }) {
  const host = new URL(page.redirectUri).host;
  const client = page.clientName ? `<strong>${escapeHtml(page.clientName)}</strong> (${escapeHtml(host)})` : `<strong>${escapeHtml(host)}</strong>`;
  sendPublicPage(res, page.denial ? 401 : 200, 'Autorizar AimHarder MCP', `<h1>Autorizar AimHarder MCP</h1>
<section><p>${client} quiere usar este servidor con tu cuenta: podrá consultar tus clases, reservas, entrenamientos y resultados, y preparar reservas, cancelaciones y resultados que confirmarás en el chat.</p>
<p class="lead">Entra con el mismo correo y contraseña que usas en la app de AimHarder.</p>
${signInForm({ action: '/authorize/approve', submit: 'Autorizar', error: page.denial ? denials[page.denial] : undefined, hidden: { approval: page.approval } })}</section>`);
}

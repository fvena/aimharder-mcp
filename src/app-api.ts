import { z } from 'zod';
import { AimHarderError } from './errors.js';
import { readResponse } from './http.js';

// Session with the API the official mobile app uses (https://aimharder.com/aplic/apiExternal).
// See docs/aimharder-api.md for the observed contract.
const base = 'https://aimharder.com/aplic/apiExternal';
/** Client identity sent like the official iOS app. AimHarder may later require newer versions. */
export const appIdentity = { platform: 'iOS', version: '27.0.1', versionApp: '20.10.9' } as const;
/** Observed token format: `<userId>|<unix expiry>|<32 hex>`. */
const tokenSchema = z.string().regex(/^[1-9]\d{0,15}\|[1-9]\d{8,11}\|[0-9a-f]{32}$/);
const loginSchema = z.object({
  cookie: tokenSchema, userId: z.number().int().positive().safe(),
  // Each client membership: box ID, the box's publisher user ID (`idrel`) and subdomain slug (`url`).
  clientBoxes: z.array(z.object({ id: z.number().int().positive().safe(), idrel: z.number().int().positive().safe().nullish(), url: z.string().nullish(), name: z.string().nullish() })).optional(),
});
export type AppBox = { boxId: number; publisher: number | null; slug: string | null; name: string | null };
const loginErrorSchema = z.object({ error: z.string() });
const renewBeforeMs = 60 * 60_000;

export type AppRequest = {
  method?: 'GET' | 'POST';
  /** Query parameters; the token is added as `token` unless it travels in the path. */
  query?: Record<string, string>;
  /** Form fields for a POST; the token is added as a `token` field unless it travels in the path. */
  form?: Record<string, string>;
  multipart?: boolean;
  /** Append the token as the last path segment, as the app does for some routes. */
  tokenInPath?: boolean;
  textOnly?: boolean;
};

export class AppApiSession {
  #token: string | undefined;
  #userId: number | undefined;
  #expires = 0;
  #boxes: AppBox[] = [];
  #lastLoginUserId: number | undefined;

  constructor(private readonly credentials: { username: string; password: string }) {}

  /** Account ID of the current app session, after a request has signed in. */
  get userId() { return this.#userId; }
  /** Account ID of the most recent successful login, kept after the session is cleared. */
  get lastLoginUserId() { return this.#lastLoginUserId; }

  clear() {
    this.#token = undefined;
    this.#userId = undefined;
    this.#expires = 0;
    this.#boxes = [];
  }

  /** Client memberships reported by the app login, signing in first when needed. */
  async boxes(): Promise<AppBox[]> {
    if (!this.#token || this.#expires - Date.now() < renewBeforeMs) await this.#login();
    return this.#boxes.map(box => ({ ...box }));
  }

  async request(path: string, options: AppRequest = {}): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.#token || this.#expires - Date.now() < renewBeforeMs) await this.#login();
      const token = this.#token!;
      const query = new URLSearchParams(options.query);
      if (!options.tokenInPath && options.method !== 'POST') query.set('token', token);
      const url = `${base}/${path}${options.tokenInPath ? `/${token}` : ''}${query.size ? `?${query}` : ''}`;
      let body: BodyInit | undefined;
      if (options.method === 'POST') {
        const fields = { ...options.form, ...(options.tokenInPath ? {} : { token }) };
        if (options.multipart) {
          const form = new FormData();
          for (const [key, value] of Object.entries(fields)) form.append(key, value);
          body = form;
        } else body = new URLSearchParams(fields);
      }
      const response = await this.#fetch(url, options.method ?? 'GET', body, options.textOnly);
      if (loggedOut(response)) {
        this.clear();
        // Only reads are retried after signing in again. A write may already have taken effect.
        if (attempt === 0 && options.method !== 'POST') continue;
        throw new AimHarderError('SESSION_EXPIRED');
      }
      return response;
    }
    throw new AimHarderError('SESSION_EXPIRED');
  }

  async #login() {
    this.clear();
    const query = new URLSearchParams({ ...appIdentity, currlang: '1', mail: this.credentials.username, pw: this.credentials.password });
    const body = await this.#fetch(`${base}/login?${query}`, 'GET');
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      throw new AimHarderError(loginErrorSchema.safeParse(body).success ? 'AUTHENTICATION_FAILED' : 'INVALID_RESPONSE');
    }
    const [userId, expiry] = parsed.data.cookie.split('|');
    if (Number(userId) !== parsed.data.userId) throw new AimHarderError('IDENTITY_MISMATCH');
    this.#token = parsed.data.cookie;
    this.#userId = parsed.data.userId;
    this.#lastLoginUserId = parsed.data.userId;
    this.#expires = Number(expiry) * 1000;
    this.#boxes = (parsed.data.clientBoxes ?? []).map(box => ({ boxId: box.id, publisher: box.idrel ?? null, slug: box.url ?? null, name: box.name ?? null }));
  }

  // The URL can carry the password (login) or the token, so it never reaches errors or logs.
  async #fetch(url: string, method: 'GET' | 'POST', body?: BodyInit, textOnly = false) {
    let response: Response;
    try {
      response = await fetch(url, {
        method, ...(body ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/json, text/plain, */*' },
      });
    } catch { throw new AimHarderError('REQUEST_FAILED'); }
    if (response.status === 401) { void response.body?.cancel().catch(() => undefined); return { logout: 1 }; }
    if (response.status === 403 || response.status === 429) {
      void response.body?.cancel().catch(() => undefined);
      throw new AimHarderError('ACCESS_RESTRICTED');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new AimHarderError('REQUEST_FAILED');
    }
    return readResponse(response, textOnly);
  }
}

function loggedOut(body: unknown) {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && 'logout' in body;
}

import { randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { z } from 'zod';
import { AppApiSession, appIdentity, type AppRequest } from './app-api.js';
import type { Configuration } from './config.js';
import { AimHarderError } from './errors.js';
import { readResponse } from './http.js';

// Access to AimHarder for one account. Callers ask for domain operations; this module decides which API serves each one
// (website or mobile app), keeps both sessions, renews an expired session once per query for reads, never resends writes,
// and checks that the app account is the web account. See docs/aimharder-api.md.

export interface Gym {
  id: string;
  name: string;
  /** The configured IANA zone, or Europe/Madrid assumed. */
  timeZone: string;
  timeZoneStatus: 'assumed' | 'user-confirmed';
}
export interface AccessibleGym { gym: Gym; boxId: number | undefined }

/** Reads, by domain meaning. */
export type ReadOperation =
  | { kind: 'schedule'; boxId: number; date: string }
  | { kind: 'participants'; boxId: number; date: string; sessionId: number }
  | { kind: 'upcoming'; boxId: number }
  | { kind: 'day-workouts'; publisher: number; date: string }
  | { kind: 'workout'; id: number }
  | { kind: 'exercise'; exerciseId: number }
  | { kind: 'exercise-search'; name: string }
  | { kind: 'activity-calendar'; month: string }
  | { kind: 'activity-detail'; id: number }
  | { kind: 'saved-activity'; id: number };
/** Writes. Each is sent at most once; an expired session is reported, never retried. */
export type WriteOperation =
  | { kind: 'book'; sessionId: number; date: string }
  | { kind: 'cancel'; reservationId: number; late: boolean }
  | { kind: 'save-result'; form: Record<string, string> }
  | { kind: 'delete-activity'; id: number };

/** What a query receives for the account holder's gym. */
export interface GymSession {
  gym: Gym;
  boxId: number | undefined;
  accountId: number;
  read(operation: ReadOperation): Promise<unknown>;
  write(operation: WriteOperation): Promise<unknown>;
  /** The box publisher user ID for workouts: from the app login, or from the gym page when the app does not list the box. */
  publisher(): Promise<number>;
}
/** A gym session whose gym has a box ID: what class, booking and activity queries need. */
export interface BoxSession extends GymSession { boxId: number }
/** A box session whose time zone the account holder confirmed: what every write preview needs. */
export interface ConfirmedSession extends BoxSession { gym: Gym & { timeZoneStatus: 'user-confirmed' } }
/** What a query needs from its gym; an unmet requirement fails before any query request. */
export type GymRequirement = 'box' | 'confirmed-zone';

const loginUrl = 'https://login.aimharder.es/api/login';
const identityUrl = 'https://aimharder.es/api/whoami';
const accountIdSchema = z.number().int().positive().safe();
const loginSchema = z.object({ data: z.object({ userData: z.object({ id: accountIdSchema }), auth: z.object({ authOK: z.literal(true) }) }) });
const identitySchema = z.object({
  data: z.array(z.object({
    id: accountIdSchema,
    roles: z.array(z.object({
      role: z.string(),
      boid: accountIdSchema.optional(),
      gym: z.string().min(1).max(300).refine((name) => name.trim().length > 0),
      centre_url: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.aimharder\.es$/).transform((host) => host.slice(0, -'.aimharder.es'.length)),
    })),
  })).max(1),
});

/** An expired web session (HTTP 401 or an empty identity); internal to this module. */
class SessionExpired extends Error {}

export class AimHarderUpstream {
  #cookies = new CookieJar();
  #accountId: number | undefined;
  #authenticationFailure: AimHarderError | undefined;
  #queue: Promise<void> = Promise.resolve();
  #app: AppApiSession;

  constructor(private readonly configuration: Configuration) {
    this.#app = new AppApiSession({ username: configuration.username, password: configuration.password });
  }

  /**
   * Run one query for the account holder's gym: the chosen one, else the only one (several and none chosen: GYM_REQUIRED).
   * A requirement is checked before `work` runs: `box` needs the gym's box ID (else INVALID_RESPONSE), `confirmed-zone`
   * also needs a user-confirmed time zone (else CONFIRMED_GYM_TIME_ZONE_REQUIRED).
   * Queries are serialized so a session renewal cannot replace another query's session.
   */
  withGym<T>(work: (session: GymSession) => Promise<T>): Promise<T>;
  withGym<T>(requirement: 'box', work: (session: BoxSession) => Promise<T>): Promise<T>;
  withGym<T>(requirement: 'confirmed-zone', work: (session: ConfirmedSession) => Promise<T>): Promise<T>;
  withGym<T>(...args: [(session: GymSession) => Promise<T>] | [GymRequirement, (session: never) => Promise<T>]): Promise<T> {
    const [requirement, work] = args.length === 1 ? [undefined, args[0]] : args;
    return this.#enqueue(() => this.#run((gyms, canRenew) => {
      const session = this.#session(this.#select(gyms), canRenew);
      if (requirement === 'confirmed-zone' && session.gym.timeZoneStatus !== 'user-confirmed') throw new AimHarderError('CONFIRMED_GYM_TIME_ZONE_REQUIRED');
      if (requirement !== undefined && session.boxId === undefined) throw new AimHarderError('INVALID_RESPONSE');
      return (work as (session: GymSession) => Promise<T>)(session);
    }));
  }

  /**
   * Sign in and report the AimHarder account ID, all its gyms (to choose one) and the account holder's gym: undefined
   * when there are several and none is chosen, or the chosen one is no longer the account's.
   */
  account(): Promise<{ accountId: number; gyms: Gym[]; gym: Gym | undefined }> {
    return this.#enqueue(() => this.#run(async (gyms) => {
      let gym: Gym | undefined;
      try { gym = this.#select(gyms).gym; } catch { gym = undefined; }
      return { accountId: this.#accountId!, gyms: gyms.map((entry) => entry.gym), gym };
    }));
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Sign in if needed and run `work` with the account's gyms, renewing an expired session once. */
  async #run<T>(work: (gyms: AccessibleGym[], canRenew: boolean) => Promise<T>): Promise<T> {
    if (this.#authenticationFailure) throw this.#authenticationFailure;
    if (this.#accountId === undefined) await this.#authenticate();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await work(await this.#discoverGyms(), attempt === 0);
      } catch (error) {
        if (!(error instanceof SessionExpired)) throw error;
        this.#clearSession();
        if (attempt === 1) throw new AimHarderError('SESSION_EXPIRED');
        await this.#authenticate();
      }
    }
    throw new AimHarderError('SESSION_EXPIRED');
  }

  /** The account holder's gym, with the time zone they confirmed for it (else Europe/Madrid, assumed). */
  #select(gyms: AccessibleGym[]): AccessibleGym {
    const chosen = this.configuration.gym;
    if (chosen === undefined && gyms.length > 1) throw new AimHarderError('GYM_REQUIRED', gyms.map(({ gym }) => gym.id));
    const selected = chosen === undefined ? gyms[0] : gyms.find(({ gym }) => gym.id === chosen);
    if (!selected) throw new AimHarderError('GYM_NOT_ACCESSIBLE', gyms.map(({ gym }) => gym.id));
    const zone = this.configuration.timeZone;
    return zone === undefined ? selected : { ...selected, gym: { ...selected.gym, timeZone: zone, timeZoneStatus: 'user-confirmed' } };
  }

  #session(selected: AccessibleGym, canRenew: boolean): GymSession {
    const accountId = this.#accountId!;
    let renewalAvailable = canRenew;
    // Renew the web session once per query, then confirm the same account, gym and box before continuing.
    const renew = async () => {
      this.#clearSession();
      if (!renewalAvailable) throw new AimHarderError('SESSION_EXPIRED');
      renewalAvailable = false;
      await this.#authenticate();
      const refreshed = await this.#discoverGyms().catch(error => {
        if (error instanceof SessionExpired) { this.#clearSession(); throw new AimHarderError('SESSION_EXPIRED'); }
        throw error;
      });
      const current = refreshed.find(entry => entry.gym.id === selected.gym.id);
      if (!current || current.boxId !== selected.boxId) throw new AimHarderError('GYM_NOT_ACCESSIBLE');
      if (this.#accountId !== accountId) { this.#clearSession(); throw new AimHarderError('IDENTITY_MISMATCH'); }
    };
    return {
      gym: selected.gym, boxId: selected.boxId, accountId,
      read: async (operation) => {
        try { return await this.#read(operation); }
        catch (error) {
          if (!(error instanceof SessionExpired)) throw error;
          await renew();
          try { return await this.#read(operation); }
          catch (retryError) {
            if (retryError instanceof SessionExpired) { this.#clearSession(); throw new AimHarderError('SESSION_EXPIRED'); }
            throw retryError;
          }
        }
      },
      write: (operation) => this.#write(operation),
      publisher: () => this.#publisher(selected),
    };
  }

  #read(operation: ReadOperation): Promise<unknown> {
    const day = (date: string) => date.replaceAll('-', '');
    switch (operation.kind) {
      case 'schedule': return this.#appRequest('bookings', { query: { day: day(operation.date), box: String(operation.boxId), familyId: '', showClasesDisp: '0', appVer: appIdentity.versionApp } });
      case 'participants': return this.#appRequest('classAthleteBookings', { query: { hcid: String(operation.sessionId), day: day(operation.date), box: String(operation.boxId) } });
      case 'upcoming': return this.#appRequest('nextBookings', { query: { box: String(operation.boxId) } });
      case 'day-workouts': return this.#appRequest('bookingwod', { query: {
        timeLineFormat: '0', timeLineContent: '7', userID: String(operation.publisher), filterDay: day(operation.date), filterWODs: '', appVer: appIdentity.versionApp,
      } });
      case 'workout':
      case 'saved-activity': return this.#appRequest('activity/workout', { query: { SEID: String(operation.id) } });
      case 'exercise': return this.#appRequest(`exercise/${operation.exerciseId}/${this.#accountId}`, { tokenInPath: true });
      case 'exercise-search': return this.#appRequest('workoutAndEjers', { query: { search: operation.name, showWODs: '0', byLetter: '', filterType: '0' } });
      case 'activity-calendar': return this.#web(`https://aimharder.es/api/activityCalendar?${new URLSearchParams({ month: String(Number(operation.month.slice(5)) - 1), year: operation.month.slice(0, 4) })}`);
      case 'activity-detail': return this.#web(`https://aimharder.es/api/activity/workout?SEID=${operation.id}`);
    }
  }

  async #write(operation: WriteOperation): Promise<unknown> {
    try {
      switch (operation.kind) {
        case 'book': return await this.#appRequest('book', { method: 'POST', form: { showClasesDisp: '0', day: operation.date.replaceAll('-', ''), id: String(operation.sessionId), insist: '0' } });
        case 'cancel': return await this.#appRequest('cancelBook', { method: 'POST', form: { showClasesDisp: '0', id: String(operation.reservationId), late: operation.late ? '1' : '0' } });
        case 'save-result': return await this.#appRequest('activity', { method: 'POST', multipart: true, textOnly: true, form: operation.form });
        case 'delete-activity': return await this.#appRequest(`activity/${operation.id}`, { method: 'POST', tokenInPath: true, textOnly: true });
      }
    } catch (error) {
      // Never resent: an expired session after a possible send is an unknown outcome for the caller to reconcile.
      if (error instanceof SessionExpired) throw new AimHarderError('SESSION_EXPIRED');
      throw error;
    }
  }

  async #publisher(selected: AccessibleGym) {
    const boxes = await this.#app.boxes();
    this.#checkAppAccount();
    const fromApp = boxes.find(box => box.boxId === selected.boxId)?.publisher;
    if (fromApp) return fromApp;
    const html = await this.#web(`https://${selected.gym.id}.aimharder.es/`, true);
    if (typeof html !== 'string') throw new AimHarderError('INVALID_WORKOUT_RESPONSE');
    const publishers = [...html.matchAll(/timeLineContent:\s*7,\s*userID:\s*(\d+)/g)].map(match => Number(match[1]));
    const publisher = publishers[0];
    if (!publisher || !Number.isSafeInteger(publisher) || publishers.some(id => id !== publisher)) throw new AimHarderError('INVALID_WORKOUT_RESPONSE');
    return publisher;
  }

  /** Request the app API, accepting the result only for the same account as the web session. */
  async #appRequest(path: string, options?: AppRequest) {
    let body: unknown;
    try { body = await this.#app.request(path, options); }
    catch (error) {
      // A re-login may have switched accounts before the request failed again; report that first.
      if (this.#app.lastLoginUserId !== undefined && this.#app.lastLoginUserId !== this.#accountId) { this.#app.clear(); throw new AimHarderError('IDENTITY_MISMATCH'); }
      throw error;
    }
    this.#checkAppAccount();
    return body;
  }

  #checkAppAccount() {
    if (this.#accountId === undefined || this.#app.userId !== this.#accountId) { this.#app.clear(); throw new AimHarderError('IDENTITY_MISMATCH'); }
  }

  #clearSession() {
    this.#accountId = undefined;
    this.#cookies = new CookieJar();
  }

  async #authenticate() {
    this.#clearSession();
    try {
      const response = await this.#web(loginUrl, false, JSON.stringify({
        username: this.configuration.username, password: this.configuration.password, iniframe: 0, fingerprint: randomBytes(25).toString('hex'),
      }));
      const parsed = loginSchema.safeParse(response);
      if (!parsed.success || !(await this.#cookies.getCookies(identityUrl)).some((cookie) => cookie.key === 'amhrdrauth')) {
        throw new AimHarderError('AUTHENTICATION_FAILED');
      }
      this.#accountId = parsed.data.data.userData.id;
    } catch (error) {
      this.#clearSession();
      // Unknown login, 2FA or restriction responses also stop, without interpreting raw messages.
      this.#authenticationFailure = error instanceof AimHarderError ? error : new AimHarderError('AUTHENTICATION_FAILED');
      throw this.#authenticationFailure;
    }
  }

  /** The account's gyms, each with Europe/Madrid assumed as its zone. */
  async #discoverGyms(): Promise<AccessibleGym[]> {
    const parsed = identitySchema.safeParse(await this.#web(identityUrl));
    if (!parsed.success) throw new AimHarderError('INVALID_RESPONSE');
    const account = parsed.data.data[0];
    if (!account) throw new SessionExpired();
    if (account.id !== this.#accountId) {
      this.#clearSession();
      throw new AimHarderError('IDENTITY_MISMATCH');
    }
    const gyms = new Map<string, AccessibleGym>();
    for (const role of account.roles) {
      if (role.role !== 'client') throw new AimHarderError('UNSUPPORTED_MEMBERSHIP');
      const previous = gyms.get(role.centre_url);
      if (previous && (previous.gym.name !== role.gym || previous.boxId !== role.boid)) throw new AimHarderError('INVALID_RESPONSE');
      gyms.set(role.centre_url, { gym: { id: role.centre_url, name: role.gym, timeZone: 'Europe/Madrid', timeZoneStatus: 'assumed' }, boxId: role.boid });
    }
    if (!gyms.size) throw new AimHarderError('NO_ACCESSIBLE_GYMS');
    return [...gyms.values()];
  }

  /** One website request with the session cookie. A login sends `loginBody` as JSON. */
  async #web(url: string, textOnly = false, loginBody?: string): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    const cookie = await this.#cookies.getCookieString(url);
    if (cookie) headers.Cookie = cookie;
    if (loginBody) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(url, { method: loginBody ? 'POST' : 'GET', headers, ...(loginBody ? { body: loginBody } : {}), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      if (response.status === 401) {
        void response.body?.cancel().catch(() => undefined);
        if (!loginBody) throw new SessionExpired();
        throw new AimHarderError('AUTHENTICATION_FAILED');
      }
      if (response.status === 403 || response.status === 429) {
        void response.body?.cancel().catch(() => undefined);
        throw new AimHarderError('ACCESS_RESTRICTED');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new AimHarderError('REQUEST_FAILED');
      }
      for (const setCookie of response.headers.getSetCookie()) await this.#cookies.setCookie(setCookie, url);
      return await readResponse(response, textOnly);
    } catch (error) {
      if (error instanceof AimHarderError || error instanceof SessionExpired) throw error;
      throw new AimHarderError('REQUEST_FAILED');
    }
  }
}

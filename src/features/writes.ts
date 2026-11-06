import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { AimHarderError } from '../errors.js';
import type { Preferences } from '../preferences.js';
import type { AimHarderUpstream, BoxSession, ConfirmedSession, GymSession, WriteOperation } from '../upstream.js';

// Every write (booking, cancellation, saving or deleting a result) follows one rule: a read-only preview issues a
// two-minute, single-use reference; execution needs explicit confirmation, rechecks with fresh reads, sends at most one
// request, never retries, and rereads to report the outcome. This module owns that rule; each write is a `WriteAction`.

type ErrorCode = ConstructorParameters<typeof AimHarderError>[0];

/** What a preview fixed: the account, gym and box it was read for, and the action's own plan. */
export interface Prepared<P> {
  accountId: number;
  gym: { id: string; name: string; timeZone: string };
  boxId: number;
  plan: P;
}

/** The single send: its response, or a failure, which leaves the outcome unknown (never resent). */
export type Sent = { failed: false; response: unknown } | { failed: true };

/** The kinds of write; a reference executes only the kind that issued it. */
export type WriteKind = 'booking-creation' | 'cancellation' | 'late-cancellation' | 'result-saving' | 'result-deletion';

export interface Reference { actionReference: string; expiresAt: string }

/** Issue a new reference from inside a reconciliation, such as a late cancellation after a credit-loss warning. */
export type Issue = <Q>(action: WriteAction<Q, unknown>, plan: Q) => Reference;

export interface ExecutionInput { actionReference: string; confirmed?: true | undefined; confirmedCreditLoss?: true | undefined }

/** One kind of write: how its execution input is read and confirmed, and what it reads and sends. */
export interface WriteAction<P, R> {
  readonly kind: WriteKind;
  readonly input: z.ZodType<ExecutionInput>;
  readonly invalidInput: ErrorCode;
  readonly invalidReference: ErrorCode;
  /** The input field that carries the account holder's confirmation, and whether their preferences require it. */
  readonly confirmation: { marker: 'confirmed' | 'confirmedCreditLoss'; required: (preferences: Preferences) => boolean };
  /** The result when the account, gym, box or confirmed zone changed since the preview; nothing is sent. */
  stale(session: GymSession, prepared: Prepared<P>): R;
  /** Fresh reads before sending: a result to return instead (nothing sent), or the one request to send. */
  recheck(session: BoxSession, prepared: Prepared<P>): Promise<{ result: R } | { send: WriteOperation }>;
  /** Fresh reads after the send decide the outcome; the response alone never confirms it. */
  reconcile(session: BoxSession, prepared: Prepared<P>, sent: Sent, issue: Issue): Promise<R>;
}

const lifetimeMs = 120_000;
const capacity = 64;

/** The single-use references of one account, and the execution of the writes they name. */
export class WriteActions {
  readonly #entries = new Map<string, { kind: WriteKind; prepared: Prepared<unknown>; expires: number }>();

  constructor(private readonly upstream: AimHarderUpstream, private readonly preferences: Preferences) {}

  /** Issue a two-minute, single-use reference for a preview read in this session. */
  issue<P>(action: WriteAction<P, unknown>, session: ConfirmedSession, plan: P): Reference {
    const { gym } = session;
    return this.#issue(action.kind, { accountId: session.accountId, gym: { id: gym.id, name: gym.name, timeZone: gym.timeZone }, boxId: session.boxId, plan });
  }

  /**
   * Execute a previewed write. The confirmation is checked first; the reference is consumed before any source access,
   * so a failed recheck also uses it up. At most one request is sent and no error leads to a second one. A failed send is
   * reconciled with fresh reads, except an identity mismatch, which is reported as that error.
   */
  execute<P, R>(action: WriteAction<P, R>, input: unknown): Promise<R> {
    const parsed = action.input.safeParse(input);
    if (!parsed.success) return Promise.reject(new AimHarderError(action.invalidInput));
    if (action.confirmation.required(this.preferences) && parsed.data[action.confirmation.marker] !== true) {
      return Promise.reject(new AimHarderError('WRITE_CONFIRMATION_REQUIRED'));
    }
    const { actionReference } = parsed.data;
    return this.upstream.withGym('box', async (session) => {
      const entry = this.#take(actionReference, action.kind, session.accountId, session.gym.id);
      if (!entry) throw new AimHarderError(action.invalidReference);
      const prepared = entry.prepared as Prepared<P>;
      const { gym } = session;
      if (session.boxId !== prepared.boxId || gym.timeZoneStatus !== 'user-confirmed' || gym.timeZone !== prepared.gym.timeZone || gym.name !== prepared.gym.name) {
        return action.stale(session, prepared);
      }
      const checked = await action.recheck(session, prepared);
      if ('result' in checked) return checked.result;
      let sent: Sent;
      try { sent = { failed: false, response: await session.write(checked.send) }; }
      catch (error) {
        // A response for another account breaks "same account everywhere": report it, never as an ordinary outcome.
        if (error instanceof AimHarderError && error.code === 'IDENTITY_MISMATCH') throw error;
        sent = { failed: true };
      }
      const issue: Issue = (next, plan) => this.#issue(next.kind, { ...prepared, plan });
      return action.reconcile(session, prepared, sent, issue);
    });
  }

  #issue(kind: WriteKind, prepared: Prepared<unknown>): Reference {
    const now = Date.now();
    for (const [reference, entry] of this.#entries) if (entry.expires <= now) this.#entries.delete(reference);
    if (this.#entries.size >= capacity) this.#entries.delete(this.#entries.keys().next().value!);
    const actionReference = randomBytes(32).toString('hex');
    const expires = now + lifetimeMs;
    this.#entries.set(actionReference, { kind, prepared: structuredClone(prepared), expires });
    return { actionReference, expiresAt: new Date(expires).toISOString() };
  }

  #take(reference: string, kind: WriteKind, accountId: number, gymId: string) {
    const entry = this.#entries.get(reference);
    this.#entries.delete(reference);
    if (!entry || entry.expires <= Date.now() || entry.kind !== kind || entry.prepared.accountId !== accountId || entry.prepared.gym.id !== gymId) return null;
    return entry;
  }
}

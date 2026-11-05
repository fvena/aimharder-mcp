import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { dateSchema, parseClassDay, timeSchema } from './classes.js';
import { gymIdSchema } from '../config.js';

export const bookingCreationQuerySchema = z.object({
  gymId: gymIdSchema.optional(), date: dateSchema,
  className: z.string().min(1).max(300).refine((name) => name.trim().length > 0),
  startTime: timeSchema, endTime: timeSchema,
}).strict();
export type BookingCreationQuery = z.infer<typeof bookingCreationQuerySchema>;
export const bookingCancellationQuerySchema = bookingCreationQuerySchema;
export type BookingCancellationQuery = z.infer<typeof bookingCancellationQuerySchema>;
export const bookingExecutionSchema = z.object({
  gymId: gymIdSchema.optional(), actionReference: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true).optional(),
}).strict();
export type BookingExecution = z.infer<typeof bookingExecutionSchema>;
export const lateCancellationExecutionSchema = z.object({
  gymId: gymIdSchema.optional(), actionReference: z.string().regex(/^[a-f0-9]{64}$/), confirmedCreditLoss: z.literal(true).optional(),
}).strict();
export type LateCancellationExecution = z.infer<typeof lateCancellationExecutionSchema>;

const rowFields = z.object({
  enabled: z.number().int(), bookState: z.number().int().nullable(),
  cancelledId: z.number().int().nullable(), resadmin: z.number().int(),
  hidden: z.number().int().optional(),
});

export type BookingCandidate = {
  className: string; date: string; startTime: string; endTime: string;
  currentState: 'unbooked' | 'booked' | 'waitlisted' | 'unknown';
  eligibility: 'offered' | 'unsupported';
};
export type InternalBookingCandidate = BookingCandidate & { sourceId: number };

export type CancellationCandidate = {
  className: string; date: string; startTime: string; endTime: string;
  currentState: 'booked' | 'waitlisted' | 'cancelled' | 'unbooked' | 'unknown';
  eligibility: 'offered' | 'unsupported';
};
export type InternalCancellationCandidate = CancellationCandidate & { sourceId: number; reservationId: number | null };

export function cancellationCandidates(body: unknown, gymId: string, date: string, timeZone: string, query: BookingCancellationQuery): InternalCancellationCandidate[] {
  const sessions = parseClassDay(body, gymId, date, timeZone);
  const rows = (body as { bookings: unknown[] }).bookings;
  const cancellationFields = rowFields.extend({ idres: z.number().int().positive().safe().nullable() });
  return sessions.flatMap((session, index) => {
    const endTime = session.timeLabel.slice(-5);
    if (session.classType.name !== query.className || session.startTime !== query.startTime || endTime !== query.endTime) return [];
    const flags = cancellationFields.safeParse(rows[index]);
    const state = !flags.success ? 'unknown' as const : flags.data.cancelledId !== null ? 'cancelled' as const
      : flags.data.bookState === 1 ? 'booked' as const : flags.data.bookState === 0 ? 'waitlisted' as const
        : flags.data.bookState === null ? 'unbooked' as const : 'unknown' as const;
    // Waitlist leaves belong to a later feature, even if the frontend offers them.
    const offered = flags.success && state === 'booked' && flags.data.idres !== null && flags.data.enabled === 1
      && flags.data.resadmin === 0 && (flags.data.hidden === undefined || flags.data.hidden === 0);
    return [{ sourceId: session.sourceId, reservationId: flags.success ? flags.data.idres : null, className: session.classType.name, date,
      startTime: session.startTime, endTime, currentState: state,
      eligibility: offered ? 'offered' as const : 'unsupported' as const }];
  });
}

export function bookingCandidates(body: unknown, gymId: string, date: string, timeZone: string, query: BookingCreationQuery): InternalBookingCandidate[] {
  const sessions = parseClassDay(body, gymId, date, timeZone);
  const rows = (body as { bookings: unknown[] }).bookings;
  return sessions.flatMap((session, index) => {
    const endTime = session.timeLabel.slice(-5);
    if (session.classType.name !== query.className || session.startTime !== query.startTime || endTime !== query.endTime) return [];
    const flags = rowFields.safeParse(rows[index]);
    const state = !flags.success ? 'unknown' as const : flags.data.bookState === null ? 'unbooked' as const
      : flags.data.bookState === 1 ? 'booked' as const : flags.data.bookState === 0 ? 'waitlisted' as const : 'unknown' as const;
    const offered = flags.success && flags.data.enabled === 1 && flags.data.resadmin === 0
      && flags.data.cancelledId === null && (flags.data.hidden === undefined || flags.data.hidden === 0) && state === 'unbooked';
    return [{ sourceId: session.sourceId, className: session.classType.name, date,
      startTime: session.startTime, endTime, currentState: state,
      eligibility: offered ? 'offered' as const : 'unsupported' as const }];
  });
}

export function minutesUntilGymLocalStart(date: string, startTime: string, timeZone: string, now = new Date()): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const currentDate = `${parts.year}-${parts.month}-${parts.day}`;
  // UTC is only a Gregorian date counter here, not an inferred class instant.
  const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${currentDate}T00:00:00Z`)) / 86_400_000;
  const startMinutes = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3));
  const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const wallMinutes = days * 1440 + startMinutes - nowMinutes;
  return wallMinutes;
}

// Account-holder-reported rule, configured per gym: booking opens a fixed number of days before the
// class start, at the same gym-local wall time. AimHarder remains the authority on actual eligibility.
export function bookingWindow(date: string, startTime: string, timeZone: string, days: number, now = new Date()) {
  const opens = new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  return { bookingOpensAt: `${opens}T${startTime}`, bookingOpen: minutesUntilGymLocalStart(date, startTime, timeZone, now) <= days * 1440 };
}

/** Whether a class start is within the gym's configured late-cancellation window (credit may be lost). */
export function insideCancellationWindow(date: string, startTime: string, timeZone: string, windowMinutes: number, now = new Date()): boolean {
  const naive = Date.parse(`${date}T${startTime}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const wall = (instant: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`,
      asUtc: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) };
  };
  // Try offsets on both sides of a transition. Ambiguous local times can have two
  // possible instants; warn if either is inside the boundary without exposing one
  // as the source's verified class instant.
  const offsets = new Set([-86_400_000, 0, 86_400_000].map(delta => wall(naive + delta).asUtc - (naive + delta)));
  const possible = [...offsets].map(offset => naive - offset).filter(instant => {
    const parts = wall(instant);
    return parts.date === date && parts.time === startTime;
  });
  if (!possible.length) return minutesUntilGymLocalStart(date, startTime, timeZone, now) <= windowMinutes + 60;
  return possible.some(instant => instant - now.getTime() <= windowMinutes * 60_000);
}

export type BookingCreationPreview = {
  action: 'create'; gym: { id: string; name: string; timeZone: string; timeZoneStatus: 'user-confirmed' };
  target: Omit<BookingCandidate, 'currentState' | 'eligibility'>;
  currentState: 'unbooked';
  notices: string[];
};
export type BookingCancellationPreview = {
  action: 'cancel'; gym: BookingCreationPreview['gym'];
  target: BookingCreationPreview['target']; currentState: 'booked';
  credit: { possibleLoss: string; balance: null; entitlementPeriod: null };
  notices: string[];
};

type Preparation =
  | { action: 'create'; accountId: number; boxId: number; sourceId: number; preview: BookingCreationPreview; expires: number }
  | { action: 'cancel' | 'cancel-late'; accountId: number; boxId: number; reservationId: number; preview: BookingCancellationPreview; expires: number };

export class BookingPreparationStore {
  #entries = new Map<string, Preparation>();

  issue(accountId: number, boxId: number, sourceId: number, preview: BookingCreationPreview) {
    return this.#issue({ action: 'create', accountId, boxId, sourceId, preview });
  }

  issueCancellation(accountId: number, boxId: number, reservationId: number, preview: BookingCancellationPreview) {
    return this.#issue({ action: 'cancel', accountId, boxId, reservationId, preview });
  }

  issueLateCancellation(accountId: number, boxId: number, reservationId: number, preview: BookingCancellationPreview) {
    return this.#issue({ action: 'cancel-late', accountId, boxId, reservationId, preview });
  }

  #issue(entry: Omit<Extract<Preparation, { action: 'create' }>, 'expires'> | Omit<Extract<Preparation, { action: 'cancel' | 'cancel-late' }>, 'expires'>) {
    const now = Date.now();
    for (const [reference, entry] of this.#entries) if (entry.expires <= now) this.#entries.delete(reference);
    if (this.#entries.size >= 32) this.#entries.delete(this.#entries.keys().next().value!);
    const actionReference = randomBytes(32).toString('hex');
    const expires = now + 120_000;
    this.#entries.set(actionReference, { ...entry, preview: structuredClone(entry.preview), expires } as Preparation);
    return { actionReference, expiresAt: new Date(expires).toISOString() };
  }

  take(reference: string, action: 'create', accountId: number, gymId: string): Extract<Preparation, { action: 'create' }> | null;
  take(reference: string, action: 'cancel', accountId: number, gymId: string): Extract<Preparation, { action: 'cancel' | 'cancel-late' }> | null;
  take(reference: string, action: 'cancel-late', accountId: number, gymId: string): Extract<Preparation, { action: 'cancel' | 'cancel-late' }> | null;
  take(reference: string, action: 'create' | 'cancel' | 'cancel-late', accountId: number, gymId: string): Preparation | null {
    const entry = this.#entries.get(reference);
    this.#entries.delete(reference);
    if (!entry || entry.expires <= Date.now() || entry.action !== action || entry.accountId !== accountId || entry.preview.gym.id !== gymId) return null;
    return entry;
  }
}

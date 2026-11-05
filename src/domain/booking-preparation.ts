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
export const maxPlannedBookingDays = 14;
export const plannedBookingQuerySchema = z.object({
  gymId: gymIdSchema.optional(),
  startDate: dateSchema.describe('First gym-local date, inclusive (YYYY-MM-DD).'),
  endDate: dateSchema.describe(`Last gym-local date, inclusive. At most ${maxPlannedBookingDays} calendar dates in all.`),
}).strict().refine(query => query.startDate <= query.endDate
  && (Date.parse(`${query.endDate}T00:00:00Z`) - Date.parse(`${query.startDate}T00:00:00Z`)) / 86_400_000 < maxPlannedBookingDays);
export type PlannedBookingQuery = z.infer<typeof plannedBookingQuerySchema>;
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
const reservationFields = rowFields.extend({ idres: z.number().int().positive().safe().nullable() });

/** A class to book or cancel; a booking plan gives no end time, which then matches any. */
export interface ClassTarget { className: string; date: string; startTime: string; endTime?: string | undefined }
export type BookingState = 'unbooked' | 'booked' | 'waitlisted' | 'unknown';
export type CancellationState = 'booked' | 'waitlisted' | 'cancelled' | 'unbooked' | 'unknown';
export type Eligibility = 'offered' | 'unsupported';

/** One daily-schedule row of the target class, as this account sees it: whether it can be booked, and cancelled. */
export interface ClassBookingRow {
  sourceId: number;
  /** The account's reservation (idres), when the row has a readable one. */
  reservationId: number | null;
  className: string; date: string; startTime: string; endTime: string;
  booking: { state: BookingState; eligibility: Eligibility };
  cancellation: { state: CancellationState; eligibility: Eligibility };
}

/**
 * The rows of one exact class in a daily schedule response. The whole day is validated first. Waitlist leaves belong to
 * a later feature, so only a booked reservation can be cancelled, and only an unbooked, enabled row can be booked.
 */
export function classBookingRows(body: unknown, gymId: string, date: string, timeZone: string, target: ClassTarget): ClassBookingRow[] {
  const sessions = parseClassDay(body, gymId, date, timeZone);
  const rows = (body as { bookings: unknown[] }).bookings;
  return sessions.flatMap((session, index) => {
    const endTime = session.timeLabel.slice(-5);
    if (session.classType.name !== target.className || session.startTime !== target.startTime || (target.endTime !== undefined && endTime !== target.endTime)) return [];
    const flags = rowFields.safeParse(rows[index]);
    const reservation = reservationFields.safeParse(rows[index]);
    const visible = (data: z.infer<typeof rowFields>) => data.enabled === 1 && data.resadmin === 0 && (data.hidden === undefined || data.hidden === 0);
    const bookingState: BookingState = !flags.success ? 'unknown' : flags.data.bookState === null ? 'unbooked'
      : flags.data.bookState === 1 ? 'booked' : flags.data.bookState === 0 ? 'waitlisted' : 'unknown';
    const cancellationState: CancellationState = !reservation.success ? 'unknown' : reservation.data.cancelledId !== null ? 'cancelled'
      : reservation.data.bookState === 1 ? 'booked' : reservation.data.bookState === 0 ? 'waitlisted'
        : reservation.data.bookState === null ? 'unbooked' : 'unknown';
    const bookable = flags.success && visible(flags.data) && flags.data.cancelledId === null && bookingState === 'unbooked';
    const cancellable = reservation.success && visible(reservation.data) && cancellationState === 'booked' && reservation.data.idres !== null;
    return [{
      sourceId: session.sourceId, reservationId: reservation.success ? reservation.data.idres : null,
      className: session.classType.name, date, startTime: session.startTime, endTime,
      booking: { state: bookingState, eligibility: bookable ? 'offered' : 'unsupported' },
      cancellation: { state: cancellationState, eligibility: cancellable ? 'offered' : 'unsupported' },
    }];
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
  target: { className: string; date: string; startTime: string; endTime: string };
  currentState: 'unbooked';
  notices: string[];
};
export type BookingCancellationPreview = {
  action: 'cancel'; gym: BookingCreationPreview['gym'];
  target: BookingCreationPreview['target']; currentState: 'booked';
  credit: { possibleLoss: string; balance: null; entitlementPeriod: null };
  notices: string[];
};

import { z } from 'zod';
import { gymIdSchema } from '../config.js';
import { AimHarderError } from '../errors.js';

// Calendar arithmetic uses UTC only as a Gregorian date counter, never as the gym zone.
export const dateSchema = z.iso.date().refine((date) => !date.startsWith('0000'));
export const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const classQuerySchema = z.object({
  startDate: dateSchema, endDate: dateSchema, gymId: gymIdSchema.optional(),
  startTime: timeSchema.optional(), className: z.string().min(1).max(300).optional(),
}).strict().refine((query) => query.startDate <= query.endDate, { message: 'startDate must be on or before endDate.' });
export type ClassQuery = z.infer<typeof classQuerySchema>;
const sourceId = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
export const classSessionSchema = z.object({
  sessionId: z.string(), sourceId,
  date: dateSchema, startTime: timeSchema, timeLabel: z.string(), timeZone: z.string(),
  classType: z.object({ id: sourceId, name: z.string() }),
  occupancy: count.nullable(), capacity: count.nullable(),
  coach: z.string().nullable().describe('Source coach name for the session; null when the gym has not assigned one.'),
  bookingOpensAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional().describe('Gym-local date and time when booking opens under the configured booking window. Present only when AIMHARDER_BOOKING_WINDOW_DAYS covers this gym.'),
  bookingOpen: z.boolean().optional().describe('Whether the configured booking window is open now. False means do not attempt a booking until bookingOpensAt.'),
});
export type ClassSession = z.infer<typeof classSessionSchema>;
const timeLabelSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d - (?:[01]\d|2[0-3]):[0-5]\d$/);
const capacityLabelSchema = z.string().regex(/^(0|[1-9]\d{0,5}) \((0|[1-9]\d{0,5})\)$/);
const dailySchema = z.object({
  bookings: z.array(z.object({
    id: sourceId, classId: sourceId,
    className: z.string().min(1).max(300).refine((name) => name.trim().length > 0),
    time: timeLabelSchema, ocupation: count.nullish(),
    // Observed at undergroundrv: when the official renderer shows "12/16 (1)", limit is the label "16 (1)".
    // The leading number is the capacity; the bracketed count (probably a waiting list) is not interpreted.
    limit: z.union([count, capacityLabelSchema]).nullish(),
    coachName: z.string().max(300).nullish(),
  })),
  // Only the observed complete-day envelope is accepted. New pagination/error fields
  // need investigation instead of being stripped and misreported as complete coverage.
  clasesDisp: z.string().optional(), day: z.string().optional(),
  timetable: z.array(z.unknown()).optional(), seminars: z.array(z.string()).optional(),
  // App-API envelope fields (observed 2026-11-05).
  hasPublicMemberships: z.number().optional(), uid: z.number().optional(), clasesContratadas: z.string().optional(), seminarsYYYYMMDD: z.array(z.string()).optional(),
  resmsgs: z.array(z.never()).optional(),
}).strict();

export function* calendarDates(startDate: string, endDate: string) {
  let date = startDate;
  while (true) {
    yield date;
    if (date === endDate) return;
    const next = new Date(`${date}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
}

export function parseClassDay(body: unknown, gymId: string, date: string, timeZone: string): ClassSession[] {
  const parsed = dailySchema.safeParse(body);
  if (!parsed.success) throw new AimHarderError('INVALID_CLASS_RESPONSE');
  const ids = new Set<number>();
  return parsed.data.bookings.map((row) => {
    if (ids.has(row.id)) throw new AimHarderError('INVALID_CLASS_RESPONSE');
    ids.add(row.id);
    return {
      sessionId: `${gymId}:${date}:${row.id}`, sourceId: row.id,
      date, startTime: row.time.slice(0, 5), timeLabel: row.time, timeZone,
      classType: { id: row.classId, name: row.className },
      occupancy: row.ocupation ?? null, capacity: typeof row.limit === 'string' ? Number(row.limit.split(' ')[0]) : row.limit ?? null,
      coach: row.coachName?.trim() || null,
    };
  });
}

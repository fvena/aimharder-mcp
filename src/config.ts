import { z } from 'zod';
import { AimHarderError } from './errors.js';

export const gymIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const nonEmpty = z.string().refine((value) => value.trim().length > 0);
const timeZoneSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/).refine((zone) => {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; }
  catch { return false; }
});
const timeZonesSchema = z.record(gymIdSchema, timeZoneSchema);
const bookingWindowsSchema = z.record(gymIdSchema, z.number().int().min(1).max(60));
const cancellationWindowsSchema = z.record(gymIdSchema, z.number().int().min(1).max(10_080));
const environmentSchema = z.object({
  AIMHARDER_USERNAME: nonEmpty,
  AIMHARDER_PASSWORD: nonEmpty,
  AIMHARDER_DEFAULT_GYM: gymIdSchema.optional(),
  AIMHARDER_GYM_TIME_ZONES: z.string().optional(),
  AIMHARDER_BOOKING_WINDOW_DAYS: z.string().optional(),
  AIMHARDER_CANCELLATION_WINDOW_MINUTES: z.string().optional(),
  AIMHARDER_REQUIRE_BOOKING_CONFIRMATION: z.enum(['true', 'false']).optional(),
});
export type Configuration = Omit<ReturnType<typeof readConfiguration>, 'requireBookingConfirmation' | 'bookingWindowDays' | 'cancellationWindowMinutes'> & { requireBookingConfirmation?: boolean; bookingWindowDays?: Record<string, number>; cancellationWindowMinutes?: Record<string, number> };

export function readConfiguration(environment: Record<string, string | undefined>) {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) throw new AimHarderError('INVALID_CONFIGURATION');
  let gymTimeZones: Record<string, string> = {};
  try {
    if (parsed.data.AIMHARDER_GYM_TIME_ZONES !== undefined) {
      gymTimeZones = timeZonesSchema.parse(JSON.parse(parsed.data.AIMHARDER_GYM_TIME_ZONES));
    }
  } catch { throw new AimHarderError('INVALID_TIME_ZONE_CONFIGURATION'); }
  let bookingWindowDays: Record<string, number> = {};
  try {
    if (parsed.data.AIMHARDER_BOOKING_WINDOW_DAYS !== undefined) {
      bookingWindowDays = bookingWindowsSchema.parse(JSON.parse(parsed.data.AIMHARDER_BOOKING_WINDOW_DAYS));
    }
  } catch { throw new AimHarderError('INVALID_BOOKING_WINDOW_CONFIGURATION'); }
  let cancellationWindowMinutes: Record<string, number> = {};
  try {
    if (parsed.data.AIMHARDER_CANCELLATION_WINDOW_MINUTES !== undefined) {
      cancellationWindowMinutes = cancellationWindowsSchema.parse(JSON.parse(parsed.data.AIMHARDER_CANCELLATION_WINDOW_MINUTES));
    }
  } catch { throw new AimHarderError('INVALID_CANCELLATION_WINDOW_CONFIGURATION'); }
  return {
    gymTimeZones,
    bookingWindowDays,
    cancellationWindowMinutes,
    requireBookingConfirmation: parsed.data.AIMHARDER_REQUIRE_BOOKING_CONFIRMATION !== 'false',
    username: parsed.data.AIMHARDER_USERNAME,
    password: parsed.data.AIMHARDER_PASSWORD,
    defaultGym: parsed.data.AIMHARDER_DEFAULT_GYM,
  };
}

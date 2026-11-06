import { z } from 'zod';
import { AimHarderError } from './errors.js';

export const gymIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const nonEmpty = z.string().refine((value) => value.trim().length > 0);
export const timeZoneSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/).refine((zone) => {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; }
  catch { return false; }
});
export const maxBookingWindowDays = 60;
export const maxCancellationWindowMinutes = 10_080;
export const bookingWindowSchema = z.number().int().min(1).max(maxBookingWindowDays);
export const cancellationWindowSchema = z.number().int().min(1).max(maxCancellationWindowMinutes);
/** A whole number written as text (as in the environment or a form), checked with a schema; undefined when invalid. */
export function wholeNumber(value: string, schema: z.ZodType<number>): number | undefined {
  const parsed = /^\d{1,6}$/.test(value.trim()) ? schema.safeParse(Number(value.trim())) : undefined;
  return parsed?.success ? parsed.data : undefined;
}
const className = z.string().trim().min(1).max(300);
export const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = typeof weekdays[number];
export const planEntrySchema = z.object({ day: z.enum(weekdays), className, startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict();
export type PlanEntry = z.infer<typeof planEntrySchema>;
/** The weekly booking plan: any number of classes per weekday, kept in weekday and start-time order without duplicates. */
export type BookingPlan = PlanEntry[];
const planKey = (entry: PlanEntry) => `${entry.day}|${entry.startTime}|${entry.className}`;
export function sortPlan(plan: BookingPlan): BookingPlan {
  const unique = new Map(plan.map((entry) => [planKey(entry), entry]));
  return [...unique.values()].sort((a, b) => weekdays.indexOf(a.day) - weekdays.indexOf(b.day) || a.startTime.localeCompare(b.startTime) || a.className.localeCompare(b.className));
}
const bookingPlanSchema = z.array(planEntrySchema).max(50).transform(sortPlan);
/** A friend: the name the account holder knows them by and, when known, their public profile picture. */
export const friendSchema = z.object({
  name: z.string().trim().min(1).max(100),
  photoUrl: z.string().max(500).refine((value) => URL.canParse(value) && new URL(value).protocol === 'https:').optional(),
}).strict();
export type Friend = z.infer<typeof friendSchema>;
/** Friends by AimHarder user ID (as a string). */
export const friendsSchema = z.record(z.string().regex(/^[1-9]\d{0,15}$/), friendSchema)
  .refine((friends) => Object.keys(friends).length <= 200);
export type Friends = Record<string, Friend>;
export const participantsFilterValues = ['all', 'friends'] as const;
export type ParticipantsFilterValue = typeof participantsFilterValues[number];

/** Parse an optional JSON environment value with a schema, or fail with one public error code. */
function jsonSetting<T>(value: string | undefined, schema: z.ZodType<T>, fallback: T, code: ConstructorParameters<typeof AimHarderError>[0]): T {
  if (value === undefined) return fallback;
  try { return schema.parse(JSON.parse(value)); }
  catch { throw new AimHarderError(code); }
}
/** Parse an optional whole-number environment value with a schema, or fail with one public error code. */
function numberSetting(value: string | undefined, schema: z.ZodType<number>, code: ConstructorParameters<typeof AimHarderError>[0]): number | undefined {
  if (value === undefined) return undefined;
  const parsed = wholeNumber(value, schema);
  if (parsed === undefined) throw new AimHarderError(code);
  return parsed;
}
const environmentSchema = z.object({
  AIMHARDER_USERNAME: nonEmpty,
  AIMHARDER_PASSWORD: nonEmpty,
  AIMHARDER_GYM: gymIdSchema.optional(),
  AIMHARDER_TIME_ZONE: z.string().optional(),
  AIMHARDER_BOOKING_WINDOW_DAYS: z.string().optional(),
  AIMHARDER_CANCELLATION_WINDOW_MINUTES: z.string().optional(),
  AIMHARDER_REQUIRE_BOOKING_CONFIRMATION: z.enum(['true', 'false']).optional(),
  AIMHARDER_PARTICIPANTS_FILTER: z.string().optional(),
  AIMHARDER_WORKOUT_CLASS: z.string().optional(),
  AIMHARDER_BOOKING_PLAN: z.string().optional(),
  AIMHARDER_FRIENDS: z.string().optional(),
});

/**
 * The account's configuration for its one gym. `gym` is the chosen gym (the only one is used when none is chosen);
 * `timeZone` is the zone the account holder confirmed for it. Undefined or null values mean none is configured.
 */
export interface Configuration {
  username: string;
  password: string;
  gym?: string | undefined;
  timeZone?: string | undefined;
  bookingWindowDays?: number | undefined;
  cancellationWindowMinutes?: number | undefined;
  workoutClass?: string | undefined;
  bookingPlan?: BookingPlan | undefined;
  participantsFilter?: ParticipantsFilterValue | undefined;
  friends?: Friends | undefined;
  requireBookingConfirmation?: boolean | undefined;
}

/** Per-gym values of earlier versions (a JSON object keyed by gym ID), which now stop the server with how to rename them. */
function legacy(environment: Record<string, string | undefined>) {
  const looksLikeObject = (value: string | undefined) => value !== undefined && value.trim().startsWith('{');
  return environment.AIMHARDER_DEFAULT_GYM !== undefined || environment.AIMHARDER_GYM_TIME_ZONES !== undefined
    || ['AIMHARDER_BOOKING_WINDOW_DAYS', 'AIMHARDER_CANCELLATION_WINDOW_MINUTES', 'AIMHARDER_WORKOUT_CLASS', 'AIMHARDER_BOOKING_PLAN'].some((name) => looksLikeObject(environment[name]));
}

export function readConfiguration(environment: Record<string, string | undefined>): Configuration {
  if (legacy(environment)) throw new AimHarderError('LEGACY_CONFIGURATION');
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) throw new AimHarderError('INVALID_CONFIGURATION');
  const zone = parsed.data.AIMHARDER_TIME_ZONE;
  if (zone !== undefined && !timeZoneSchema.safeParse(zone).success) throw new AimHarderError('INVALID_TIME_ZONE_CONFIGURATION');
  const workoutClass = parsed.data.AIMHARDER_WORKOUT_CLASS;
  if (workoutClass !== undefined && !className.safeParse(workoutClass).success) throw new AimHarderError('INVALID_WORKOUT_CLASS_CONFIGURATION');
  const filterValue = parsed.data.AIMHARDER_PARTICIPANTS_FILTER ?? 'all';
  if (filterValue !== 'all' && filterValue !== 'friends') throw new AimHarderError('INVALID_PARTICIPANTS_FILTER_CONFIGURATION');
  return {
    username: parsed.data.AIMHARDER_USERNAME,
    password: parsed.data.AIMHARDER_PASSWORD,
    gym: parsed.data.AIMHARDER_GYM,
    timeZone: zone,
    bookingWindowDays: numberSetting(parsed.data.AIMHARDER_BOOKING_WINDOW_DAYS, bookingWindowSchema, 'INVALID_BOOKING_WINDOW_CONFIGURATION'),
    cancellationWindowMinutes: numberSetting(parsed.data.AIMHARDER_CANCELLATION_WINDOW_MINUTES, cancellationWindowSchema, 'INVALID_CANCELLATION_WINDOW_CONFIGURATION'),
    workoutClass: workoutClass === undefined ? undefined : className.parse(workoutClass),
    bookingPlan: jsonSetting(parsed.data.AIMHARDER_BOOKING_PLAN, bookingPlanSchema, [], 'INVALID_BOOKING_PLAN_CONFIGURATION'),
    participantsFilter: filterValue,
    friends: jsonSetting(parsed.data.AIMHARDER_FRIENDS, friendsSchema, {}, 'INVALID_FRIENDS_CONFIGURATION') as Friends,
    requireBookingConfirmation: parsed.data.AIMHARDER_REQUIRE_BOOKING_CONFIRMATION !== 'false',
  };
}

/**
 * Settings each account holder edits on the settings page; they override the environment for that account. Null clears
 * what the environment sets: choosing another gym clears every one of them.
 */
export const userSettingsSchema = z.object({
  gym: gymIdSchema.optional(),
  timeZone: timeZoneSchema.nullable().optional(),
  bookingWindowDays: bookingWindowSchema.nullable().optional(),
  cancellationWindowMinutes: cancellationWindowSchema.nullable().optional(),
  /** The class meant by "today's workout", or null for none. */
  workoutClass: className.nullable().optional(),
  bookingPlan: bookingPlanSchema.optional(),
  participantsFilter: z.enum(participantsFilterValues).optional(),
  friends: friendsSchema.optional(),
  /** Set back to true (the default) when the account chooses another gym; not edited on the settings page. */
  requireBookingConfirmation: z.boolean().optional(),
}).strict();
export type UserSettings = z.infer<typeof userSettingsSchema>;

/**
 * The settings of an account that has just chosen another gym: every other setting cleared, the environment's included,
 * because they all refer to the previous gym. A setting added to `userSettingsSchema` belongs here too.
 */
export const newGymSettings = (gym: string): Required<UserSettings> => ({
  gym, timeZone: null, bookingWindowDays: null, cancellationWindowMinutes: null, workoutClass: null, bookingPlan: [],
  participantsFilter: 'all', friends: {}, requireBookingConfirmation: true,
});

/** Layer the account's own settings over a configuration; null clears a value. */
export function applySettings(base: Configuration, user: UserSettings): Configuration {
  const value = <T>(own: T | null | undefined, environment: T | undefined) => (own === undefined ? environment : own ?? undefined);
  return {
    ...base,
    gym: value(user.gym, base.gym),
    timeZone: value(user.timeZone, base.timeZone),
    bookingWindowDays: value(user.bookingWindowDays, base.bookingWindowDays),
    cancellationWindowMinutes: value(user.cancellationWindowMinutes, base.cancellationWindowMinutes),
    workoutClass: value(user.workoutClass, base.workoutClass),
    bookingPlan: value(user.bookingPlan, base.bookingPlan),
    participantsFilter: value(user.participantsFilter, base.participantsFilter),
    friends: value(user.friends, base.friends),
    requireBookingConfirmation: value(user.requireBookingConfirmation, base.requireBookingConfirmation),
  };
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopback = (url: URL) => loopbackHosts.has(url.hostname);
const urlSchema = z.string().refine((value) => URL.canParse(value)).transform((value) => new URL(value));
const publicUrlSchema = urlSchema.refine((url) =>
  (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url)))
  && url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '');
const redirectUriSchema = urlSchema.refine((url) =>
  (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url))) && url.hash === '');
const httpEnvironmentSchema = z.object({
  MCP_PUBLIC_URL: publicUrlSchema,
  MCP_OWNER_SECRET: z.string().min(16),
  MCP_HTTP_HOST: z.string().min(1).optional(),
  PORT: z.string().regex(/^\d{1,5}$/).transform(Number).refine((port) => port >= 1 && port <= 65_535).optional(),
  MCP_OAUTH_REDIRECT_URIS: z.string().optional(),
  MCP_DATA_DIR: z.string().min(1).optional(),
});

/** OAuth redirect URIs accepted by default: Claude and ChatGPT connectors. Loopback URIs (local clients) are always accepted. */
export const defaultRedirectUris = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://platform.openai.com/apps-manage/oauth',
];

export type HttpConfiguration = ReturnType<typeof readHttpConfiguration>;

/** The transport: stdio (default) or HTTP. */
export function readTransport(environment: Record<string, string | undefined>) {
  const transport = environment.MCP_TRANSPORT ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') throw new AimHarderError('INVALID_HTTP_CONFIGURATION');
  return transport;
}

/** Settings of the remote HTTP transport: public origin, owner secret, listening address, extra OAuth redirect URIs and data directory. */
export function readHttpConfiguration(environment: Record<string, string | undefined>) {
  const parsed = httpEnvironmentSchema.safeParse(environment);
  if (!parsed.success) throw new AimHarderError('INVALID_HTTP_CONFIGURATION');
  const extra = (parsed.data.MCP_OAUTH_REDIRECT_URIS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const redirects = z.array(redirectUriSchema).safeParse(extra);
  if (!redirects.success) throw new AimHarderError('INVALID_HTTP_CONFIGURATION');
  return {
    publicUrl: parsed.data.MCP_PUBLIC_URL,
    mcpUrl: new URL('/mcp', parsed.data.MCP_PUBLIC_URL),
    ownerSecret: parsed.data.MCP_OWNER_SECRET,
    host: parsed.data.MCP_HTTP_HOST ?? '127.0.0.1',
    port: parsed.data.PORT ?? 3000,
    redirectUris: [...defaultRedirectUris, ...redirects.data.map((url) => url.href)],
    dataDir: parsed.data.MCP_DATA_DIR ?? 'data',
  };
}

/** Whether OAuth may redirect to this URI: an allowed exact URI, or any loopback http(s) URI (RFC 8252). */
export function isAllowedRedirectUri(value: string, allowed: readonly string[]) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.hash !== '') return false;
  if (isLoopback(url)) return url.protocol === 'http:' || url.protocol === 'https:';
  if (/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(value)) return true;
  return url.protocol === 'https:' && allowed.includes(url.href);
}

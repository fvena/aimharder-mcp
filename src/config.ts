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
const className = z.string().trim().min(1).max(300);
const workoutClassesSchema = z.record(gymIdSchema, className);
export const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = typeof weekdays[number];
const plannedClassSchema = z.object({ className, startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).strict();
export type PlannedClass = z.infer<typeof plannedClassSchema>;
const bookingPlansSchema = z.record(gymIdSchema, z.partialRecord(z.enum(weekdays), plannedClassSchema));
export type BookingPlan = Partial<Record<Weekday, PlannedClass>>;
/** Friends: AimHarder user IDs (as strings) to a label chosen by the account holder. */
export const friendsSchema = z.record(z.string().regex(/^[1-9]\d{0,15}$/), z.string().trim().min(1).max(100))
  .refine((friends) => Object.keys(friends).length <= 200);
export type Friends = Record<string, string>;

/** Parse an optional JSON environment value with a schema, or fail with one public error code. */
function jsonSetting<T>(value: string | undefined, schema: z.ZodType<T>, fallback: T, code: ConstructorParameters<typeof AimHarderError>[0]): T {
  if (value === undefined) return fallback;
  try { return schema.parse(JSON.parse(value)); }
  catch { throw new AimHarderError(code); }
}
const environmentSchema = z.object({
  AIMHARDER_USERNAME: nonEmpty,
  AIMHARDER_PASSWORD: nonEmpty,
  AIMHARDER_DEFAULT_GYM: gymIdSchema.optional(),
  AIMHARDER_GYM_TIME_ZONES: z.string().optional(),
  AIMHARDER_BOOKING_WINDOW_DAYS: z.string().optional(),
  AIMHARDER_CANCELLATION_WINDOW_MINUTES: z.string().optional(),
  AIMHARDER_REQUIRE_BOOKING_CONFIRMATION: z.enum(['true', 'false']).optional(),
  AIMHARDER_PARTICIPANTS_FILTER: z.string().optional(),
  AIMHARDER_WORKOUT_CLASS: z.string().optional(),
  AIMHARDER_BOOKING_PLAN: z.string().optional(),
  AIMHARDER_FRIENDS: z.string().optional(),
});
export type Configuration = Omit<ReturnType<typeof readConfiguration>, 'requireBookingConfirmation' | 'bookingWindowDays' | 'cancellationWindowMinutes' | 'participantsFilter' | 'workoutClasses' | 'bookingPlans' | 'friends'> & { friends?: Friends; workoutClasses?: Record<string, string>; bookingPlans?: Record<string, BookingPlan>; requireBookingConfirmation?: boolean; bookingWindowDays?: Record<string, number>; cancellationWindowMinutes?: Record<string, number>; participantsFilter?: 'all' | 'following' };

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
  const filterValue = parsed.data.AIMHARDER_PARTICIPANTS_FILTER ?? 'all';
  if (filterValue !== 'all' && filterValue !== 'following') throw new AimHarderError('INVALID_PARTICIPANTS_FILTER_CONFIGURATION');
  const filter: 'all' | 'following' = filterValue;
  return {
    gymTimeZones,
    bookingWindowDays,
    cancellationWindowMinutes,
    participantsFilter: filter,
    workoutClasses: jsonSetting(parsed.data.AIMHARDER_WORKOUT_CLASS, workoutClassesSchema, {}, 'INVALID_WORKOUT_CLASS_CONFIGURATION'),
    bookingPlans: jsonSetting(parsed.data.AIMHARDER_BOOKING_PLAN, bookingPlansSchema, {}, 'INVALID_BOOKING_PLAN_CONFIGURATION') as Record<string, BookingPlan>,
    friends: jsonSetting(parsed.data.AIMHARDER_FRIENDS, friendsSchema, {}, 'INVALID_FRIENDS_CONFIGURATION') as Friends,
    requireBookingConfirmation: parsed.data.AIMHARDER_REQUIRE_BOOKING_CONFIRMATION !== 'false',
    username: parsed.data.AIMHARDER_USERNAME,
    password: parsed.data.AIMHARDER_PASSWORD,
    defaultGym: parsed.data.AIMHARDER_DEFAULT_GYM,
  };
}

/** Preferences each account holder edits on the settings page; they override the environment for that account. */
export const userSettingsSchema = z.object({
  defaultGym: gymIdSchema.optional(),
  workoutClasses: workoutClassesSchema.optional(),
  bookingPlans: bookingPlansSchema.optional(),
  participantsFilter: z.enum(['all', 'following']).optional(),
  friends: friendsSchema.optional(),
}).strict();
export type UserSettings = z.infer<typeof userSettingsSchema>;
/** Rules of a gym, shared by every account; only the owner edits them. They override the environment. */
export const gymSettingsSchema = z.object({
  gymTimeZones: timeZonesSchema.optional(),
  bookingWindowDays: bookingWindowsSchema.optional(),
  cancellationWindowMinutes: cancellationWindowsSchema.optional(),
}).strict();
export type GymSettings = z.infer<typeof gymSettingsSchema>;

/** Layer gym settings, then the account's own settings, over a configuration. Per-gym values merge by gym ID. */
export function applySettings<T extends Configuration>(base: T, gym: GymSettings, user: UserSettings): T {
  return {
    ...base,
    gymTimeZones: { ...base.gymTimeZones, ...gym.gymTimeZones },
    bookingWindowDays: { ...base.bookingWindowDays, ...gym.bookingWindowDays },
    cancellationWindowMinutes: { ...base.cancellationWindowMinutes, ...gym.cancellationWindowMinutes },
    workoutClasses: { ...base.workoutClasses, ...user.workoutClasses },
    bookingPlans: { ...base.bookingPlans, ...(user.bookingPlans as Record<string, BookingPlan> | undefined) },
    ...(user.defaultGym === undefined ? {} : { defaultGym: user.defaultGym }),
    ...(user.participantsFilter === undefined ? {} : { participantsFilter: user.participantsFilter }),
    ...(user.friends === undefined ? {} : { friends: user.friends }),
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

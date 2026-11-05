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

/** Settings of the remote HTTP transport: public origin, owner secret, listening address and extra OAuth redirect URIs. */
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
  };
}

/** Whether OAuth may redirect to this URI: an allowed exact URI, or any loopback http(s) URI (RFC 8252). */
export function isAllowedRedirectUri(value: string, allowed: readonly string[]) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.hash !== '') return false;
  if (isLoopback(url)) return url.protocol === 'http:' || url.protocol === 'https:';
  return url.protocol === 'https:' && allowed.includes(url.href);
}

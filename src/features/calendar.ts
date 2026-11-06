import { createHash } from 'node:crypto';
import type { Gym } from '../upstream.js';
import { getUpcomingBookings } from './bookings.js';
import type { Context } from './context.js';

/** One upcoming booking as a calendar event, with its start and end as UTC instants (milliseconds). */
interface BookingEvent {
  uid: string;
  gym: Gym;
  className: string;
  start: number;
  end: number;
  state: 'booked' | 'waitlisted' | 'unknown';
}

/**
 * The account's upcoming bookings at its gym, as an iCalendar (RFC 5545) feed for calendar apps.
 *
 * It covers what get_upcoming_bookings reads: AimHarder's upcoming view, so cancelled and past bookings are not in it.
 * Each booking keeps the same UID on every read (its AimHarder ID at its gym), whatever address serves the feed, so
 * subscribers update it in place. Gym-local wall times become UTC instants through the gym's zone. A gym that cannot be
 * read fails the whole feed: an empty feed would make subscribers delete the bookings they have.
 */
async function upcomingBookingsCalendar(ctx: Context, now = new Date()) {
  const { gym, bookings } = await getUpcomingBookings(ctx);
  const events: BookingEvent[] = bookings.map((booking) => {
    const endTime = booking.timeLabel.slice(-5);
    // A class that ends at or before it starts ends the next day.
    const endDate = endTime > booking.startTime ? booking.date : nextDay(booking.date);
    return {
      uid: `${gym.id}-${booking.sourceBookingId}@aimharder-mcp`, gym, className: booking.classType.name ?? 'Clase',
      start: instant(booking.date, booking.startTime, gym.timeZone), end: instant(endDate, endTime, gym.timeZone), state: booking.state,
    };
  });
  events.sort((a, b) => a.start - b.start || a.uid.localeCompare(b.uid));
  // The tag follows what the feed says, not when it was generated (DTSTAMP).
  const etag = `"${createHash('sha256').update(JSON.stringify(events)).digest('base64url').slice(0, 27)}"`;
  return { body: icalendar(events, now), etag, events };
}

type Feed = Awaited<ReturnType<typeof upcomingBookingsCalendar>>;

/** How long an account's feed is kept before AimHarder is read again, in seconds; also the feed's `max-age`. */
export const calendarCacheSeconds = 300;

/**
 * Each account's calendar feed, read from AimHarder at most every `calendarCacheSeconds`. Concurrent requests share one
 * read, and a failed read is not kept, so the next request reads again.
 */
export class CalendarFeeds {
  readonly #feeds = new Map<string, { at: number; feed: Promise<Feed> }>();

  read(sub: string, ctx: Context): Promise<Feed> {
    let cached = this.#feeds.get(sub);
    if (!cached || Date.now() - cached.at >= calendarCacheSeconds * 1000) {
      const entry = { at: Date.now(), feed: upcomingBookingsCalendar(ctx) };
      this.#feeds.set(sub, entry);
      entry.feed.catch(() => { if (this.#feeds.get(sub) === entry) this.#feeds.delete(sub); });
      cached = entry;
    }
    return cached.feed;
  }
}

/**
 * Whether an `If-None-Match` header matches a feed's tag: `*`, or any listed tag, weak or strong (RFC 9110 weak
 * comparison). Compared here rather than with Express's `req.fresh`, which ignores the header when the request says
 * `no-cache`, as `fetch()` does for every conditional request.
 */
export function matchesTag(header: string | undefined, etag: string) {
  const tags = (header ?? '').split(',').map((tag) => tag.trim().replace(/^W\//, ''));
  return tags.includes('*') || tags.includes(etag);
}

/** What each booking state says as an event status: only what AimHarder states, so another state has none. */
const statuses = { booked: 'CONFIRMED', waitlisted: 'TENTATIVE', unknown: undefined } as const;

/** Serialize events as an iCalendar object, with CRLF line endings and lines folded at 75 octets. */
function icalendar(events: BookingEvent[], now: Date) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//aimharder-mcp//Reservas//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:AimHarder', 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    ...events.flatMap((event) => {
      const status = statuses[event.state];
      return [
        'BEGIN:VEVENT', `UID:${text(event.uid)}`, `DTSTAMP:${utcStamp(now.getTime())}`,
        `DTSTART:${utcStamp(event.start)}`, `DTEND:${utcStamp(event.end)}`,
        `SUMMARY:${text(event.state === 'waitlisted' ? `${event.className} (lista de espera)` : event.className)}`,
        `LOCATION:${text(event.gym.name)}`,
        ...(status ? [`STATUS:${status}`] : []), 'TRANSP:OPAQUE', 'END:VEVENT',
      ];
    }),
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/**
 * The UTC instant of a gym-local wall time in an IANA zone: the offset at a first guess, checked once. A time skipped by
 * a change to summer time moves forward by the change; a repeated time takes its second occurrence. Classes are not
 * scheduled then.
 */
function instant(date: string, time: string, zone: string) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  return wall - offsetAt(zone, wall - offsetAt(zone, wall) * 60_000) * 60_000;
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
/** The zone's UTC offset in minutes at an instant. */
function offsetAt(zone: string, instant: number) {
  let format = offsetFormats.get(zone);
  if (!format) { format = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }); offsetFormats.set(zone, format); }
  const name = format.formatToParts(new Date(instant))
    .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

const utcStamp = (instant: number) => `${new Date(instant).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** An RFC 5545 TEXT value: escaped separators and line breaks, without other control characters. */
function text(value: string) {
  return value.replace(/\r\n|\r|\n/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Fold a content line into lines of at most 75 octets, never inside a UTF-8 character. */
function fold(line: string) {
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > (parts.length ? 74 : 75)) { parts.push(current); current = ''; size = 0; }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

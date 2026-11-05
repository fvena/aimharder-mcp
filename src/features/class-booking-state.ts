import { classBookingRows, type ClassBookingRow, type ClassTarget } from '../domain/booking-preparation.js';
import { parseUpcomingBookings } from '../domain/bookings.js';
import type { BoxSession } from '../upstream.js';

// Where one exact class stands for this account, from the two views AimHarder offers: the account-scoped daily schedule,
// which is authoritative and carries the reservation, and the upcoming-bookings view, which can only corroborate it.

/** The account's daily-schedule rows of this exact class (one fresh read). */
export async function scheduleRows(session: BoxSession, target: ClassTarget): Promise<ClassBookingRow[]> {
  const { gym } = session;
  return classBookingRows(await session.read({ kind: 'schedule', boxId: session.boxId, date: target.date }), gym.id, target.date, gym.timeZone, target);
}

/**
 * Whether the upcoming view may already cover this class: an entry with its date, start and end time, and its class
 * name or none (one fresh read). Upcoming source IDs are not class-session IDs, so the match is by these fields.
 */
export async function upcomingEntries(session: BoxSession, target: ClassTarget & { endTime: string }) {
  const upcoming = parseUpcomingBookings(await session.read({ kind: 'upcoming', boxId: session.boxId }), session.gym.timeZone);
  return upcoming.filter((item) => item.date === target.date && item.startTime === target.startTime
    && item.timeLabel.endsWith(target.endTime) && (item.classType.name === target.className || item.classType.name === null));
}

/**
 * Whether the upcoming view contradicts a schedule state: several matching entries, or one in another state.
 * The view has no verified horizon, so absence never contradicts the schedule.
 */
export async function upcomingContradicts(session: BoxSession, target: ClassTarget & { endTime: string }, state: string) {
  const matches = await upcomingEntries(session, target);
  return matches.length > 1 || matches.some((item) => item.state !== state);
}

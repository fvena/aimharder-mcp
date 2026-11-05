import { AimHarderError } from '../errors.js';
import { type Gym } from '../upstream.js';
import { parseFollowingPage, parseParticipants, participantsQuerySchema, type ParticipantsQuery } from '../domain/participants.js';
import { type GymSession } from '../upstream.js';
import { calendarDates, classQuerySchema, parseClassDay, type ClassQuery, type ClassSession } from '../domain/classes.js';
import { bookingWindow } from '../domain/booking-preparation.js';
import { gymRule, type Context } from './context.js';

export interface ClassSchedule {
  gym: Gym;
  startDate: string;
  endDate: string;
  coverage: 'complete';
  sessions: ClassSession[];
  notices: string[];
}

export function getClassSessions(ctx: Context, input: ClassQuery): Promise<ClassSchedule> {
  const parsed = classQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_CLASS_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    if (!gym.timeZone) throw new AimHarderError('GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_CLASS_RESPONSE');
    const sessions: ClassSession[] = [];
    for (const date of calendarDates(query.startDate, query.endDate)) {
      const body = await session.read({ kind: 'schedule', boxId, date });
      // Validate the entire day before filtering. A malformed nonmatching session
      // must not turn an incomplete upstream result into a successful query.
      sessions.push(...parseClassDay(body, gym.id, date, gym.timeZone).filter((session) =>
        (query.startTime === undefined || session.startTime === query.startTime)
        && (query.className === undefined || session.classType.name === query.className)));
    }
    const windowDays = gymRule(ctx.config.bookingWindowDays, gym.id);
    if (windowDays !== undefined) for (const session of sessions) Object.assign(session, bookingWindow(session.date, session.startTime, gym.timeZone, windowDays));
    return {
      gym, startDate: query.startDate, endDate: query.endDate, coverage: 'complete', sessions,
      notices: [
        'Occupancy is the source occupied-place count, not actual attendance. Capacity alone does not establish booking eligibility.',
        'Times are gym-local wall times in the reported IANA zone. The zone may be assumed; no UTC instant is inferred, including at daylight-saving transitions.',
        'Coverage describes successful daily schedule retrieval, not all possible future publications or booking availability.',
        ...(windowDays !== undefined ? [`bookingOpensAt and bookingOpen apply the configured ${windowDays}-day booking window: booking opens ${windowDays} days before the class start at the same gym-local wall time. Do not try to book a session whose bookingOpen is false; tell the account holder when it opens. AimHarder still decides actual eligibility.`] : []),
      ],
    };
  });
}


export function getClassParticipants(ctx: Context, input: ParticipantsQuery) {
  const parsed = participantsQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_PARTICIPANTS_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    if (!gym.timeZone) throw new AimHarderError('GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_CLASS_RESPONSE');
    const sessions = parseClassDay(await session.read({ kind: 'schedule', boxId, date: query.date }), gym.id, query.date, gym.timeZone)
      .filter(row => row.classType.name === query.className && row.startTime === query.startTime);
    const base = { gym, target: { date: query.date, className: query.className, startTime: query.startTime } };
    const privacy = 'Participant names are other members\' personal data. Use them only to answer the account holder; do not store or share them elsewhere.';
    if (sessions.length !== 1) return { ...base, status: sessions.length ? 'ambiguous' as const : 'missing' as const, session: null, participants: [],
      notices: [sessions.length ? 'Several sessions match this class name and start time; no participant list was requested.' : 'No session with this exact class name and start time was found in the daily schedule.'] };
    const classSession = sessions[0]!;
    const all = parseParticipants(await session.read({ kind: 'participants', boxId, date: query.date, sessionId: classSession.sourceId }));
    const filter = query.filter ?? ctx.config.participantsFilter ?? 'all';
    const followed = filter === 'following' && all.length ? await followedAthletes(session) : new Set<number>();
    const participants = filter === 'following' ? all.filter(participant => followed.has(participant.userId)) : all;
    return { ...base, status: 'available' as const, filter, totalParticipants: all.length,
      session: { sessionId: classSession.sessionId, timeLabel: classSession.timeLabel, occupancy: classSession.occupancy, capacity: classSession.capacity, coach: classSession.coach },
      participants, notices: [
        'Participants come from the AimHarder app API for this exact session. The list can change until the class starts; sourceState is a raw value whose meaning is unverified.',
        ...(filter === 'following' ? [`Filtered to athletes the account follows in AimHarder: ${participants.length} of ${all.length} participants. Follow or unfollow athletes in the AimHarder app to change this list.`] : []),
        privacy,
      ] };
  });
}

/** User IDs of the athletes the account follows, across every page of the followed list. */
async function followedAthletes(session: GymSession) {
  const ids = new Set<number>();
  for (let page = 0; page < 20; page++) {
    const { size, athleteIds } = parseFollowingPage(await session.read({ kind: 'following', page }));
    athleteIds.forEach(id => ids.add(id));
    if (size === 0) return ids;
  }
  throw new AimHarderError('INVALID_FOLLOWING_RESPONSE');
}

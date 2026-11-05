import { z } from 'zod';
import { AimHarderError } from '../errors.js';
import { type GymSession } from '../upstream.js';
import { parseUpcomingBookings, parseBookingHistory } from '../domain/bookings.js';
import { insideCancellationWindow, bookingCandidates, bookingWindow, bookingCreationQuerySchema, bookingCancellationQuerySchema, bookingExecutionSchema, lateCancellationExecutionSchema, cancellationCandidates, plannedBookingQuerySchema, type PlannedBookingQuery, type BookingCreationQuery, type BookingCreationPreview, type BookingCancellationQuery, type BookingCancellationPreview, type BookingExecution, type LateCancellationExecution } from '../domain/booking-preparation.js';
import { gymRule, requireWriteConfirmation, type Context } from './context.js';
import { calendarDates } from '../domain/classes.js';
import { weekdays } from '../config.js';

function bookingResponseDenied(response:unknown):boolean {
  const denial=z.object({bookState:z.number().int().negative().optional(),errorMssg:z.unknown().optional(),errorMssgLang:z.unknown().optional()}).safeParse(response);
  return denial.success&&(denial.data.bookState!==undefined||denial.data.errorMssg!==undefined||denial.data.errorMssgLang!==undefined);
}

export function prepareBookingCreation(ctx: Context, input: BookingCreationQuery) {
  const parsed = bookingCreationQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_BOOKING_PREPARATION_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    if (gym.timeZoneStatus !== 'user-confirmed' || !gym.timeZone) throw new AimHarderError('CONFIRMED_GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_CLASS_RESPONSE');
    return prepareOneBooking(ctx, session, boxId, gym.timeZone, query);
  }).then(result => ({ ...result, writeConfirmationRequired: ctx.config.requireBookingConfirmation !== false }));
}


/**
 * Preview booking each planned class (AIMHARDER_BOOKING_PLAN) in a date range: one single-use reference per
 * ready class, each executed separately with execute_booking_creation. A day with several planned classes has one entry per class;
 * days without a plan entry are listed as not-planned.
 */
export function preparePlannedBookings(ctx: Context, input: PlannedBookingQuery) {
  const parsed = plannedBookingQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_PLANNED_BOOKING_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    if (gym.timeZoneStatus !== 'user-confirmed' || !gym.timeZone) throw new AimHarderError('CONFIRMED_GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_CLASS_RESPONSE');
    const plan = ctx.config.bookingPlans && Object.hasOwn(ctx.config.bookingPlans, gym.id) ? ctx.config.bookingPlans[gym.id]! : [];
    const days = [];
    for (const date of calendarDates(query.startDate, query.endDate)) {
      const weekday = weekdays[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!;
      const entries = plan.filter((entry) => entry.day === weekday);
      if (!entries.length) { days.push({ date, weekday, status: 'not-planned' as const }); continue; }
      for (const { className, startTime } of entries) {
        const { gym: _gym, action: _action, ...result } = await prepareOneBooking(ctx, session, boxId, gym.timeZone, { date, className, startTime });
        days.push({ date, weekday, ...result });
      }
    }
    const planned = plan.length > 0;
    return { action: 'create' as const, gym, startDate: query.startDate, endDate: query.endDate, plan, days,
      writeConfirmationRequired: ctx.config.requireBookingConfirmation !== false,
      notices: [
        planned ? 'Each ready day has its own single-use reference that expires in two minutes. Show the whole list, then execute each ready day separately with execute_booking_creation; every execution sends at most one booking request.'
          : 'No booking plan is configured for this gym (AIMHARDER_BOOKING_PLAN). Ask the account holder which classes to book, or book exact classes with prepare_booking_creation.',
        'Ask the account holder about days that are not-planned, missing, ambiguous or unsupported instead of choosing another class. For not-yet-open days, report bookingOpensAt and do not retry before then.',
        'This is a read-only schedule snapshot. Preparation does not reserve a place or prove final eligibility.',
      ] };
  });
}


/** Preview one booking in the gym's daily schedule; a missing end time matches any end time (as in a booking plan). */
async function prepareOneBooking(ctx: Context, session: GymSession, boxId: number, timeZone: string, query: { date: string; className: string; startTime: string; endTime?: string }) {
  const { gym } = session;
  const body = await session.read({ kind: 'schedule', boxId, date: query.date });
  const candidates = bookingCandidates(body, gym.id, query.date, timeZone, query);
  const alternatives = candidates.map(({ sourceId: _sourceId, ...candidate }) => candidate);
  const base = { action: 'create' as const, gym, target: {
    className: query.className, date: query.date, startTime: query.startTime,
    endTime: query.endTime ?? (candidates.length === 1 ? candidates[0]!.endTime : null),
  }, alternatives };
  if (candidates.length !== 1) return { ...base, status: candidates.length ? 'ambiguous' as const : 'missing' as const,
    notices: [candidates.length ? 'Several exact class sessions match. Choose a different date or time; no booking can be prepared.' : 'No exact class session was found in the retrieved daily schedule.'] };
  const candidate = candidates[0]!;
  const target = { ...base.target, endTime: candidate.endTime };
  const windowDays = gymRule(ctx.config.bookingWindowDays, gym.id);
  const window = windowDays === undefined ? undefined : bookingWindow(query.date, query.startTime, timeZone, windowDays);
  if (window && !window.bookingOpen && candidate.currentState === 'unbooked') return { ...base, target, status: 'not-yet-open' as const, currentState: candidate.currentState, bookingOpensAt: window.bookingOpensAt,
    notices: [`Booking for this class opens at ${window.bookingOpensAt.replace('T', ' ')} gym-local time under the configured ${windowDays}-day booking window. No reference was issued and no request was sent. Do not retry before then.`] };
  const status = candidate.currentState === 'booked' ? 'already-booked' as const
    : candidate.currentState === 'waitlisted' ? 'waitlisted' as const
      : candidate.eligibility === 'offered' ? 'ready' as const : 'unsupported' as const;
  const notices = [
    'This is a read-only schedule snapshot. Preparation does not reserve a place or prove final eligibility.',
  ];
  if (status !== 'ready') return { ...base, target, status, currentState: candidate.currentState, notices };
  const preview: BookingCreationPreview = {
    action: 'create', gym: { ...gym, timeZone, timeZoneStatus: 'user-confirmed' },
    target, currentState: 'unbooked',
    notices,
  };
  return { status, ...preview, alternatives, ...ctx.bookingPreparations.issue(session.accountId, boxId, candidate.sourceId, preview) };
}


export function executeBookingCreation(ctx: Context, input: BookingExecution) {
  const parsed = bookingExecutionSchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_BOOKING_EXECUTION_QUERY'));
  try { requireWriteConfirmation(parsed.data.confirmed, ctx.config.requireBookingConfirmation !== false); }
  catch (error) { return Promise.reject(error); }
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    // The reference is consumed before any source access, including failed preflight reads.
    const entry = ctx.bookingPreparations.take(query.actionReference, 'create', session.accountId, gym.id);
    if (!entry) throw new AimHarderError('BOOKING_REFERENCE_INVALID');
    const { preview } = entry;
    const target = preview.target;
    const base = { action: 'create' as const, gym, target };
    if (boxId !== entry.boxId || gym.timeZoneStatus !== 'user-confirmed' || gym.timeZone !== preview.gym.timeZone || gym.name !== preview.gym.name) {
      return { ...base, status: 'stale' as const, observedState: 'unknown' as const, notices: ['Account, gym, or confirmed time zone changed. No booking request was sent.'] };
    }
    const before = bookingCandidates(await session.read({ kind: 'schedule', boxId, date: target.date }), gym.id, target.date, gym.timeZone, target);
    if (before.length !== 1 || before[0]!.sourceId !== entry.sourceId || before[0]!.eligibility !== 'offered') {
      return { ...base, status: 'stale' as const, observedState: before.length === 1 ? before[0]!.currentState : 'unknown' as const,
        notices: ['The exact class or its offered state changed. No booking request was sent.'] };
    }
    const upcomingBefore = parseUpcomingBookings(await session.read({ kind: 'upcoming', boxId }), gym.timeZone);
    const matchesTarget = (item: (typeof upcomingBefore)[number]) => item.date === target.date && item.startTime === target.startTime
      && item.timeLabel.endsWith(target.endTime) && (item.classType.name === target.className || item.classType.name === null);
    if (upcomingBefore.some(matchesTarget)) {
      return { ...base, status: 'stale' as const, observedState: 'unknown' as const,
        notices: ['A current upcoming entry may already cover this class. No booking request was sent.'] };
    }
    // At most one write; its outcome is decided by fresh reads, never by resending.
    let response: unknown;
    let writeIssue = false;
    try {
      response = await session.write({ kind: 'book', sessionId: entry.sourceId, date: target.date });
      if (!z.record(z.string(), z.unknown()).safeParse(response).success) writeIssue = true;
    } catch { writeIssue = true; }
    return reconcileBookingCreation(session, { preview, boxId, sourceId: entry.sourceId }, response, writeIssue);
  });
}


async function reconcileBookingCreation(session: GymSession, dispatch: { preview: BookingCreationPreview; boxId: number; sourceId: number }, response: unknown, writeIssue: boolean) {
  const { preview, boxId, sourceId } = dispatch;const {gym,target}=preview;
  const base={action:'create' as const,gym,target};
  const matchesTarget=(item:{date:string|null;startTime:string|null;timeLabel:string;classType:{name:string|null}})=>item.date===target.date&&item.startTime===target.startTime&&item.timeLabel.endsWith(target.endTime)&&(item.classType.name===target.className||item.classType.name===null);
    let scheduleState: 'unbooked' | 'booked' | 'waitlisted' | 'unknown' = 'unknown';
    let conflicting = false;
    let reconciliationIssue = false;
    try {
      const after = bookingCandidates(await session.read({ kind: 'schedule', boxId, date: target.date }), gym.id, target.date, gym.timeZone, target);
      if (after.length === 1 && after[0]!.sourceId === sourceId) scheduleState = after[0]!.currentState;
      const upcoming = parseUpcomingBookings(await session.read({ kind: 'upcoming', boxId }), gym.timeZone);
      const matches = upcoming.filter(matchesTarget);
      // This view has no verified horizon; absence cannot contradict a fresh daily schedule.
      conflicting = matches.length > 1 || matches.some(item => item.state !== scheduleState);
    } catch { reconciliationIssue = true; }
    const denied = bookingResponseDenied(response);
    const status = conflicting || reconciliationIssue || (denied && scheduleState !== 'unbooked') ? 'uncertain' as const : scheduleState === 'booked' ? 'confirmed' as const
      : scheduleState === 'waitlisted' ? 'waitlisted' as const
        : scheduleState === 'unbooked' && denied ? 'rejected' as const : 'uncertain' as const;
    return { ...base, status, observedState: scheduleState, notices: [
      'One standard booking request was attempted. Fresh booking reads, not the HTTP response alone, determine the reported state.',
      status === 'confirmed' ? 'A fresh schedule read reported a confirmed booking.'
        : status === 'waitlisted' ? 'A fresh schedule read reported a waitlist state; no further write was sent.'
          : status === 'rejected' ? 'The source returned a denial indication and the fresh schedule remains unbooked. Denial semantics remain unverified live.'
            : 'The outcome is uncertain. Check the booking directly before preparing a new action; no automatic write retry was sent.',
      ...(writeIssue ? ['The write response was incomplete; use fresh booking reads to assess the outcome.'] : []),
      ...(reconciliationIssue ? ['A follow-up view could not be read completely; booking state remains uncertain.'] : []),
    ] };
}


export function prepareBookingCancellation(ctx: Context, input: BookingCancellationQuery) {
  const parsed = bookingCancellationQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_CANCELLATION_PREPARATION_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    if (gym.timeZoneStatus !== 'user-confirmed' || !gym.timeZone) throw new AimHarderError('CONFIRMED_GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_CLASS_RESPONSE');
    // This account-scoped daily schedule supplies idres; upcoming IDs are not a verified join.
    const body = await session.read({ kind: 'schedule', boxId, date: query.date });
    const candidates = cancellationCandidates(body, gym.id, query.date, gym.timeZone, query);
    const alternatives = candidates.map(({ reservationId: _reservationId, sourceId: _sourceId, ...candidate }) => candidate);
    const base = { action: 'cancel' as const, gym, target: {
      className: query.className, date: query.date, startTime: query.startTime, endTime: query.endTime,
    }, alternatives };
    if (candidates.length !== 1) return { ...base, status: candidates.length ? 'ambiguous' as const : 'missing' as const,
      notices: [candidates.length ? 'Several exact schedule rows match. No cancellation can be prepared.' : 'No exact class session was found in the retrieved daily schedule.'] };
    const candidate = candidates[0]!;
    const status = candidate.currentState === 'cancelled' ? 'already-cancelled' as const
      : candidate.eligibility === 'offered' ? 'ready' as const : 'unsupported' as const;
    const lateWindow = gymRule(ctx.config.cancellationWindowMinutes, gym.id);
    const notices = [
      'This is a read-only, account-scoped daily schedule snapshot. No cancellation request was sent.',
      'The credit balance, entitlement period, and effect of this cancellation are not verified.',
      ...(lateWindow !== undefined && insideCancellationWindow(query.date, query.startTime, gym.timeZone, lateWindow)
        ? [`The class starts within the configured ${lateWindow}-minute cancellation window. Cancelling now may lose one credit. This is a configured gym rule, not a verified balance or API decision.`] : []),
    ];
    if (status !== 'ready' || candidate.reservationId === null) return { ...base, status, currentState: candidate.currentState, notices };
    const preview: BookingCancellationPreview = {
      action: 'cancel', gym: { ...gym, timeZone: gym.timeZone, timeZoneStatus: 'user-confirmed' },
      target: base.target, currentState: 'booked',
      credit: { possibleLoss: lateWindow !== undefined
        ? `Under the configured rule, cancelling fewer than ${lateWindow} minutes before class loses a credit; the actual credit effect is not verified for this request.`
        : 'Cancellation may affect a credit; the actual effect is not verified for this request.',
      balance: null, entitlementPeriod: null }, notices,
    };
    return { status, ...preview, alternatives,
      ...ctx.bookingPreparations.issueCancellation(session.accountId, boxId, candidate.reservationId, preview) };
  }).then(result => ({ ...result, writeConfirmationRequired: true }));
}


export function executeBookingCancellation(ctx: Context, input: BookingExecution) {
  const parsed = bookingExecutionSchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_BOOKING_EXECUTION_QUERY'));
  try { requireWriteConfirmation(parsed.data.confirmed); }
  catch (error) { return Promise.reject(error); }
  return executeCancellation(ctx, parsed.data, false);
}


export function executeLateBookingCancellation(ctx: Context, input: LateCancellationExecution) {
  const parsed = lateCancellationExecutionSchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_LATE_CANCELLATION_QUERY'));
  try { requireWriteConfirmation(parsed.data.confirmedCreditLoss); }
  catch (error) { return Promise.reject(error); }
  return executeCancellation(ctx, parsed.data, true);
}


function executeCancellation(ctx: Context, query: { gymId?: string | undefined; actionReference: string }, late: boolean) {
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    const entry = late
      ? ctx.bookingPreparations.take(query.actionReference, 'cancel-late', session.accountId, gym.id)
      : ctx.bookingPreparations.take(query.actionReference, 'cancel', session.accountId, gym.id);
    if (!entry) throw new AimHarderError('BOOKING_REFERENCE_INVALID');
    const { preview } = entry;
    const target = preview.target;
    const base = { action: 'cancel' as const, gym, target, credit: preview.credit };
    if (boxId !== entry.boxId || gym.timeZoneStatus !== 'user-confirmed' || gym.timeZone !== preview.gym.timeZone || gym.name !== preview.gym.name) {
      return { ...base, status: 'stale' as const, observedState: 'unknown' as const,
        notices: ['Account, gym, or confirmed time zone changed. No cancellation request was sent.'] };
    }
    const before = cancellationCandidates(await session.read({ kind: 'schedule', boxId, date: target.date }), gym.id, target.date, gym.timeZone!, target);
    if (before.length !== 1 || before[0]!.reservationId !== entry.reservationId || before[0]!.eligibility !== 'offered') {
      return { ...base, status: 'stale' as const, observedState: before.length === 1 ? before[0]!.currentState : 'unknown' as const,
        notices: ['The exact reservation or its cancellation eligibility changed. No cancellation request was sent.'] };
    }
    const lateWindow = gymRule(ctx.config.cancellationWindowMinutes, gym.id);
    if (!late && lateWindow !== undefined && insideCancellationWindow(target.date, target.startTime, gym.timeZone!, lateWindow)
      && !preview.notices.some(notice => notice.includes('cancellation window'))) {
      return { ...base, status: 'stale' as const, observedState: 'booked' as const,
        notices: ['The configured cancellation window was reached after preparation. Prepare a new preview and confirm the possible credit loss before a cancellation request.'] };
    }
    // At most one write; its outcome is decided by fresh reads, never by resending.
    let response: unknown;
    let writeIssue = false;
    try { response = await session.write({ kind: 'cancel', reservationId: entry.reservationId, late }); }
    catch { writeIssue = true; }
    const parsedResponse = z.object({ cancelState: z.number().int() }).safeParse(response);
    return reconcileBookingCancellation(ctx, session, { preview, boxId, sourceId: before[0]!.sourceId, reservationId: entry.reservationId, late,
      cancelState: parsedResponse.success ? parsedResponse.data.cancelState : null, writeIssue });
  });
}


async function reconcileBookingCancellation(ctx: Context, session: GymSession, dispatch: { preview: BookingCancellationPreview; boxId: number; sourceId: number; reservationId: number; late: boolean; cancelState: number | null; writeIssue: boolean }) {
    const { preview, boxId, sourceId, reservationId, late, writeIssue } = dispatch; const { gym, target } = preview;
    const base={action:'cancel' as const,gym,target,credit:preview.credit,writeConfirmationRequired:true};
    let observedState: 'booked' | 'waitlisted' | 'cancelled' | 'unbooked' | 'unknown' = 'unknown';
    let conflicting = false;
    let reconciliationIssue = false;
    let sameActionableReservation = false;
    let releasedSameSession = false;
    try {
      const after = cancellationCandidates(await session.read({ kind: 'schedule', boxId, date: target.date }), gym.id, target.date, gym.timeZone!, target);
      const sameSourceSession = after.length === 1 && after[0]!.sourceId === sourceId;
      const sameReservation = sameSourceSession && after[0]!.reservationId === reservationId;
      releasedSameSession = sameSourceSession && after[0]!.reservationId === null && after[0]!.currentState === 'unbooked';
      if (sameReservation || releasedSameSession) observedState = after[0]!.currentState;
      else conflicting = true;
      sameActionableReservation = sameReservation && after[0]!.eligibility === 'offered';
      const upcoming = parseUpcomingBookings(await session.read({ kind: 'upcoming', boxId }), gym.timeZone!);
      const matches = upcoming.filter(item => item.date === target.date && item.startTime === target.startTime
        && item.timeLabel.endsWith(target.endTime) && (item.classType.name === target.className || item.classType.name === null));
      conflicting = conflicting || matches.length > 1 || matches.some(item => item.state !== observedState);
    } catch { reconciliationIssue = true; }
    const result = dispatch.cancelState;
    const status = conflicting || reconciliationIssue || writeIssue ? 'uncertain' as const
      : result === 1 && (observedState === 'cancelled' || releasedSameSession) ? 'confirmed' as const
        : !late && result === 2 && observedState === 'booked' && sameActionableReservation ? 'pending-credit-loss' as const
          : result === 3 && observedState === 'booked' ? 'rejected' as const : 'uncertain' as const;
    const lateReference = status === 'pending-credit-loss'
      ? ctx.bookingPreparations.issueLateCancellation(session.accountId, boxId, reservationId, preview) : {};
    return { ...base, status, observedState, notices: [
      `One ${late ? 'late' : 'standard'} cancellation request was attempted. Fresh booking reads, not the HTTP response alone, determine the reported state.`,
      status === 'confirmed' ? 'Fresh schedule and upcoming reads support no active booking for the target. No credit balance or refund was verified.'
        : status === 'pending-credit-loss' ? 'AimHarder indicated possible late credit loss. The reservation remains booked. No second cancellation request was sent. Show the exact class, current state, and possible loss. Obtain separate explicit confirmation before a late attempt when writeConfirmationRequired is true. No late request is automatic.'
          : status === 'rejected' ? 'AimHarder indicated a denial and the reservation remains booked.'
            : 'The cancellation outcome is uncertain. Inspect the reservation directly before preparing another action; no automatic retry was sent.',
    ], ...lateReference };
}


export function getUpcomingBookings(ctx: Context, gymId?: string) {
  return ctx.upstream.withGym(gymId, async (session) => {
    const { gym, boxId } = session;
    if (!gym.timeZone) throw new AimHarderError('GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_BOOKING_RESPONSE');
    const bookings = parseUpcomingBookings(await session.read({ kind: 'upcoming', boxId }), gym.timeZone);
    const bookingStatus = bookings.some((row) => row.state === 'booked') ? 'booked' as const
      : bookings.some((row) => row.state === 'unknown') ? 'unknown' as const : 'none' as const;
    return {
      gym, bookings, bookingStatus,
      coverage: { status: 'complete' as const, scope: 'upstream-upcoming-view' as const, startDate: null, endDate: null },
      notices: [
        'Coverage is the current AimHarder upcoming view, not a verified calendar interval or unlimited future horizon. Do not infer no booking for an arbitrary date from absence here.',
        'Bookings are reservations, not attendance. Waitlisted entries are not confirmed reservations; unknown states must not be treated as no booking.',
        'Times are gym-local wall times in the reported zone, which may be assumed, without an inferred UTC instant. Only the verified Spanish date format is supported.',
        'The upcoming source ID is not a verified class-session ID. Match date, time and class type cautiously and retain ambiguous alternatives.',
      ],
    };
  });
}


export function getBookingHistory(ctx: Context, gymId?: string) {
  return ctx.upstream.withGym(gymId, async (session) => {
    const { gym, boxId } = session;
    if (!gym.timeZone) throw new AimHarderError('GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_BOOKING_RESPONSE');
    const { bookings, partial } = parseBookingHistory(await session.read({ kind: 'upcoming', boxId }), gym.timeZone);
    return {
      gym, bookings,
      coverage: { status: 'limited' as const, retrieval: partial ? 'partial' as const : 'complete' as const, scope: 'upstream-history-view' as const, startDate: null, endDate: null },
      notices: [
        'Only the returned history view is available. The observed view contained 30 records; neither an exhaustive date interval nor a pagination contract is verified. Empty does not establish empty lifetime history.',
        'States follow the official history renderer, including late-cancellation precedence. Attendance remains unverified even when assist is 1; simultaneous assist and lateCancel flags do not establish attendance.',
        'Dates and times are gym-local in the reported zone, which may be assumed. Results are sorted newest first; source IDs are not verified class-session IDs.',
        ...(partial ? ['Some malformed or conflicting records were omitted; recovered records are partial and cannot establish absence.'] : []),
      ],
    };
  });
}

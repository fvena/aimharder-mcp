import { gymIdSchema } from '../config.js';
import { dateSchema } from '../domain/classes.js';
import { upcomingBookingSchema, historicalBookingSchema } from '../domain/bookings.js';
import { defineTool, destructiveWrite, gymQuerySchema, gymSchema, planEntryOutput, preview, readOnly, write } from './tool.js';
import { z } from 'zod';
import { AimHarderError } from '../errors.js';
import { type ConfirmedSession, type Gym } from '../upstream.js';
import { parseUpcomingBookings, parseBookingHistory } from '../domain/bookings.js';
import { insideCancellationWindow, bookingWindow, bookingCreationQuerySchema, bookingCancellationQuerySchema, bookingExecutionSchema, lateCancellationExecutionSchema, plannedBookingQuerySchema, type PlannedBookingQuery, type BookingCreationQuery, type BookingCreationPreview, type BookingCancellationQuery, type BookingCancellationPreview, type BookingState, type CancellationState } from '../domain/booking-preparation.js';
import { type Context } from './context.js';
import { scheduleRows, upcomingContradicts, upcomingEntries } from './class-booking-state.js';
import { type WriteAction } from './writes.js';
import { calendarDates } from '../domain/classes.js';
import { weekdays } from '../config.js';

function bookingResponseDenied(response: unknown): boolean {
  const denial = z.object({ bookState: z.number().int().negative().optional(), errorMssg: z.unknown().optional(), errorMssgLang: z.unknown().optional() }).safeParse(response);
  return denial.success && (denial.data.bookState !== undefined || denial.data.errorMssg !== undefined || denial.data.errorMssgLang !== undefined);
}

type ClassTime = { className: string; date: string; startTime: string; endTime: string };
interface CreationPlan { preview: BookingCreationPreview; sourceId: number }
interface CancellationPlan {
  preview: BookingCancellationPreview; sourceId: number; reservationId: number;
  /** The gym's cancellation window at preview time, and whether the preview already warned about it. */
  lateWindowMinutes: number | undefined; warned: boolean;
}

export function prepareBookingCreation(ctx: Context, input: BookingCreationQuery) {
  const parsed = bookingCreationQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_BOOKING_PREPARATION_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, 'confirmed-zone', (session) => prepareOneBooking(ctx, session, query))
    .then(result => ({ ...result, target: { ...result.target, endTime: result.target.endTime ?? query.endTime }, writeConfirmationRequired: ctx.preferences.bookingConfirmationRequired }));
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
  return ctx.upstream.withGym(query.gymId, 'confirmed-zone', async (session) => {
    const { gym } = session;
    const plan = ctx.preferences.atGym(gym.id).bookingPlan;
    const days = [];
    for (const date of calendarDates(query.startDate, query.endDate)) {
      const weekday = weekdays[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!;
      const entries = plan.filter((entry) => entry.day === weekday);
      if (!entries.length) { days.push({ date, weekday, status: 'not-planned' as const }); continue; }
      for (const { className, startTime } of entries) {
        const { gym: _gym, action: _action, ...result } = await prepareOneBooking(ctx, session, { date, className, startTime });
        days.push({ date, weekday, ...result });
      }
    }
    const planned = plan.length > 0;
    return { action: 'create' as const, gym, startDate: query.startDate, endDate: query.endDate, plan, days,
      writeConfirmationRequired: ctx.preferences.bookingConfirmationRequired,
      notices: [
        planned ? 'Each ready day has its own single-use reference that expires in two minutes. Show the whole list, then execute each ready day separately with execute_booking_creation; every execution sends at most one booking request.'
          : 'No booking plan is configured for this gym (AIMHARDER_BOOKING_PLAN). Ask the account holder which classes to book, or book exact classes with prepare_booking_creation.',
        'Ask the account holder about days that are not-planned, missing, ambiguous or unsupported instead of choosing another class. For not-yet-open days, report bookingOpensAt and do not retry before then.',
        'This is a read-only schedule snapshot. Preparation does not reserve a place or prove final eligibility.',
      ] };
  });
}


/** Preview one booking in the gym's daily schedule; a missing end time matches any end time (as in a booking plan). */
async function prepareOneBooking(ctx: Context, session: ConfirmedSession, query: { date: string; className: string; startTime: string; endTime?: string }) {
  const { gym } = session;
  const rows = await scheduleRows(session, query);
  const alternatives = rows.map(({ className, date, startTime, endTime, booking }) => ({ className, date, startTime, endTime, currentState: booking.state, eligibility: booking.eligibility }));
  const base = { action: 'create' as const, gym, target: {
    className: query.className, date: query.date, startTime: query.startTime,
    endTime: query.endTime ?? (rows.length === 1 ? rows[0]!.endTime : null),
  }, alternatives };
  if (rows.length !== 1) return { ...base, status: rows.length ? 'ambiguous' as const : 'missing' as const,
    notices: [rows.length ? 'Several exact class sessions match. Choose a different date or time; no booking can be prepared.' : 'No exact class session was found in the retrieved daily schedule.'] };
  const row = rows[0]!;
  const target = { ...base.target, endTime: row.endTime };
  const windowDays = ctx.preferences.atGym(gym.id).bookingWindowDays;
  const window = windowDays === undefined ? undefined : bookingWindow(query.date, query.startTime, gym.timeZone, windowDays);
  if (window && !window.bookingOpen && row.booking.state === 'unbooked') return { ...base, target, status: 'not-yet-open' as const, currentState: row.booking.state, bookingOpensAt: window.bookingOpensAt,
    notices: [`Booking for this class opens at ${window.bookingOpensAt.replace('T', ' ')} gym-local time under the configured ${windowDays}-day booking window. No reference was issued and no request was sent. Do not retry before then.`] };
  const status = row.booking.state === 'booked' ? 'already-booked' as const
    : row.booking.state === 'waitlisted' ? 'waitlisted' as const
      : row.booking.eligibility === 'offered' ? 'ready' as const : 'unsupported' as const;
  const notices = [
    'This is a read-only schedule snapshot. Preparation does not reserve a place or prove final eligibility.',
  ];
  if (status !== 'ready') return { ...base, target, status, currentState: row.booking.state, notices };
  const preview: BookingCreationPreview = { action: 'create', gym, target, currentState: 'unbooked', notices };
  return { status, ...preview, alternatives, ...ctx.writes.issue(bookingCreation, session, { preview, sourceId: row.sourceId }) };
}


/** Booking one exact class: confirmation follows the account holder's booking preference. */
const bookingCreation: WriteAction<CreationPlan, CreationResult> = {
  kind: 'booking-creation', input: bookingExecutionSchema, invalidInput: 'INVALID_BOOKING_EXECUTION_QUERY', invalidReference: 'BOOKING_REFERENCE_INVALID',
  confirmation: { marker: 'confirmed', required: (preferences) => preferences.bookingConfirmationRequired },
  stale: (session, { plan }) => staleCreation(session.gym, plan.preview.target, 'unknown', 'Account, gym, or confirmed time zone changed. No booking request was sent.'),
  async recheck(session, { plan }) {
    const target = plan.preview.target;
    const before = await scheduleRows(session, target);
    if (before.length !== 1 || before[0]!.sourceId !== plan.sourceId || before[0]!.booking.eligibility !== 'offered') {
      return { result: staleCreation(session.gym, target, before.length === 1 ? before[0]!.booking.state : 'unknown', 'The exact class or its offered state changed. No booking request was sent.') };
    }
    if ((await upcomingEntries(session, target)).length) {
      return { result: staleCreation(session.gym, target, 'unknown', 'A current upcoming entry may already cover this class. No booking request was sent.') };
    }
    return { send: { kind: 'book', sessionId: plan.sourceId, date: target.date } };
  },
  async reconcile(session, { plan }, sent) {
    const { gym, target } = plan.preview;
    const writeIssue = sent.failed || !z.record(z.string(), z.unknown()).safeParse(sent.response).success;
    let scheduleState: BookingState = 'unknown';
    let conflicting = false;
    let reconciliationIssue = false;
    try {
      const after = await scheduleRows(session, target);
      if (after.length === 1 && after[0]!.sourceId === plan.sourceId) scheduleState = after[0]!.booking.state;
      conflicting = await upcomingContradicts(session, target, scheduleState);
    } catch { reconciliationIssue = true; }
    const denied = !sent.failed && bookingResponseDenied(sent.response);
    const status = conflicting || reconciliationIssue || (denied && scheduleState !== 'unbooked') ? 'uncertain' as const : scheduleState === 'booked' ? 'confirmed' as const
      : scheduleState === 'waitlisted' ? 'waitlisted' as const
        : scheduleState === 'unbooked' && denied ? 'rejected' as const : 'uncertain' as const;
    return { action: 'create' as const, gym, target, status, observedState: scheduleState, notices: [
      'One standard booking request was attempted. Fresh booking reads, not the HTTP response alone, determine the reported state.',
      status === 'confirmed' ? 'A fresh schedule read reported a confirmed booking.'
        : status === 'waitlisted' ? 'A fresh schedule read reported a waitlist state; no further write was sent.'
          : status === 'rejected' ? 'The source returned a denial indication and the fresh schedule remains unbooked. Denial semantics remain unverified live.'
            : 'The outcome is uncertain. Check the booking directly before preparing a new action; no automatic write retry was sent.',
      ...(writeIssue ? ['The write response was incomplete; use fresh booking reads to assess the outcome.'] : []),
      ...(reconciliationIssue ? ['A follow-up view could not be read completely; booking state remains uncertain.'] : []),
    ] };
  },
};

type CreationResult = { action: 'create'; gym: Gym; target: ClassTime; status: 'confirmed' | 'rejected' | 'waitlisted' | 'uncertain' | 'stale'; observedState: BookingState; notices: string[] };
function staleCreation(gym: Gym, target: ClassTime, observedState: BookingState, notice: string): CreationResult {
  return { action: 'create', gym, target, status: 'stale', observedState, notices: [notice] };
}


export function prepareBookingCancellation(ctx: Context, input: BookingCancellationQuery) {
  const parsed = bookingCancellationQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_CANCELLATION_PREPARATION_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, 'confirmed-zone', async (session) => {
    const { gym } = session;
    // This account-scoped daily schedule supplies idres; upcoming IDs are not a verified join.
    const rows = await scheduleRows(session, query);
    const alternatives = rows.map(({ className, date, startTime, endTime, cancellation }) => ({ className, date, startTime, endTime, currentState: cancellation.state, eligibility: cancellation.eligibility }));
    const base = { action: 'cancel' as const, gym, target: {
      className: query.className, date: query.date, startTime: query.startTime, endTime: query.endTime,
    }, alternatives };
    if (rows.length !== 1) return { ...base, status: rows.length ? 'ambiguous' as const : 'missing' as const,
      notices: [rows.length ? 'Several exact schedule rows match. No cancellation can be prepared.' : 'No exact class session was found in the retrieved daily schedule.'] };
    const row = rows[0]!;
    const status = row.cancellation.state === 'cancelled' ? 'already-cancelled' as const
      : row.cancellation.eligibility === 'offered' ? 'ready' as const : 'unsupported' as const;
    const lateWindow = ctx.preferences.atGym(gym.id).cancellationWindowMinutes;
    const warned = lateWindow !== undefined && insideCancellationWindow(query.date, query.startTime, gym.timeZone, lateWindow);
    const notices = [
      'This is a read-only, account-scoped daily schedule snapshot. No cancellation request was sent.',
      'The credit balance, entitlement period, and effect of this cancellation are not verified.',
      ...(warned
        ? [`The class starts within the configured ${lateWindow}-minute cancellation window. Cancelling now may lose one credit. This is a configured gym rule, not a verified balance or API decision.`] : []),
    ];
    if (status !== 'ready' || row.reservationId === null) return { ...base, status, currentState: row.cancellation.state, notices };
    const preview: BookingCancellationPreview = {
      action: 'cancel', gym, target: base.target, currentState: 'booked',
      credit: { possibleLoss: lateWindow !== undefined
        ? `Under the configured rule, cancelling fewer than ${lateWindow} minutes before class loses a credit; the actual credit effect is not verified for this request.`
        : 'Cancellation may affect a credit; the actual effect is not verified for this request.',
      balance: null, entitlementPeriod: null }, notices,
    };
    return { status, ...preview, alternatives,
      ...ctx.writes.issue(standardCancellation, session, { preview, sourceId: row.sourceId, reservationId: row.reservationId,
        lateWindowMinutes: lateWindow, warned }) };
  }).then(result => ({ ...result, writeConfirmationRequired: true }));
}


type CancellationStatus = 'confirmed' | 'rejected' | 'pending-credit-loss' | 'uncertain' | 'stale';
type CancellationResult = { action: 'cancel'; gym: Gym; target: ClassTime; credit: BookingCancellationPreview['credit']; status: CancellationStatus;
  observedState: CancellationState; notices: string[]; writeConfirmationRequired?: true; actionReference?: string; expiresAt?: string };

/** Cancelling one own reservation; `late` is the second, credit-loss-confirmed attempt after a pending-credit-loss warning. */
function cancellation(late: boolean): WriteAction<CancellationPlan, CancellationResult> {
  const result = (gym: Gym, plan: CancellationPlan, status: CancellationStatus, observedState: CancellationState, notices: string[]): CancellationResult =>
    ({ action: 'cancel', gym, target: plan.preview.target, credit: plan.preview.credit, status, observedState, notices });
  return {
    kind: late ? 'late-cancellation' : 'cancellation',
    input: late ? lateCancellationExecutionSchema : bookingExecutionSchema,
    invalidInput: late ? 'INVALID_LATE_CANCELLATION_QUERY' : 'INVALID_BOOKING_EXECUTION_QUERY',
    invalidReference: 'BOOKING_REFERENCE_INVALID',
    confirmation: { marker: late ? 'confirmedCreditLoss' : 'confirmed', required: () => true },
    stale: (session, { plan }) => result(session.gym, plan, 'stale', 'unknown', ['Account, gym, or confirmed time zone changed. No cancellation request was sent.']),
    async recheck(session, { plan }) {
      const target = plan.preview.target;
      const before = await scheduleRows(session, target);
      if (before.length !== 1 || before[0]!.reservationId !== plan.reservationId || before[0]!.cancellation.eligibility !== 'offered') {
        return { result: result(session.gym, plan, 'stale', before.length === 1 ? before[0]!.cancellation.state : 'unknown',
          ['The exact reservation or its cancellation eligibility changed. No cancellation request was sent.']) };
      }
      const window = plan.lateWindowMinutes;
      if (!late && window !== undefined && !plan.warned && insideCancellationWindow(target.date, target.startTime, session.gym.timeZone, window)) {
        return { result: result(session.gym, plan, 'stale', 'booked',
          ['The configured cancellation window was reached after preparation. Prepare a new preview and confirm the possible credit loss before a cancellation request.']) };
      }
      return { send: { kind: 'cancel', reservationId: plan.reservationId, late } };
    },
    async reconcile(session, { plan }, sent, issue) {
      const { gym, target } = plan.preview;
      const parsedResponse = z.object({ cancelState: z.number().int() }).safeParse(sent.failed ? undefined : sent.response);
      const cancelState = parsedResponse.success ? parsedResponse.data.cancelState : null;
      let observedState: CancellationState = 'unknown';
      let conflicting = false;
      let reconciliationIssue = false;
      let sameActionableReservation = false;
      let releasedSameSession = false;
      try {
        const after = await scheduleRows(session, target);
        const sameSourceSession = after.length === 1 && after[0]!.sourceId === plan.sourceId;
        const sameReservation = sameSourceSession && after[0]!.reservationId === plan.reservationId;
        releasedSameSession = sameSourceSession && after[0]!.reservationId === null && after[0]!.cancellation.state === 'unbooked';
        if (sameReservation || releasedSameSession) observedState = after[0]!.cancellation.state;
        else conflicting = true;
        sameActionableReservation = sameReservation && after[0]!.cancellation.eligibility === 'offered';
        conflicting = (await upcomingContradicts(session, target, observedState)) || conflicting;
      } catch { reconciliationIssue = true; }
      const status = conflicting || reconciliationIssue || sent.failed ? 'uncertain' as const
        : cancelState === 1 && (observedState === 'cancelled' || releasedSameSession) ? 'confirmed' as const
          : !late && cancelState === 2 && observedState === 'booked' && sameActionableReservation ? 'pending-credit-loss' as const
            : cancelState === 3 && observedState === 'booked' ? 'rejected' as const : 'uncertain' as const;
      const lateReference = status === 'pending-credit-loss' ? issue(lateCancellation, plan) : {};
      return { ...result(gym, plan, status, observedState, [
        `One ${late ? 'late' : 'standard'} cancellation request was attempted. Fresh booking reads, not the HTTP response alone, determine the reported state.`,
        status === 'confirmed' ? 'Fresh schedule and upcoming reads support no active booking for the target. No credit balance or refund was verified.'
          : status === 'pending-credit-loss' ? 'AimHarder indicated possible late credit loss. The reservation remains booked. No second cancellation request was sent. Show the exact class, current state, and possible loss. Obtain separate explicit confirmation before a late attempt when writeConfirmationRequired is true. No late request is automatic.'
            : status === 'rejected' ? 'AimHarder indicated a denial and the reservation remains booked.'
              : 'The cancellation outcome is uncertain. Inspect the reservation directly before preparing another action; no automatic retry was sent.',
      ]), writeConfirmationRequired: true, ...lateReference };
    },
  };
}
const standardCancellation = cancellation(false);
const lateCancellation = cancellation(true);


export function getUpcomingBookings(ctx: Context, gymId?: string) {
  return ctx.upstream.withGym(gymId, 'box', async (session) => {
    const { gym, boxId } = session;
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
  return ctx.upstream.withGym(gymId, 'box', async (session) => {
    const { gym, boxId } = session;
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


// Tools

export const prepareBookingCreationTool = defineTool({
  name: 'prepare_booking_creation',
  description: 'Read the current daily schedule and prepare one exact class booking. Requires a user-confirmed gym IANA zone and exact class name, date, start and end time. Ambiguous, missing, already booked, waitlisted or unsupported targets receive no reference. When a booking window is configured for the gym, a class whose window has not opened returns not-yet-open with bookingOpensAt (gym-local) and no reference; tell the account holder when it opens instead of retrying. Preparation sends no write. Read writeConfirmationRequired from preparation. Account context exposes the bookingCreation setting in writeConfirmationPolicy; cancellation always requires confirmation. When true, show the exact preview and obtain separate account-holder confirmation before execution with confirmed: true. When false, an explicit request for this exact action is sufficient; omit confirmed and do not ask for another confirmation. A query or preview-only request never authorizes execution.',
  inputSchema: bookingCreationQuerySchema,
  outputSchema: z.object({ writeConfirmationRequired: z.boolean(), action: z.literal('create'), status: z.enum(['ready', 'ambiguous', 'missing', 'already-booked', 'waitlisted', 'unsupported', 'not-yet-open']), bookingOpensAt: z.string().optional(),
    gym: gymSchema, target: z.object({ className: z.string(), date: dateSchema, startTime: z.string(), endTime: z.string() }),
    alternatives: z.array(z.object({ className: z.string(), date: dateSchema, startTime: z.string(), endTime: z.string(), currentState: z.enum(['unbooked', 'booked', 'waitlisted', 'unknown']), eligibility: z.enum(['offered', 'unsupported']) })),
    currentState: z.enum(['unbooked', 'booked', 'waitlisted', 'unknown']).optional(),
    actionReference: z.string().optional(), expiresAt: z.string().optional(), notices: z.array(z.string()),
  }),
  annotations: preview,
  run: (ctx, query) => prepareBookingCreation(ctx, query),
});

export const executeBookingCreationTool = defineTool({
  name: 'execute_booking_creation',
  description: 'Create exactly one booking from a fresh prepare_booking_creation reference. Recheck the target and eligibility, send at most one standard write, then reconcile with fresh reads. An uncertain result requires manual inspection before a new action. Read writeConfirmationRequired from preparation. Account context exposes the bookingCreation setting in writeConfirmationPolicy; cancellation always requires confirmation. When true, show the exact preview and obtain separate account-holder confirmation before execution with confirmed: true. When false, an explicit request for this exact action is sufficient; omit confirmed and do not ask for another confirmation. A query or preview-only request never authorizes execution.',
  inputSchema: bookingExecutionSchema,
  outputSchema: z.object({ action: z.literal('create'), status: z.enum(['confirmed', 'rejected', 'waitlisted', 'uncertain', 'stale']),
    gym: gymSchema, target: z.object({ className: z.string(), date: dateSchema, startTime: z.string(), endTime: z.string() }),
    observedState: z.enum(['unbooked', 'booked', 'waitlisted', 'unknown']),
    notices: z.array(z.string()),
  }),
  annotations: write,
  run: (ctx, query) => ctx.writes.execute(bookingCreation, query),
});

const plannedTarget = z.object({ className: z.string(), date: dateSchema, startTime: z.string(), endTime: z.string().nullable() });
export const preparePlannedBookingsTool = defineTool({
  name: 'prepare_planned_bookings',
  description: 'Preview booking the account holder\'s planned classes (AIMHARDER_BOOKING_PLAN: weekday, class name and start time entries; a weekday may have several) for every gym-local date in a range of up to 14 days, such as "book next week". Use it when the account holder asks to book without naming exact classes. Each planned class on each date is one entry, and each date without one reports not-planned; entries report ready (with its own single-use actionReference), already-booked, waitlisted, not-yet-open (with bookingOpensAt), missing, ambiguous or unsupported. Sends no write. Show the whole list, then execute each ready day separately with execute_booking_creation under the same writeConfirmationRequired rules as prepare_booking_creation. Ask about the other days instead of choosing a different class.',
  inputSchema: plannedBookingQuerySchema,
  outputSchema: z.object({ action: z.literal('create'), gym: gymSchema, startDate: dateSchema, endDate: dateSchema, writeConfirmationRequired: z.boolean(),
    plan: z.array(planEntryOutput),
    days: z.array(z.object({ date: dateSchema, weekday: z.enum(weekdays),
      status: z.enum(['not-planned', 'ready', 'ambiguous', 'missing', 'already-booked', 'waitlisted', 'unsupported', 'not-yet-open']),
      target: plannedTarget.optional(), currentState: z.enum(['unbooked', 'booked', 'waitlisted', 'unknown']).optional(), bookingOpensAt: z.string().optional(),
      actionReference: z.string().optional(), expiresAt: z.string().optional(), notices: z.array(z.string()).optional() })),
    notices: z.array(z.string()) }),
  annotations: preview,
  run: (ctx, query) => preparePlannedBookings(ctx, query),
});

export const prepareBookingCancellationTool = defineTool({
  name: 'prepare_booking_cancellation',
  description: 'Read the fresh daily schedule and prepare cancellation of one exact own booked class in a user-confirmed gym IANA zone. No reservation ID or family selector is accepted. Unsupported or ambiguous targets receive no reference. Show possible credit loss, including any configured cancellation window (AIMHARDER_CANCELLATION_WINDOW_MINUTES). Preparation sends no POST. Always show the exact full preview and obtain separate account-holder confirmation before execution with confirmed: true. Booking and publication preference switches do not affect this action.',
  inputSchema: bookingCancellationQuerySchema,
  outputSchema: z.object({ writeConfirmationRequired: z.boolean(), action: z.literal('cancel'), status: z.enum(['ready', 'ambiguous', 'missing', 'already-cancelled', 'unsupported']),
    gym: gymSchema, target: z.object({ className: z.string(), date: dateSchema, startTime: z.string(), endTime: z.string() }),
    alternatives: z.array(z.object({ className: z.string(), date: dateSchema, startTime: z.string(), endTime: z.string(),
      currentState: z.enum(['booked', 'waitlisted', 'cancelled', 'unbooked', 'unknown']), eligibility: z.enum(['offered', 'unsupported']) })),
    currentState: z.enum(['booked', 'waitlisted', 'cancelled', 'unbooked', 'unknown']).optional(),
    credit: z.object({ possibleLoss: z.string(), balance: z.null(), entitlementPeriod: z.null() }).optional(),
    actionReference: z.string().optional(), expiresAt: z.string().optional(), notices: z.array(z.string()),
  }),
  annotations: preview,
  run: (ctx, query) => prepareBookingCancellation(ctx, query),
});

export const executeBookingCancellationTool = defineTool({
  name: 'execute_booking_cancellation',
  description: 'Cancel one exact prepared booking. Recheck the reservation, send at most one standard request, then reconcile with fresh reads. A late-credit-loss warning remains pending with a new reference; do not retry automatically. Always show the exact full preview and obtain separate account-holder confirmation before execution with confirmed: true. Booking and publication preference switches do not affect this action.',
  inputSchema: bookingExecutionSchema,
  outputSchema: z.object({ writeConfirmationRequired: z.boolean().optional(), action: z.literal('cancel'), status: z.enum(['confirmed', 'rejected', 'pending-credit-loss', 'uncertain', 'stale']),
    gym: gymSchema, target: z.object({ className: z.string(), date: dateSchema, startTime: z.string(), endTime: z.string() }),
    observedState: z.enum(['booked', 'waitlisted', 'cancelled', 'unbooked', 'unknown']),
    credit: z.object({ possibleLoss: z.string(), balance: z.null(), entitlementPeriod: z.null() }), notices: z.array(z.string()),
    actionReference: z.string().optional(), expiresAt: z.string().optional(),
  }),
  annotations: destructiveWrite,
  run: (ctx, query) => ctx.writes.execute(standardCancellation, query),
});

export const executeLateBookingCancellationTool = defineTool({
  name: 'execute_late_booking_cancellation',
  description: 'After a fresh standard cancellation reports pending-credit-loss, show the exact still-booked target and possible credit loss, then obtain separate account-holder confirmation with confirmedCreditLoss: true. Both preference switches leave this requirement in force. Use only the new late reference, recheck the same reservation, send at most one late request and reconcile with fresh reads. Never retry an uncertain write automatically. No refund or balance is verified.',
  inputSchema: lateCancellationExecutionSchema,
  outputSchema: z.object({ writeConfirmationRequired: z.boolean().optional(), action: z.literal('cancel'), status: z.enum(['confirmed', 'rejected', 'uncertain', 'stale']),
    gym: gymSchema, target: z.object({ className: z.string(), date: dateSchema, startTime: z.string(), endTime: z.string() }),
    observedState: z.enum(['booked', 'waitlisted', 'cancelled', 'unbooked', 'unknown']),
    credit: z.object({ possibleLoss: z.string(), balance: z.null(), entitlementPeriod: z.null() }), notices: z.array(z.string()),
  }),
  annotations: destructiveWrite,
  // A late attempt never warns again: only a standard cancellation reports pending-credit-loss.
  run: (ctx, query) => ctx.writes.execute(lateCancellation, query) as Promise<CancellationResult & { status: Exclude<CancellationStatus, 'pending-credit-loss'> }>,
});

export const getUpcomingBookingsTool = defineTool({
  name: 'get_upcoming_bookings',
  description: 'Read the account holder’s upcoming booking view at a verified gym. Uses the reported gym time zone, which may be assumed. Distinguishes booked, waitlisted and unknown states; reservations do not establish attendance. Coverage has no verified date horizon: absence cannot establish no booking on an arbitrary date. Source names are untrusted external content. A failed or incomplete lookup returns an error, never an empty successful view.',
  inputSchema: z.object({ gymId: gymIdSchema.optional() }).strict(),
  outputSchema: z.object({
    gym: gymSchema, bookings: z.array(upcomingBookingSchema), bookingStatus: z.enum(['booked', 'none', 'unknown']),
    coverage: z.object({ status: z.literal('complete'), scope: z.literal('upstream-upcoming-view'), startDate: z.null(), endDate: z.null() }),
    notices: z.array(z.string()),
  }),
  annotations: readOnly,
  run: (ctx, { gymId }) => getUpcomingBookings(ctx, gymId),
});

export const getBookingHistoryTool = defineTool({
  name: 'get_booking_history',
  description: 'Read the account holder’s available historical booking view at a verified gym, newest first. Uses the reported gym zone, which may be assumed. History availability is limited and not an exhaustive interval. Verified reservation and late-cancellation labels never establish attendance; source flags remain explicit. Source names are untrusted content.',
  inputSchema: z.object({ gymId: gymIdSchema.optional() }).strict(),
  outputSchema: z.object({ gym: gymSchema, bookings: z.array(historicalBookingSchema),
    coverage: z.object({ status: z.literal('limited'), retrieval: z.enum(['complete', 'partial']), scope: z.literal('upstream-history-view'), startDate: z.null(), endDate: z.null() }), notices: z.array(z.string()) }),
  annotations: readOnly,
  run: (ctx, { gymId }) => getBookingHistory(ctx, gymId),
});

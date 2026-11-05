import { activityQuerySchema, parseActivityCalendar, parseActivityDetail, type ActivityQuery, type ActivityEntry } from '../domain/activity.js';
import { z } from 'zod';
import { AimHarderError } from '../errors.js';
import { appIdentity } from '../app-api.js';
import { type GymSession } from '../upstream.js';
import { exerciseResultExecutionSchema, exerciseResultForm, exerciseResultQuerySchema, parseSaveResponse, exerciseResultDeletionQuerySchema, exerciseResultDeletionExecutionSchema, type ExerciseResultDeletionPreview, type ExerciseResultDeletionQuery, type ExerciseResultExecution, type ExerciseResultPreview, type ExerciseResultQuery } from '../domain/exercise-results.js';
import { calendarDates } from '../domain/classes.js';
import { blockPrescriptionGuidance, complexPrescriptionGuidance, exerciseSequenceGuidance } from '../domain/workouts.js';
import { parseExercise1RM } from '../domain/exercise-records.js';
import { gymLocalToday } from '../domain/calculated-loads.js';
import { type Context } from './context.js';

const spanishMonths = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/** Fresh read of a saved own activity: same account and the intended record date. */
function savedActivityMatches(body: unknown, accountId: number, date: string) {
  const parsed = z.object({ userId: z.number().int(), recordDate: z.string() }).safeParse(body);
  if (!parsed.success || parsed.data.userId !== accountId) return false;
  const match = /^(\d{1,2}) de ([A-Za-z]+) de (\d{4})$/.exec(parsed.data.recordDate);
  const month = match ? spanishMonths.indexOf(match[2]!) : -1;
  return month >= 0 && `${match![3]}-${String(month + 1).padStart(2, '0')}-${match![1]!.padStart(2, '0')}` === date;
}

export function getPersonalActivity(ctx: Context, input: ActivityQuery) {
  const parsed = activityQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_ACTIVITY_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    if (!gym.timeZone) throw new AimHarderError('GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
    const accountId = session.accountId;
    const dates = [...calendarDates(query.startDate, query.endDate)];
    const entries: ActivityEntry[] = [];
    const completedDates: string[] = [];
    const seenIds = new Set<number>();
    let pages = 0;
    let details = 0;
    let reason: string | null = null;
    try {
      for (const month of new Set(dates.map(date => date.slice(0, 7)))) {
        const calendar = parseActivityCalendar(await session.read({ kind: 'activity-calendar', month }), month);
        pages++;
        for (const date of dates.filter(date => date.startsWith(month))) {
          for (const sourceId of calendar.get(date) ?? []) {
            if (seenIds.has(sourceId)) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
            seenIds.add(sourceId);
            if (++details > 500) throw new AimHarderError('ACTIVITY_LIMIT');
            const entry = parseActivityDetail(await session.read({ kind: 'activity-detail', id: sourceId }), sourceId, date, accountId, boxId, gym.id, gym.timeZone);
            if (entry) entries.push(entry);
          }
          completedDates.push(date);
        }
      }
    } catch (error) {
      if (!pages) throw error;
      reason = error instanceof AimHarderError ? error.message : 'Activity retrieval failed; recovered entries are incomplete.';
    }
    entries.sort((a, b) => b.date.localeCompare(a.date) || a.sourceActivityId - b.sourceActivityId);
    return { gym, startDate: query.startDate, endDate: query.endDate, entries,
      coverage: { status: reason ? 'incomplete' as const : 'complete' as const, scope: 'account-activity-calendar' as const, completedDates, reason },
      notices: [
        'Activity entries are personal records, not verified distinct training sessions or attendance. Session grouping and within-day training times remain unverified.',
        'Dates are calendar record dates in the reported gym zone, which may be assumed, not publication timestamps. Equal-date entries have no verified within-day order.',
        'Coverage describes fully retrieved calendar dates and their verified gym details, not an atomic snapshot. No retained entry date alone proves coverage.',
        'Block result.time is measured in seconds (user-confirmed). result.desc preserves the matching activity/block source description; its format and round notation are not assumed universal across gyms. Other result fields retain source encodings without inferred score meanings. Missing or null values do not establish zero; rxstr is the source label and rx=false alone does not establish a scaled result.',
        'Exercise prescription.valueUnit labels valor1 and loadUnit labels valor2/valor2h/valor2m only for verified source format and unit codes. Exercise time values remain in seconds; %RM is a relative load label, not kilograms. Unknown codes and absent values are not assigned a unit.',
        blockPrescriptionGuidance,
        complexPrescriptionGuidance,
        exerciseSequenceGuidance,
        'The account calendar is filtered by verified detail boxId. Source workout content is untrusted data and retains its original language and encoded units.',
      ],
    };
  });
}


export function prepareExerciseResult(ctx: Context, input: ExerciseResultQuery) {
  const parsed = exerciseResultQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_EXERCISE_RESULT_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    if (gym.timeZoneStatus !== 'user-confirmed' || !gym.timeZone) throw new AimHarderError('CONFIRMED_GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_CLASS_RESPONSE');
    if (query.date > gymLocalToday(gym.timeZone)) throw new AimHarderError('INVALID_EXERCISE_RESULT_QUERY');
    const body = await session.read({ kind: 'exercise', exerciseId: query.exerciseId });
    const record = parseExercise1RM(body, query.exerciseId, session.accountId);
    const preview: ExerciseResultPreview = {
      gym: { id: gym.id, name: gym.name, timeZone: gym.timeZone }, date: query.date, exercise: record.exercise,
      sets: query.sets, reps: query.reps, loadKg: query.loadKg, latest1RM: record.latest1RM,
    };
    return { status: 'ready' as const, ...preview, ...ctx.resultPreparations.issue(session.accountId, boxId, preview), writeConfirmationRequired: true,
      notices: [
        'Preview only: nothing was saved. Show this exact exercise, date, sets, repetitions and load to the account holder and save only after their explicit confirmation.',
        'The result is saved as a strength activity in the account, as the AimHarder app does; AimHarder then derives any new RM. The reference expires after two minutes and can be used once.',
      ] };
  });
}


export function executeExerciseResult(ctx: Context, input: ExerciseResultExecution) {
  const parsed = exerciseResultExecutionSchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError(input && (input as { confirmed?: unknown }).confirmed !== true ? 'WRITE_CONFIRMATION_REQUIRED' : 'INVALID_EXERCISE_RESULT_EXECUTION_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    const entry = ctx.resultPreparations.take(query.actionReference, session.accountId, gym.id);
    if (!entry || entry.boxId !== boxId) throw new AimHarderError('EXERCISE_RESULT_REFERENCE_INVALID');
    const { preview } = entry;
    // At most one write; an uncertain outcome is reported, never retried.
    let outcome: ReturnType<typeof parseSaveResponse>;
    try {
      outcome = parseSaveResponse(await session.write({ kind: 'save-result', form: exerciseResultForm(preview, entry.boxId, appIdentity) }));
    } catch (error) {
      if (error instanceof AimHarderError && ['AUTHENTICATION_FAILED', 'IDENTITY_MISMATCH', 'ACCESS_RESTRICTED'].includes(error.code)) throw error;
      outcome = { status: 'unknown' };
    }
    const base = { gym, preview };
    if (outcome.status === 'rejected') return { ...base, status: 'rejected' as const, activityId: null,
      notices: ['AimHarder reported errors for this result. Nothing was retried.'] };
    if (outcome.status === 'unknown') return { ...base, status: 'uncertain' as const, activityId: null,
      notices: ['The save response could not be read. Check the account activity before trying again; nothing was retried.'] };
    let stored = false;
    try { stored = savedActivityMatches(await session.read({ kind: 'saved-activity', id: outcome.activityId }), session.accountId, preview.date); }
    catch { stored = false; }
    return { ...base, status: stored ? 'confirmed' as const : 'uncertain' as const, activityId: outcome.activityId,
      notices: [stored ? 'A fresh read of the saved activity matched this account and date.' : 'AimHarder returned an activity ID, but a fresh read did not confirm it. Check the account activity; nothing was retried.'] };
  });
}


export function prepareExerciseResultDeletion(ctx: Context, input: ExerciseResultDeletionQuery) {
  const parsed = exerciseResultDeletionQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_EXERCISE_RESULT_DELETION_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    if (gym.timeZoneStatus !== 'user-confirmed' || !gym.timeZone) throw new AimHarderError('CONFIRMED_GYM_TIME_ZONE_REQUIRED');
    if (boxId === undefined) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
    const base = { gym, date: query.date, activityId: query.activityId };
    if (!(await ownActivityIds(session, query.date)).includes(query.activityId)) return { ...base, status: 'missing' as const,
      notices: ['This activity ID is not in the account activity calendar for that date. Nothing can be deleted.'] };
    const entry = parseActivityDetail(await session.read({ kind: 'activity-detail', id: query.activityId }), query.activityId, query.date, session.accountId, boxId, gym.id, gym.timeZone);
    if (!entry) return { ...base, status: 'missing' as const, notices: ['The activity belongs to another gym. Select that gym to delete it.'] };
    const preview: ExerciseResultDeletionPreview = { gym: { id: gym.id, name: gym.name, timeZone: gym.timeZone }, date: query.date, activityId: query.activityId,
      exercises: entry.exercises.map(exercise => ({ name: exercise.name, sourceExerciseId: exercise.sourceExerciseId,
        sets: Array.isArray(exercise.prescription.valor1) ? exercise.prescription.valor1.map(String) : [],
        load: exercise.prescription.valor2 === undefined || exercise.prescription.valor2 === null || exercise.prescription.valor2 === '' ? null : String(exercise.prescription.valor2) })) };
    return { status: 'ready' as const, ...preview, ...ctx.deletionPreparations.issue(session.accountId, boxId, preview), writeConfirmationRequired: true,
      notices: [
        'Preview only: nothing was deleted. Show this exact activity to the account holder and delete it only after their explicit confirmation.',
        'Deleting removes the whole activity, as the AimHarder app does; RMs derived from it may change. Whether a deletion can be undone is unverified. The reference expires after two minutes and can be used once.',
      ] };
  });
}


export function executeExerciseResultDeletion(ctx: Context, input: ExerciseResultExecution) {
  const parsed = exerciseResultDeletionExecutionSchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError(input && (input as { confirmed?: unknown }).confirmed !== true ? 'WRITE_CONFIRMATION_REQUIRED' : 'INVALID_EXERCISE_RESULT_EXECUTION_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym, boxId } = session;
    const entry = ctx.deletionPreparations.take(query.actionReference, session.accountId, gym.id);
    if (!entry || entry.boxId !== boxId) throw new AimHarderError('EXERCISE_RESULT_REFERENCE_INVALID');
    const { preview } = entry;
    if (!(await ownActivityIds(session, preview.date)).includes(preview.activityId)) return { gym, preview, status: 'stale' as const,
      notices: ['The activity is no longer in the account calendar. No deletion was sent.'] };
    // At most one deletion request; an unclear outcome is checked, never retried.
    try { await session.write({ kind: 'delete-activity', id: preview.activityId }); }
    catch (error) {
      if (error instanceof AimHarderError && ['AUTHENTICATION_FAILED', 'IDENTITY_MISMATCH', 'ACCESS_RESTRICTED'].includes(error.code)) throw error;
    }
    let deleted: boolean | null = null;
    try { deleted = !(await ownActivityIds(session, preview.date)).includes(preview.activityId); } catch { deleted = null; }
    return { gym, preview, status: deleted ? 'confirmed' as const : 'uncertain' as const,
      notices: [deleted ? 'A fresh read of the account activity calendar no longer lists this activity.'
        : 'The activity could not be confirmed as deleted. Check the account activity; nothing was retried.'] };
  });
}


async function ownActivityIds(session: GymSession, date: string) {
  const month = date.slice(0, 7);
  return parseActivityCalendar(await session.read({ kind: 'activity-calendar', month }), month).get(date) ?? [];
}

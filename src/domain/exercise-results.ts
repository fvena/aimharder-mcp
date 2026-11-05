import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { dateSchema } from './classes.js';
import { gymIdSchema } from '../config.js';
import { exerciseIdSchema } from './exercise-records.js';

// Recording a strength result (sets × repetitions at a load), as the AimHarder app does it.
// See docs/aimharder-api.md for the observed request.
const loadSchema = z.number().positive().max(1000).refine(value => Number.isInteger(value * 4), 'Use steps of 0.25 kg.');
export const exerciseResultQuerySchema = z.object({
  exerciseId: exerciseIdSchema.describe('Source exercise ID, for example from find_exercise_1rm.'),
  date: dateSchema.describe('Gym-local date of the result, today or earlier.'),
  sets: z.number().int().min(1).max(20),
  reps: z.number().int().min(1).max(100).describe('Repetitions per set.'),
  loadKg: loadSchema.describe('Load actually lifted, in kilograms.'),
  gymId: gymIdSchema.optional(),
}).strict();
export type ExerciseResultQuery = z.infer<typeof exerciseResultQuerySchema>;
export const exerciseResultExecutionSchema = z.object({
  actionReference: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed: z.literal(true).describe('Set only after the account holder confirmed this exact preview.'),
  gymId: gymIdSchema.optional(),
}).strict();
export type ExerciseResultExecution = z.infer<typeof exerciseResultExecutionSchema>;

export type ExerciseResultPreview = {
  gym: { id: string; name: string; timeZone: string };
  date: string;
  exercise: { sourceExerciseId: number; name: string };
  sets: number; reps: number; loadKg: number;
  latest1RM: { value: string; unit: 'kg' | 'lbs' | null; sourceDate: string } | null;
};

/** Multipart fields sent by the app for one strength block with one exercise (formaReg 4, kilograms). */
export function exerciseResultForm(preview: ExerciseResultPreview, boxId: number, identity: { platform: string; version: string; versionApp: string }) {
  const exercise = {
    ejerId: preview.exercise.sourceExerciseId, ejerName: preview.exercise.name, ejerPic: null, formaReg: 4,
    valor1: Array.from({ length: preview.sets }, () => String(preview.reps)), valor2: String(preview.loadKg),
    tipoud: 0, tipoud2: null, wodId: null, tipoWOD: 0, round: null,
  };
  const block = { type: 6, reps: null, timecap: null, time: null, rondas: null, deleted: false, rx: false, rsel: 0, repsft: 0, sstipo: 1 };
  return {
    selectedDate: preview.date.replaceAll('-', ''), boxLocation: String(boxId), tiempoRegistro: '0',
    ejerRate: JSON.stringify([exercise]), TIPOWODs: JSON.stringify([block]), notasWOD: '',
    valueWithMentions: 'null', mentionsCollection: 'null',
    platform: identity.platform, version: identity.version, appVer: identity.versionApp, wodSchedule: '0',
  };
}

const saveResponseSchema = z.object({
  errors: z.array(z.unknown()), errorWODsID: z.array(z.unknown()).optional(), errorWODsType: z.array(z.unknown()).optional(),
  errorEjerID: z.array(z.unknown()).optional(), id: z.unknown().optional(),
});
const activityIdSchema = z.union([z.string().regex(/^[1-9]\d{0,15}$/), z.number().int().positive().safe()]);

/** The app response was observed base64-encoded; plain JSON is also accepted. */
export function parseSaveResponse(text: unknown): { status: 'saved'; activityId: number } | { status: 'rejected' } | { status: 'unknown' } {
  if (typeof text !== 'string') return { status: 'unknown' };
  const candidates = [text.trim()];
  try { candidates.push(Buffer.from(text.trim(), 'base64').toString('utf8')); } catch { /* not base64 */ }
  for (const candidate of candidates) {
    let body: unknown;
    try { body = JSON.parse(candidate); } catch { continue; }
    const parsed = saveResponseSchema.safeParse(body);
    if (!parsed.success) continue;
    const errors = [parsed.data.errors, parsed.data.errorWODsID ?? [], parsed.data.errorWODsType ?? [], parsed.data.errorEjerID ?? []].some(list => list.length);
    if (errors) return { status: 'rejected' };
    // Success needs a valid new activity ID; anything else is not proof of a saved result.
    const id = activityIdSchema.safeParse(parsed.data.id);
    return id.success ? { status: 'saved', activityId: Number(id.data) } : { status: 'unknown' };
  }
  return { status: 'unknown' };
}

/** Two-minute, single-use references for exercise result previews (saving or deleting). */
export class PreparationStore<P extends { gym: { id: string } }> {
  #entries = new Map<string, { accountId: number; boxId: number; preview: P; expires: number }>();

  issue(accountId: number, boxId: number, preview: P) {
    const now = Date.now();
    for (const [reference, entry] of this.#entries) if (entry.expires <= now) this.#entries.delete(reference);
    if (this.#entries.size >= 32) this.#entries.delete(this.#entries.keys().next().value!);
    const actionReference = randomBytes(32).toString('hex');
    const expires = now + 120_000;
    this.#entries.set(actionReference, { accountId, boxId, preview: structuredClone(preview), expires });
    return { actionReference, expiresAt: new Date(expires).toISOString() };
  }

  take(reference: string, accountId: number, gymId: string) {
    const entry = this.#entries.get(reference);
    this.#entries.delete(reference);
    if (!entry || entry.expires <= Date.now() || entry.accountId !== accountId || entry.preview.gym.id !== gymId) return null;
    return entry;
  }
}

export const exerciseResultDeletionQuerySchema = z.object({
  date: dateSchema.describe('Gym-local date of the activity.'),
  activityId: z.number().int().positive().safe().describe('Own activity ID, for example from get_personal_activity or execute_exercise_result.'),
  gymId: gymIdSchema.optional(),
}).strict();
export type ExerciseResultDeletionQuery = z.infer<typeof exerciseResultDeletionQuerySchema>;
export const exerciseResultDeletionExecutionSchema = exerciseResultExecutionSchema;

export type ExerciseResultDeletionPreview = {
  gym: { id: string; name: string; timeZone: string };
  date: string; activityId: number;
  exercises: { name: string; sourceExerciseId: number | null; sets: string[]; load: string | null }[];
};

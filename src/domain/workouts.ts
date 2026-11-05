import { z } from 'zod';
import { dateSchema } from './classes.js';
import { gymIdSchema } from '../config.js';
import { AimHarderError } from '../errors.js';
import { personalLoadSchema } from './calculated-loads.js';

export const workoutQuerySchema = z.object({ date: dateSchema, className: z.string().trim().min(1).max(300), gymId: gymIdSchema.optional() }).strict();
export type WorkoutQuery = z.infer<typeof workoutQuerySchema>;
export const maxWorkoutRangeDays = 14;
function rangeDays(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}
export const workoutRangeQuerySchema = z.object({
  from: dateSchema.describe('First gym-local date, inclusive (YYYY-MM-DD).'),
  to: dateSchema.describe(`Last gym-local date, inclusive (YYYY-MM-DD). At most ${maxWorkoutRangeDays} days after from, counting both ends.`),
  className: z.string().trim().min(1).max(300).describe('Exact feed wodClass, such as CROSS. Unknown names return no workouts and list the class names seen in the range.'),
  gymId: gymIdSchema.optional(),
}).strict().refine(query => query.from <= query.to && rangeDays(query.from, query.to) <= maxWorkoutRangeDays);
export type WorkoutRangeQuery = z.infer<typeof workoutRangeQuerySchema>;
export function datesInRange(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: rangeDays(from, to) }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}
const text = z.string().max(100_000);
const scalar = z.union([text, z.number().finite(), z.boolean(), z.null()]);
const prescriptionSchema = z.record(z.string(), z.union([scalar, z.array(scalar)]));
// The gym renderer uses these labels for a load's tipoud (formaReg 4) or tipoud2 (formaReg 6).
const loadUnits = ['kg', 'lbs', 'pood', '%BW', '%RM', 'RIR', 'RPE'] as const;
const distanceUnits = ['m', 'mi', 'yd', 'ft', 'steps', 'km'] as const;
export const blockPrescriptionGuidance = 'Block fields depend on type. For type=1 (For Time), derive the sequence from valor1; timecap alone does not establish a time limit. For type=10 (Rounds For Time), timecap supplies prescribed rounds; a separate time limit may appear in notes. For type=2 (AMRAP) or 13 (AMRAP Ladder), timecap is a duration: seconds when timecaptype=1, otherwise minutes in the observed renderer. For type=3 (EMOM) with time=0, timecap is minutes per interval, not the total round count. Exercise round groups and roundrepeat supply the interval structure; published EMOM block reps=0 selects consecutive groups and reps=1 selects cycling groups using rondas. This selector is distinct from recorded activity result.reps. For type=6 with sstipo=1 the observed heading is strength. Type=4 identifies Tabata but does not establish missing work/rest timing or round counts. Preserve source encodings and unknown meanings.';
export const complexPrescriptionGuidance = 'Within each block and difficulty, consecutive exercises with the same non-null complex marker, including 0, form a complex; unmarked rows end it. complexrep, when supplied, is the inner repeat count. For block types 6, 8 and 12, the renderer separately prefixes outer sets from the opening exercise valor1.length when greater than one and its first value is nonempty. Keep outer sets and complexrep distinct; absent complexrep remains unknown, and array length is not a universal round count. Preserve row order and source encodings.';
export const exerciseSequenceGuidance = 'valor1 entries are ordered values, not a total. For type=1 (For Time), read value positions across exercise rows in source order; the observed renderer suppresses empty/zero positions and may display matching arrays as a shared repetition ladder. For type=13, negative roundrepeat marks a Buy In; subsequent round groups distinguish the initial ladder from its per-round increment. A numeric or string valor1 value of 9999 is the renderer maximum-effort sentinel for the exercise format, not 9999 seconds, repetitions or distance units. Empty values do not establish zero work or a timed rest. Preserve notes alongside configured units and report conflicts instead of correcting units from an exercise name.';
const blockSchema = z.object({ notes: text.nullable(), prescription: prescriptionSchema.describe(blockPrescriptionGuidance) });
const exerciseSchema = z.object({ name: text, sourceExerciseId: z.number().int().positive().safe().nullable().describe('Validated upstream ejerId; null means no supported source identity was supplied.'), blockIndex: z.number().int().nonnegative().nullable(), prescription: prescriptionSchema.describe('Raw exercise values: valueUnit labels valor1; loadUnit labels valor2/valor2h/valor2m when verified. s means exercise seconds and %RM is relative, not kilograms. ' + complexPrescriptionGuidance + ' ' + exerciseSequenceGuidance), personalLoad: personalLoadSchema.optional() });
export const workoutSchema = z.object({
  date: dateSchema, className: z.string(), timeZone: z.string(), sessionId: z.null(),
  titles: z.array(text).describe('Nonempty feed titles, independently filtered from detail blocks. This array is not indexed by blockIndex; do not pair titles and blocks by position.'), blocks: z.array(blockSchema), exercises: z.array(exerciseSchema),
  variants: z.array(z.object({ label: text, blocks: z.array(blockSchema), exercises: z.array(exerciseSchema) })),
  provenance: z.object({ sourceId: z.number().int().positive(), url: z.string(), dateField: z.literal('recordDate'), dateLabel: text, publicationDateLabel: text.nullable(), classField: z.literal('wodClass') }),
});
// App day-workout list (`bookingwod?filterDay=YYYYMMDD`): the publisher's workouts for that date, one per class.
// Strict envelope: unexpected fields (for example pagination) must not pass as a complete day.
const dayWorkoutsSchema = z.object({ elements: z.array(z.object({ id: z.number().int().positive().safe(), wodClass: text.nullish() })).max(100) }).strict();
export function parseDayWorkouts(body: unknown) {
  const parsed = dayWorkoutsSchema.safeParse(body);
  if (!parsed.success || new Set(parsed.data.elements.map(p => p.id)).size !== parsed.data.elements.length) throw new AimHarderError('INVALID_WORKOUT_RESPONSE');
  return parsed.data.elements;
}
const blockDetailSchema = z.object({
  notes: text.nullish(), deleted: z.boolean(), type: scalar.optional(), timecap: scalar.optional(), timecaptype: scalar.optional(), time: scalar.optional(), rx: scalar.optional(), rondas: scalar.optional(), sstipo: scalar.optional(), reps: z.unknown().optional(),
  scaledops: z.union([z.array(text).max(20), z.literal(-1)]).nullish(), scaledver: z.array(z.unknown()).max(20).nullish(),
}).refine(block => unitIndex(block.type) !== 3 || block.reps === undefined || scalar.safeParse(block.reps).success);
const exerciseDetailSchema = z.object({ ejerName: text, ejerId: z.unknown().optional(), tipoWOD: z.number().int().nonnegative().nullish(),
    valor1: z.array(scalar).nullish(), valor2: scalar.nullish(), valor2h: scalar.nullish(), valor2m: scalar.nullish(), formaReg: scalar.optional(), tipoud: scalar.optional(), tipoud2: scalar.optional(), round: scalar.optional(), roundrepeat: scalar.optional(), complex: scalar.optional(), complexrep: scalar.optional(),
    scaledver: z.array(z.unknown()).max(20).nullish(),
});
const detailSchema = z.object({
  recordDate: text, publishDate: text.nullish(),
  TIPOWODs: z.array(blockDetailSchema), ejerRate: z.array(exerciseDetailSchema),
});
function unitIndex(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) ? value
    : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : -1;
}
function projectBlock({ notes, deleted, scaledops: _scaledops, scaledver: _scaledver, reps, ...prescription }: z.infer<typeof blockDetailSchema>) {
  const emomMode = unitIndex(prescription.type) === 3 && reps !== undefined ? { reps: scalar.parse(reps) } : {};
  return { notes: deleted ? null : notes ?? null, prescription: deleted ? {} : { ...Object.fromEntries(Object.entries(prescription).filter(([, value]) => value !== undefined)), ...emomMode } };
}
function projectExercise({ ejerName, ejerId, tipoWOD, scaledver: _scaledver, ...prescription }: z.infer<typeof exerciseDetailSchema>) {
  const form = prescription.formaReg;
  const format = typeof form === 'number' && Number.isInteger(form) ? form : typeof form === 'string' && /^[1-6]$/.test(form) ? Number(form) : -1;
  const rawUnit = format === 4 ? prescription.tipoud : format === 6 ? prescription.tipoud2 : undefined;
  const hasValue = (value: unknown) => value !== undefined && value !== null && value !== '';
  const hasPrimaryValue = prescription.valor1?.some(hasValue) ?? false;
  const hasLoadValue = [prescription.valor2, prescription.valor2h, prescription.valor2m].some(hasValue);
  const loadUnit = hasLoadValue ? loadUnits[unitIndex(rawUnit)] : undefined;
  let valueUnit: string | undefined;
  if (hasPrimaryValue) {
    if (format === 1) valueUnit = 's';
    else if (format === 2 || format === 6) valueUnit = distanceUnits[unitIndex(prescription.tipoud)];
    else if (format === 3 || format === 4) valueUnit = 'reps';
    else if (format === 5) valueUnit = 'cal';
  }
  return { name: ejerName, sourceExerciseId: validatedExerciseId(ejerId), blockIndex: tipoWOD ?? null, prescription: {
    ...Object.fromEntries(Object.entries(prescription).filter(([, value]) => value !== undefined)),
    ...(valueUnit ? { valueUnit } : {}),
    ...(loadUnit ? { loadUnit } : {}),
  } };
}
export function validatedExerciseId(value: unknown): number | null {
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}
const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export type WorkoutPost = { id: number; wodClass?: string | null | undefined; TIPOWODs?: { title?: string | null | undefined }[] | undefined };
export function parseWorkout(body: unknown, post: WorkoutPost, gymId: string, timeZone: string) {
  const parsed = detailSchema.safeParse(body);
  if (!parsed.success) return null;
  const row = parsed.data;
  const match = /^(\d{1,2}) de ([A-Za-z]+) de (\d{4})$/.exec(row.recordDate);
  if (!match) return null;
  const month = months.indexOf(match[2]!);
  const date = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
  if (month < 0 || !dateSchema.safeParse(date).success || !post.wodClass) return null;
  if (row.ejerRate.some(e => e.tipoWOD != null && !row.TIPOWODs[e.tipoWOD])) return null;
  const labels: string[] = [];
  for (const block of row.TIPOWODs) {
    if (!Array.isArray(block.scaledops)) continue;
    if (new Set(block.scaledops).size !== block.scaledops.length || block.scaledops.some(label => !label.trim())) return null;
    for (const label of block.scaledops) if (!labels.includes(label)) labels.push(label);
  }
  const variants = [];
  for (const label of labels) {
    const blocks = [];
    const deletedBlocks = [];
    for (const block of row.TIPOWODs) {
      const index = Array.isArray(block.scaledops) ? block.scaledops.indexOf(label) : -1;
      const source = index < 0 || block.scaledver?.[index] == null ? block : blockDetailSchema.safeParse(block.scaledver[index]).data;
      if (!source) return null;
      blocks.push(projectBlock(source));
      deletedBlocks.push(source.deleted);
    }
    const exercises = [];
    for (const exercise of row.ejerRate) {
      if (exercise.tipoWOD == null) continue;
      const parent = row.TIPOWODs[exercise.tipoWOD]!;
      const index = Array.isArray(parent.scaledops) ? parent.scaledops.indexOf(label) : -1;
      const source = index < 0 ? exercise : exerciseDetailSchema.safeParse(exercise.scaledver?.[index]).data;
      if (!source || source.tipoWOD !== exercise.tipoWOD) return null;
      if (deletedBlocks[exercise.tipoWOD]) continue;
      exercises.push(projectExercise(source));
    }
    variants.push({ label, blocks, exercises });
  }
  return {
    date, className: post.wodClass, timeZone, sessionId: null,
    titles: (post.TIPOWODs ?? []).flatMap(block => block.title ? [block.title] : []),
    blocks: row.TIPOWODs.map(projectBlock),
    exercises: row.ejerRate.filter(e => e.tipoWOD == null || !row.TIPOWODs[e.tipoWOD]?.deleted).map(projectExercise),
    variants,
    provenance: { sourceId: post.id, url: `https://${gymId}.aimharder.es/api/activity/workout?SEID=${post.id}`, dateField: 'recordDate' as const, dateLabel: row.recordDate, publicationDateLabel: row.publishDate ?? null, classField: 'wodClass' as const },
  };
}

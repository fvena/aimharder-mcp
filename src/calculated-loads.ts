import { z } from 'zod';
import { exercise1RMResultSchema } from './exercise-records.js';
import type { workoutSchema } from './workouts.js';

const physicalUnitSchema = z.enum(['kg', 'lbs']);
const alternativeSchema = z.object({
  sourceField: z.enum(['valor2', 'valor2h', 'valor2m']), sourceLabel: z.enum(['single', 'male', 'female']),
  originalPercent: z.string(), status: z.enum(['available', 'unavailable']), reason: z.string().nullable(),
  calculatedLoad: z.string().nullable(), unit: physicalUnitSchema.nullable(),
  basis: z.object({ rule: z.literal('latest-dated-1rm-times-percent'), sourceExerciseId: z.number().int().positive(), value: z.string(), sourceDate: z.string() }).nullable(),
});
export const personalLoadSchema = z.object({ status: z.enum(['available', 'unavailable', 'partial']), reason: z.string().nullable(), alternatives: z.array(alternativeSchema) });
export const enrichmentSchema = z.object({ status: z.enum(['not-applicable', 'complete', 'incomplete']), eligibleExercises: z.number().int().nonnegative(), availableExercises: z.number().int().nonnegative(), unavailableExercises: z.number().int().nonnegative(), basis: z.literal('latest-dated-1rm-times-percent') });

export type Workout = z.infer<typeof workoutSchema>;
export type Exercise = Workout['exercises'][number];
export type PersonalRM = z.infer<typeof exercise1RMResultSchema> | { readFailure: true };

function decimal(value: unknown): string | null {
  const string = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(string) && string.length <= 40 && Number(string) > 0 && Number.isFinite(Number(string)) ? string : null;
}

function preciseLoad(value: string, percentage: string) {
  const [wholeLoad, fractionalLoad = ''] = value.split('.');
  const [wholePercent, fractionalPercent = ''] = percentage.split('.');
  const numerator = BigInt(wholeLoad! + fractionalLoad) * BigInt(wholePercent! + fractionalPercent);
  const scale = fractionalLoad.length + fractionalPercent.length + 2;
  const digits = numerator.toString().padStart(scale + 1, '0');
  return (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale).replace(/0+$/, '')}`.replace(/\.$/, '') : digits);
}

function rawAlternatives(exercise: Exercise) {
  const p = exercise.prescription;
  if ((p.valor2h !== undefined && p.valor2h !== null) || (p.valor2m !== undefined && p.valor2m !== null)) {
    return [
      { sourceField: 'valor2h' as const, sourceLabel: 'male' as const, raw: p.valor2h },
      { sourceField: 'valor2m' as const, sourceLabel: 'female' as const, raw: p.valor2m },
    ];
  }
  return [{ sourceField: 'valor2' as const, sourceLabel: 'single' as const, raw: p.valor2 }];
}

export function percentageExercise(exercise: Exercise) {
  return exercise.prescription.loadUnit === '%RM';
}

export function calculatePersonalLoad(exercise: Exercise, rm: PersonalRM | undefined) {
  const raw = rawAlternatives(exercise);
  const alternatives = raw.map(item => {
    const originalPercent = item.raw == null ? '' : String(item.raw);
    let percentage = decimal(item.raw);
    let reason: string | null = null;
    if (typeof item.raw === 'string' && item.raw.includes('/')) {
      const pair = item.raw.trim().split('/').map(part => decimal(part.trim()));
      if (item.sourceField === 'valor2' && pair.length === 2 && pair[0] != null && pair[0] === pair[1]) percentage = pair[0]!;
      else reason = 'unstructured-or-unequal-percentage';
    }
    if (percentage === null && reason === null) reason = 'unsupported-percentage';
    if (exercise.sourceExerciseId === null) reason ??= 'source-exercise-id-unavailable';
    if (rm === undefined) reason ??= 'personal-read-limit';
    else if ('readFailure' in rm) reason ??= 'personal-read-failed';
    else if (rm.status === 'no-1rm') reason ??= 'no-1rm-in-returned-view';
    else if (rm.status === 'unit-unverified' || rm.latest1RM?.unit === null) reason ??= 'physical-unit-unverified';
    const latest = rm && !('readFailure' in rm) ? rm.latest1RM : null;
    const basis = latest && exercise.sourceExerciseId !== null ? { rule: 'latest-dated-1rm-times-percent' as const, sourceExerciseId: exercise.sourceExerciseId, value: latest.value, sourceDate: latest.sourceDate } : null;
    return { sourceField: item.sourceField, sourceLabel: item.sourceLabel, originalPercent, status: reason ? 'unavailable' as const : 'available' as const, reason,
      calculatedLoad: reason || !latest || !percentage ? null : preciseLoad(latest.value, percentage),
      unit: reason || !latest ? null : latest.unit, basis };
  });
  const available = alternatives.filter(item => item.status === 'available').length;
  return { status: available === alternatives.length ? 'available' as const : available === 0 ? 'unavailable' as const : 'partial' as const,
    reason: available === alternatives.length ? null : 'One or more source percentages could not be calculated.', alternatives };
}

export function gymLocalToday(zone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

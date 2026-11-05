import { z } from 'zod';
import { dateSchema } from './classes.js';
import { gymIdSchema } from './config.js';
import { AimHarderError } from './errors.js';
import { parseWorkout, workoutSchema } from './workouts.js';

export const activityQuerySchema = z.object({ startDate: dateSchema, endDate: dateSchema, gymId: gymIdSchema.optional() }).strict()
  .refine(q => q.startDate <= q.endDate && (Date.parse(`${q.endDate}T00:00:00Z`) - Date.parse(`${q.startDate}T00:00:00Z`)) / 86_400_000 < 31,
    { message: 'Supply an inclusive interval of 1 to 31 consecutive calendar dates.' });
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
// Preserve source result names. The user confirmed that time is measured in seconds.
const resultNumber = z.number().finite().nullable().optional();
const activityResultSchema = z.object({
  res: resultNumber, reps: resultNumber, time: resultNumber.describe('Recorded time in seconds; unit confirmed by the user.'), rondas: resultNumber,
  desc: z.string().max(100_000).nullable().optional().describe('Original result description for this activity and block; format is not universal across gyms.'),
  rx: z.boolean().nullable().optional(), rxstr: z.string().max(100_000).nullable().optional(),
});
const resultDetailSchema = z.object({ TIPOWODs: z.array(z.unknown()), chartData: z.unknown().optional() });
const chartRowSchema = z.object({ idAction: z.number().int().positive().safe(), desc: z.string().max(100_000).nullable().optional() });
function resultDescription(chartData: unknown, source: unknown, activityId: number) {
  if (chartData == null) return {};
  const chart = z.record(z.string(), z.unknown()).safeParse(chartData);
  const block = z.object({ id: z.number().int().positive().safe().optional() }).safeParse(source);
  if (!chart.success || !block.success) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
  if (block.data.id === undefined) return {};
  const rows = chart.data[String(block.data.id)];
  if (rows === undefined) return {};
  if (!Array.isArray(rows)) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
  const descriptions: (string | null | undefined)[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || row.idAction !== activityId) continue;
    const parsed = chartRowSchema.safeParse(row);
    if (!parsed.success) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
    descriptions.push(parsed.data.desc);
  }
  if (new Set(descriptions).size > 1) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
  return descriptions.length && descriptions[0] !== undefined ? { desc: descriptions[0] } : {};
}
export const activityEntrySchema = workoutSchema.pick({ titles: true, blocks: true, exercises: true }).extend({
  blocks: z.array(workoutSchema.shape.blocks.element.extend({ result: activityResultSchema.optional() })),
  sourceActivityId: z.number().int().positive().safe(), date: dateSchema, timeZone: z.string(), startTime: z.null(), trainingSessionId: z.null(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export const activityCoverageSchema = z.object({ status: z.enum(['complete', 'incomplete']), scope: z.literal('account-activity-calendar'), completedDates: z.array(dateSchema), reason: z.string().nullable() });
const ratesSchema = z.object({ ids: z.array(z.number().int().positive().safe()).max(500), colors: z.array(z.string().nullable()).optional() })
  .catchall(z.array(z.unknown()))
  .refine(row => Object.keys(row).every(key => key === 'ids' || key === 'colors' || /^[1-9]\d*$/.test(key)));
// This calendar container is not projected; rates.ids and verified details select entries.
const calendarSchema = z.object({ workouts: z.union([z.array(z.never()), z.record(dateSchema, z.object({ rates: ratesSchema, TIPOWODs: z.record(z.string(), z.unknown()) }).strict())]) }).strict();
export function parseActivityCalendar(body: unknown, month: string) {
  const parsed = calendarSchema.safeParse(body);
  if (!parsed.success) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
  const entries = new Map<string, number[]>();
  const seen = new Map<number, string>();
  for (const [date, day] of Object.entries(parsed.data.workouts)) {
    if (!date.startsWith(`${month}-`)) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
    for (const id of day.rates.ids) {
      if (seen.has(id) && seen.get(id) !== date) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
      seen.set(id, date);
    }
    entries.set(date, [...new Set(day.rates.ids)]);
  }
  return entries;
}
const identitySchema = z.object({ userId: z.number().int().positive().safe(), boxId: z.number().int().positive().safe() });
export function parseActivityDetail(body: unknown, sourceActivityId: number, date: string, accountId: number, boxId: number, gymId: string, timeZone: string): ActivityEntry | null {
  const identity = identitySchema.safeParse(body);
  if (!identity.success || identity.data.userId !== accountId) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
  // The calendar is account-wide. Verify the detail's gym before projecting it.
  if (identity.data.boxId !== boxId) return null;
  const workout = parseWorkout(body, { id: sourceActivityId, wodClass: 'personal-activity' }, gymId, timeZone);
  if (!workout || workout.date !== date) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
  const details = resultDetailSchema.safeParse(body);
  if (!details.success) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
  const blocks = workout.blocks.map((block, index) => {
    const source = details.data.TIPOWODs[index];
    // Deleted blocks retain their position, but never expose recorded results.
    if (typeof source === 'object' && source !== null && 'deleted' in source && source.deleted === true) return { ...block, result: {} };
    const result = activityResultSchema.omit({ desc: true }).safeParse(source);
    if (!result.success) throw new AimHarderError('INVALID_ACTIVITY_RESPONSE');
    return { ...block, result: { ...result.data, ...resultDescription(details.data.chartData, source, sourceActivityId) } };
  });
  return activityEntrySchema.parse({ sourceActivityId, date, timeZone, startTime: null, trainingSessionId: null, titles: workout.titles, blocks, exercises: workout.exercises });
}

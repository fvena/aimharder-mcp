import { z } from 'zod';
import { exerciseIdSchema, exercise1RMResultSchema } from './exercise-records.js';

export const exerciseSearchQuerySchema = z.object({ name: z.string().trim().min(1).max(100), exerciseId: exerciseIdSchema.optional() }).strict();
export type ExerciseSearchQuery = z.infer<typeof exerciseSearchQuerySchema>;

const candidateSchema = z.object({ id: exerciseIdSchema, name: z.string().trim().min(1).max(300), type: z.literal(0) });
const searchSchema = z.object({ term: z.string().max(300), result: z.array(candidateSchema).max(50) });
const publicCandidateSchema = z.object({ sourceExerciseId: exerciseIdSchema, name: z.string() });

export const exerciseSearchResultSchema = z.object({
  gym: exercise1RMResultSchema.shape.gym,
  name: z.string(), status: z.enum(['selected', 'ambiguous', 'empty-view', 'unsupported-view', 'selection-not-found']),
  candidates: z.array(publicCandidateSchema), selected: exercise1RMResultSchema.omit({ gym: true }).nullable(),
  coverage: z.object({ status: z.literal('limited'), scope: z.literal('returned-exercise-search-view'), returnedCount: z.number().int().nonnegative(), possibleTruncation: z.boolean() }),
  notices: z.array(z.string()),
});

export function parseExerciseSearch(body: unknown, name: string, selectedId?: number) {
  const parsed = searchSchema.safeParse(body);
  const coverage = { status: 'limited' as const, scope: 'returned-exercise-search-view' as const,
    returnedCount: parsed.success ? parsed.data.result.length : 0, // The app search returned at most 20 candidates in live checks; a full page may be truncated.
    possibleTruncation: parsed.success && parsed.data.result.length >= 20 };
  const base = { name, coverage, notices: ['Search results are candidates, not proof of personal records or an exhaustive exercise catalog. Filtering and pagination are unverified.'] };
  if (!parsed.success || new Set(parsed.data.result.map(row => row.id)).size !== parsed.data.result.length) {
    return { ...base, status: 'unsupported-view' as const, candidates: [], chosenId: null };
  }
  const candidates = parsed.data.result.map(row => ({ sourceExerciseId: row.id, name: row.name }));
  if (!candidates.length) return { ...base, status: 'empty-view' as const, candidates, chosenId: null };
  if (selectedId !== undefined) return candidates.some(candidate => candidate.sourceExerciseId === selectedId)
    ? { ...base, status: 'selected' as const, candidates, chosenId: selectedId }
    : { ...base, status: 'selection-not-found' as const, candidates, chosenId: null };
  const exact = candidates.filter(candidate => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  const sole = candidates.length === 1 && candidates[0]!.name.toLocaleLowerCase().includes(name.toLocaleLowerCase()) ? candidates[0] : null;
  const chosenId = exact.length === 1 ? exact[0]!.sourceExerciseId : exact.length === 0 ? sole?.sourceExerciseId ?? null : null;
  return { ...base, status: chosenId === null ? 'ambiguous' as const : 'selected' as const, candidates, chosenId };
}

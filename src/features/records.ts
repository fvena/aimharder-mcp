import { z } from 'zod';
import { AimHarderError } from '../errors.js';
import { exercise1RMQuerySchema, parseExercise1RM, parseExerciseProgression, type Exercise1RMQuery } from '../domain/exercise-records.js';
import { exerciseSearchQuerySchema, parseExerciseSearch, type ExerciseSearchQuery } from '../domain/exercise-search.js';
import { type Context } from './context.js';

export function getExercise1RM(ctx: Context, input: Exercise1RMQuery) {
  const parsed = exercise1RMQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_EXERCISE_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym } = session;
    const body = await session.read({ kind: 'exercise', exerciseId: query.exerciseId });
    return { gym, ...parseExercise1RM(body, query.exerciseId, session.accountId) };
  });
}


export function findExercise1RM(ctx: Context, input: ExerciseSearchQuery) {
  const parsed = exerciseSearchQuerySchema.safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_EXERCISE_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym } = session;
    const search = parseExerciseSearch(await session.read({ kind: 'exercise-search', name: query.name }), query.name, query.exerciseId);
    if (search.chosenId === null) {
      const { chosenId: _chosenId, ...publicSearch } = search;
      return { gym, ...publicSearch, selected: null };
    }
    const body = await session.read({ kind: 'exercise', exerciseId: search.chosenId });
    const { chosenId: _chosenId, ...publicSearch } = search;
    return { gym, ...publicSearch, selected: parseExercise1RM(body, search.chosenId, session.accountId) };
  });
}


export function getExerciseProgression(ctx: Context, input: Exercise1RMQuery & { includeWod?: boolean | undefined }) {
  const parsed = exercise1RMQuerySchema.extend({ includeWod: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return Promise.reject(new AimHarderError('INVALID_EXERCISE_QUERY'));
  const query = parsed.data;
  return ctx.upstream.withGym(query.gymId, async (session) => {
    const { gym } = session;
    const body = await session.read({ kind: 'exercise', exerciseId: query.exerciseId });
    return { gym, ...parseExerciseProgression(body, query.exerciseId, session.accountId, query.includeWod ?? false) };
  });
}

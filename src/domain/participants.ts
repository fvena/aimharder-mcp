import { z } from 'zod';
import { dateSchema, timeSchema } from './classes.js';
import { gymIdSchema } from '../config.js';
import { AimHarderError } from '../errors.js';

export const participantsFilterSchema = z.enum(['all', 'following']);
export type ParticipantsFilter = z.infer<typeof participantsFilterSchema>;
export const participantsQuerySchema = z.object({
  date: dateSchema, className: z.string().trim().min(1).max(300), startTime: timeSchema, gymId: gymIdSchema.optional(),
  filter: participantsFilterSchema.optional().describe('all: every participant; following: only athletes the account follows in AimHarder or lists as friends. Defaults to AIMHARDER_PARTICIPANTS_FILTER, else all.'),
}).strict();
export type ParticipantsQuery = z.infer<typeof participantsQuerySchema>;

export const participantSchema = z.object({
  userId: z.number().int().positive().safe().describe('AimHarder user ID of the participant.'),
  name: z.string(),
  sourceState: z.number().int().nullable().describe('Raw source state; its meaning is unverified.'),
});

const athletesSchema = z.object({
  athletes: z.array(z.object({
    usid: z.number().int().positive().safe(),
    name: z.string().trim().min(1).max(300),
    state: z.number().int().nullish(),
  })).max(500),
});

/** Parse the app's class participant list without photos or badges. */
export function parseParticipants(body: unknown) {
  const parsed = athletesSchema.safeParse(body);
  if (!parsed.success || new Set(parsed.data.athletes.map(row => row.usid)).size !== parsed.data.athletes.length) {
    throw new AimHarderError('INVALID_PARTICIPANTS_RESPONSE');
  }
  return parsed.data.athletes.map(row => ({ userId: row.usid, name: row.name, sourceState: row.state ?? null }));
}

// App `user/list?type=1`: accounts the user follows. Gym accounts (`isBox`) are not athletes.
const followingSchema = z.object({
  type: z.union([z.literal(1), z.literal('1')]),
  users: z.array(z.object({ id: z.number().int().positive().safe(), isBox: z.union([z.literal(0), z.literal(1)]).nullish() })).max(500),
});

/** User IDs of the followed athletes on one page; an empty page ends the list. */
export function parseFollowingPage(body: unknown) {
  const parsed = followingSchema.safeParse(body);
  if (!parsed.success) throw new AimHarderError('INVALID_FOLLOWING_RESPONSE');
  return { size: parsed.data.users.length, athleteIds: parsed.data.users.filter(user => user.isBox !== 1).map(user => user.id) };
}

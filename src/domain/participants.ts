import { z } from 'zod';
import { dateSchema, timeSchema } from './classes.js';
import { gymIdSchema } from '../config.js';
import { AimHarderError } from '../errors.js';

export const participantsQuerySchema = z.object({
  date: dateSchema, className: z.string().trim().min(1).max(300), startTime: timeSchema, gymId: gymIdSchema.optional(),
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

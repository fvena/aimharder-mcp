import { z } from 'zod';
import { dateSchema, timeSchema } from './classes.js';
import { participantsFilterValues } from '../config.js';
import { AimHarderError } from '../errors.js';

export const participantsFilterSchema = z.enum(participantsFilterValues);
export type ParticipantsFilter = z.infer<typeof participantsFilterSchema>;
export const participantsQuerySchema = z.object({
  date: dateSchema, className: z.string().trim().min(1).max(300), startTime: timeSchema,
  filter: participantsFilterSchema.optional().describe('all: every participant; friends: only the account holder\'s friends. Defaults to AIMHARDER_PARTICIPANTS_FILTER, else all.'),
}).strict();
export type ParticipantsQuery = z.infer<typeof participantsQuerySchema>;

export const participantSchema = z.object({
  userId: z.number().int().positive().safe().describe('AimHarder user ID of the participant.'),
  name: z.string(),
  sourceState: z.number().int().nullable().describe('Raw source state; its meaning is unverified.'),
  photoUrl: z.string().nullable().describe('Public HTTPS URL of the participant\'s profile picture, or null.'),
  friendName: z.string().optional().describe('The name the account holder gave this friend; present only for friends.'),
});

const athletesSchema = z.object({
  athletes: z.array(z.object({
    usid: z.number().int().positive().safe(),
    name: z.string().trim().min(1).max(300),
    state: z.number().int().nullish(),
    pic: z.string().max(500).nullish(),
  })).max(500),
});

/** Parse the app's class participant list, keeping only an HTTPS profile picture and no badges. */
export function parseParticipants(body: unknown) {
  const parsed = athletesSchema.safeParse(body);
  if (!parsed.success || new Set(parsed.data.athletes.map(row => row.usid)).size !== parsed.data.athletes.length) {
    throw new AimHarderError('INVALID_PARTICIPANTS_RESPONSE');
  }
  return parsed.data.athletes.map(row => ({ userId: row.usid, name: row.name, sourceState: row.state ?? null, photoUrl: httpsUrl(row.pic) }));
}

const httpsUrl = (value: string | null | undefined) => (value && URL.canParse(value) && new URL(value).protocol === 'https:' ? value : null);

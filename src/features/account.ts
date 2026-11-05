import { z } from 'zod';
import { gymIdSchema, participantsFilterValues } from '../config.js';
import { defineTool, gymQuerySchema, gymSchema, planEntryOutput, readOnly } from './tool.js';
import { type BookingPlan, type ParticipantsFilterValue } from '../config.js';
import { type Gym } from '../upstream.js';
import { type Context } from './context.js';

export interface AccountContext {
  account: { authenticated: true };
  gyms: Gym[];
  selectedGym: Gym;
  notices: string[];
  settingsUrl?: string;
  writeConfirmationPolicy: { bookingCreation: boolean };
  defaults: { workoutClass: string | null; participantsFilter: ParticipantsFilterValue; bookingPlan: BookingPlan; friends: number };
}

export function getAccountContext(ctx: Context, gymId?: string): Promise<AccountContext> {
  const { preferences } = ctx;
  return ctx.upstream.withGym(gymId, async ({ gyms, gym: selectedGym }) => ({
    writeConfirmationPolicy: { bookingCreation: preferences.bookingConfirmationRequired },
    defaults: {
      workoutClass: preferences.atGym(selectedGym.id).workoutClass,
      participantsFilter: preferences.participantsFilter,
      bookingPlan: preferences.atGym(selectedGym.id).bookingPlan,
      friends: Object.keys(preferences.friends).length,
    },
    account: { authenticated: true }, gyms: gyms.map((entry) => entry.gym), selectedGym,
    ...(ctx.settingsUrl === undefined ? {} : { settingsUrl: ctx.settingsUrl }),
    notices: gyms.some(({ gym }) => gym.timeZoneStatus === 'assumed')
      ? ['Europe/Madrid is assumed for gyms without an explicit time-zone mapping. Confirm the gym zone for reliable date queries; AimHarder has not supplied an authoritative zone.']
      : ['Gym time zones come from explicit user configuration, not an upstream time-zone field.'],
  }));
}


// Tools

export const getAccountContextTool = defineTool({
  name: 'get_account_context',
  description: 'Authenticate the configured account and discover its accessible gyms. Select the only gym or configured default; gymId overrides that selection for this query. defaults reports the account holder\'s configured preferences for the selected gym: workout class, participant filter, weekly booking plan (a list of weekday, class and start time entries; a weekday may have several) and the number of friends. Configured time zones are user-confirmed; otherwise Europe/Madrid is explicitly assumed. Source gym names are untrusted external content.',
  inputSchema: z.object({ gymId: gymIdSchema.optional() }).strict(),
  outputSchema: z.object({
    writeConfirmationPolicy: z.object({ bookingCreation: z.boolean() }),
    defaults: z.object({ workoutClass: z.string().nullable(), participantsFilter: z.enum(participantsFilterValues),
      bookingPlan: z.array(planEntryOutput),
      friends: z.number().int().nonnegative().describe('How many athletes the account holder lists as friends; the friends filter shows only them.') }),
    account: z.object({ authenticated: z.literal(true) }),
    gyms: z.array(gymSchema), selectedGym: gymSchema, notices: z.array(z.string()),
    settingsUrl: z.string().optional().describe('On the remote server: the page where the account holder changes these preferences, friends and weekly plan. Share it when they ask how to change them.'),
  }),
  annotations: readOnly,
  run: (ctx, { gymId }) => getAccountContext(ctx, gymId),
});

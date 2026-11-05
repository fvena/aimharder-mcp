import { type BookingPlan } from '../config.js';
import { type Gym } from '../upstream.js';
import { type Context } from './context.js';

export interface AccountContext {
  account: { authenticated: true };
  gyms: Gym[];
  selectedGym: Gym;
  notices: string[];
  writeConfirmationPolicy: { bookingCreation: boolean };
  defaults: { workoutClass: string | null; participantsFilter: 'all' | 'following'; bookingPlan: BookingPlan };
}

export function getAccountContext(ctx: Context, gymId?: string): Promise<AccountContext> {
  return ctx.upstream.withGym(gymId, async ({ gyms, gym: selectedGym }) => ({
    writeConfirmationPolicy: { bookingCreation: ctx.config.requireBookingConfirmation !== false },
    defaults: {
      workoutClass: ctx.config.workoutClasses && Object.hasOwn(ctx.config.workoutClasses, selectedGym.id) ? ctx.config.workoutClasses[selectedGym.id]! : null,
      participantsFilter: ctx.config.participantsFilter ?? 'all',
      bookingPlan: ctx.config.bookingPlans && Object.hasOwn(ctx.config.bookingPlans, selectedGym.id) ? ctx.config.bookingPlans[selectedGym.id]! : {},
    },
    account: { authenticated: true }, gyms: gyms.map((entry) => entry.gym), selectedGym,
    notices: gyms.some(({ gym }) => gym.timeZoneStatus === 'assumed')
      ? ['Europe/Madrid is assumed for gyms without an explicit time-zone mapping. Confirm the gym zone for reliable date queries; AimHarder has not supplied an authoritative zone.']
      : ['Gym time zones come from explicit user configuration, not an upstream time-zone field.'],
  }));
}

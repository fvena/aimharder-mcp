import type { BookingPlan, Configuration, Friends, ParticipantsFilterValue } from './config.js';

/** What applies at one gym: the account holder's defaults there and the gym's rules. */
export interface GymPreferences {
  /** The class meant by "today's workout", or null when none is configured. */
  workoutClass: string | null;
  /** The weekly booking plan, in weekday and start-time order. */
  bookingPlan: BookingPlan;
  /** Booking opens this many days before a class, when the gym has that rule. */
  bookingWindowDays: number | undefined;
  /** Cancelling within this many minutes of a class may lose a credit, when the gym has that rule. */
  cancellationWindowMinutes: number | undefined;
}

/**
 * The account holder's effective preferences, after layering the environment, the gym rules and their own settings
 * (see `applySettings`). Features ask this module instead of reading the configuration.
 */
export interface Preferences {
  atGym(gymId: string): GymPreferences;
  /** Who "who is coming" shows by default. */
  participantsFilter: ParticipantsFilterValue;
  /** Friends by AimHarder user ID. */
  friends: Friends;
  /** Whether booking creation needs a separate confirmation; cancellation and results always do. */
  bookingConfirmationRequired: boolean;
}

export function preferencesOf(config: Configuration): Preferences {
  const at = <T>(record: Record<string, T> | undefined, gymId: string) => (record && Object.hasOwn(record, gymId) ? record[gymId] : undefined);
  return {
    atGym: (gymId) => ({
      workoutClass: at(config.workoutClasses, gymId) ?? null,
      bookingPlan: at(config.bookingPlans, gymId) ?? [],
      bookingWindowDays: at(config.bookingWindowDays, gymId),
      cancellationWindowMinutes: at(config.cancellationWindowMinutes, gymId),
    }),
    participantsFilter: config.participantsFilter ?? 'all',
    friends: config.friends ?? {},
    bookingConfirmationRequired: config.requireBookingConfirmation !== false,
  };
}

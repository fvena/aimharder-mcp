import type { BookingPlan, Configuration, Friends, ParticipantsFilterValue } from './config.js';

/**
 * The account holder's effective preferences at their gym, after layering the environment and their own settings
 * (see `applySettings`). Features ask this module instead of reading the configuration.
 */
export interface Preferences {
  /** The class meant by "today's workout", or null when none is configured. */
  workoutClass: string | null;
  /** The weekly booking plan, in weekday and start-time order. */
  bookingPlan: BookingPlan;
  /** Booking opens this many days before a class, when the account holder set that rule. */
  bookingWindowDays: number | undefined;
  /** Cancelling within this many minutes of a class may lose a credit, when the account holder set that rule. */
  cancellationWindowMinutes: number | undefined;
  /** Who "who is coming" shows by default. */
  participantsFilter: ParticipantsFilterValue;
  /** Friends by AimHarder user ID. */
  friends: Friends;
  /** Whether booking creation needs a separate confirmation; cancellation and results always do. */
  bookingConfirmationRequired: boolean;
}

export function preferencesOf(config: Configuration): Preferences {
  return {
    workoutClass: config.workoutClass ?? null,
    bookingPlan: config.bookingPlan ?? [],
    bookingWindowDays: config.bookingWindowDays,
    cancellationWindowMinutes: config.cancellationWindowMinutes,
    participantsFilter: config.participantsFilter ?? 'all',
    friends: config.friends ?? {},
    bookingConfirmationRequired: config.requireBookingConfirmation !== false,
  };
}

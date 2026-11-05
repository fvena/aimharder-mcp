import { BookingPreparationStore } from '../domain/booking-preparation.js';
import type { Configuration } from '../config.js';
import { AimHarderError } from '../errors.js';
import { PreparationStore, type ExerciseResultDeletionPreview, type ExerciseResultPreview } from '../domain/exercise-results.js';
import { AimHarderUpstream } from '../upstream.js';

/** Everything a feature needs: AimHarder access, configuration and the single-use preview references. */
export interface Context {
  upstream: AimHarderUpstream;
  config: Configuration;
  bookingPreparations: BookingPreparationStore;
  resultPreparations: PreparationStore<ExerciseResultPreview>;
  deletionPreparations: PreparationStore<ExerciseResultDeletionPreview>;
}

export function createContext(config: Configuration): Context {
  return {
    upstream: new AimHarderUpstream(config), config,
    bookingPreparations: new BookingPreparationStore(),
    resultPreparations: new PreparationStore<ExerciseResultPreview>(),
    deletionPreparations: new PreparationStore<ExerciseResultDeletionPreview>(),
  };
}

/** Writes need `confirmed: true` unless the account holder turned confirmation off for that action. */
export function requireWriteConfirmation(marker: true | undefined, required = true) {
  if (required && marker !== true) throw new AimHarderError('WRITE_CONFIRMATION_REQUIRED');
}

/** A configured per-gym rule (booking window days, cancellation window minutes), if any. */
export function gymRule(rules: Record<string, number> | undefined, gymId: string) {
  return rules && Object.hasOwn(rules, gymId) ? rules[gymId] : undefined;
}

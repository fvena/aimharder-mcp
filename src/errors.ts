const messages = {
  WRITE_CONFIRMATION_REQUIRED: 'Write confirmations are enabled. Show the exact preview and obtain account-holder confirmation before executing with confirmed: true (confirmedCreditLoss: true for late cancellation).',
  INVALID_EXERCISE_QUERY: 'Supply one positive source exercise ID and an optional accessible gym ID. Account IDs and arbitrary URLs are not accepted.',
  INVALID_EXERCISE_RESPONSE: 'AimHarder returned unsupported or inconsistent own-account exercise data. No 1RM can be confirmed.',
  INVALID_LATE_CANCELLATION_QUERY: 'Supply a fresh late-cancellation reference and, when write confirmations are enabled, confirmedCreditLoss: true after separate confirmation of possible credit loss. Other selectors are not accepted.',
  INVALID_BOOKING_EXECUTION_QUERY: 'Supply a fresh action reference and, when write confirmations are enabled, confirmed: true after account-holder confirmation of the exact preview. Other selectors are not accepted.',
  BOOKING_REFERENCE_INVALID: 'The booking action reference is expired, already used, or does not match this account and gym. Prepare a fresh action.',
  INVALID_CANCELLATION_PREPARATION_QUERY: 'Supply one exact booked class name, gym-local date, start and end time, with an optional accessible gym ID. Reservation and family IDs are not accepted.',
  INVALID_BOOKING_PREPARATION_QUERY: 'Supply one exact class name, gym-local date, start and end time, with an optional accessible gym ID. Source, account, and family IDs are not accepted.',
  CONFIRMED_GYM_TIME_ZONE_REQUIRED: 'Booking preparation requires a user-confirmed IANA time zone for the selected gym. Configure AIMHARDER_GYM_TIME_ZONES and restart.',
  INVALID_EXERCISE_RESULT_QUERY: 'Supply a source exercise ID, a gym-local date today or earlier, 1–20 sets, 1–100 repetitions per set and a load in kilograms (steps of 0.25), with an optional accessible gym ID.',
  INVALID_EXERCISE_RESULT_EXECUTION_QUERY: 'Supply a fresh exercise-result reference and confirmed: true, with an optional matching gym ID.',
  INVALID_EXERCISE_RESULT_DELETION_QUERY: 'Supply a gym-local date and an own activity ID, with an optional accessible gym ID.',
  EXERCISE_RESULT_REFERENCE_INVALID: 'The exercise-result reference is expired, already used, or does not match this account and gym. Prepare a new preview.',
  INVALID_PARTICIPANTS_QUERY: 'Supply one exact class name, gym-local date and HH:mm start time, with an optional accessible gym ID.',
  INVALID_PARTICIPANTS_FILTER_CONFIGURATION: 'AIMHARDER_PARTICIPANTS_FILTER must be all or following.',
  INVALID_FOLLOWING_RESPONSE: 'AimHarder returned an unsupported list of followed accounts.',
  INVALID_PARTICIPANTS_RESPONSE: 'AimHarder returned an unsupported or inconsistent participant list.',
  INVALID_ACTIVITY_QUERY: 'Supply valid inclusive gym-local dates spanning at most 31 calendar dates.',
  INVALID_ACTIVITY_RESPONSE: 'AimHarder returned unsupported or inconsistent personal activity data.',
  ACTIVITY_LIMIT: 'The activity detail limit of 500 records was reached; coverage is incomplete.',
  INVALID_WORKOUT_QUERY: 'Supply a valid gym-local date and exact className, with optional verified gymId.',
  INVALID_WORKOUT_RESPONSE: 'AimHarder returned an unsupported or incomplete gym feed. Workout retrieval could not be confirmed.',
  INVALID_BOOKING_RESPONSE: 'AimHarder returned an unsupported, restricted, or incomplete upcoming-booking response. Booking status could not be confirmed.',
  INVALID_TIME_ZONE_CONFIGURATION: 'AIMHARDER_GYM_TIME_ZONES must be a JSON object mapping gym IDs to confirmed IANA time zones.',
  INVALID_CANCELLATION_WINDOW_CONFIGURATION: 'AIMHARDER_CANCELLATION_WINDOW_MINUTES must be a JSON object mapping gym IDs to whole minutes from 1 to 10080.',
  INVALID_WORKOUT_CLASS_CONFIGURATION: 'AIMHARDER_WORKOUT_CLASS must be a JSON object mapping gym IDs to an exact workout class name, such as {"my-gym":"CROSS"}.',
  INVALID_BOOKING_PLAN_CONFIGURATION: 'AIMHARDER_BOOKING_PLAN must be a JSON object mapping gym IDs to weekdays (mon–sun), each with an exact className and HH:mm startTime.',
  INVALID_FRIENDS_CONFIGURATION: 'AIMHARDER_FRIENDS must be a JSON object mapping AimHarder user IDs to a label, such as {"123456":"Laura"}, with at most 200 entries.',
  INVALID_PLANNED_BOOKING_QUERY: 'Supply valid inclusive gym-local dates spanning at most 14 calendar dates, with an optional accessible gym ID.',
  INVALID_BOOKING_WINDOW_CONFIGURATION: 'AIMHARDER_BOOKING_WINDOW_DAYS must be a JSON object mapping gym IDs to whole days from 1 to 60.',
  GYM_TIME_ZONE_REQUIRED: 'A valid IANA zone could not be established for the selected gym. Check AIMHARDER_GYM_TIME_ZONES and restart. No date query was made.',
  INVALID_CLASS_QUERY: 'Supply valid inclusive calendar dates and optional startTime (HH:mm), className, and gymId filters.',
  INVALID_CLASS_RESPONSE: 'AimHarder returned an unsupported, restricted, or incomplete class response. No schedule is returned for this interval.',
  INVALID_CONFIGURATION: 'Set AIMHARDER_USERNAME and AIMHARDER_PASSWORD to non-empty values, use a gym slug for AIMHARDER_DEFAULT_GYM if supplied, and set AIMHARDER_REQUIRE_BOOKING_CONFIRMATION and AIMHARDER_REQUIRE_PUBLICATION_CONFIRMATION to true or false if supplied.',
  INVALID_HTTP_CONFIGURATION: 'For MCP_TRANSPORT=http, set MCP_PUBLIC_URL to the public origin (https://host, no path; http only for localhost), MCP_OWNER_SECRET to at least 16 characters, and, if supplied, PORT to 1–65535 and MCP_OAUTH_REDIRECT_URIS to comma-separated https or loopback URLs.',
  AUTHENTICATION_FAILED: 'Authentication did not complete. Check credentials, additional authentication requirements, or account restrictions, then restart the server.',
  ACCESS_RESTRICTED: 'AimHarder denied access. Check account restrictions before trying again.',
  SESSION_EXPIRED: 'The session expired again after one reauthentication. No further retry was attempted.',
  INVALID_RESPONSE: 'AimHarder returned an unsupported or invalid response. Account or gym access could not be verified.',
  IDENTITY_MISMATCH: 'The authenticated account identity changed unexpectedly. Access could not be verified.',
  REQUEST_FAILED: 'The AimHarder request failed or attempted a redirect. No further retry was attempted.',
  NO_ACCESSIBLE_GYMS: 'No accessible gym was established from the account response.',
  UNSUPPORTED_MEMBERSHIP: 'The account includes an unverified membership format. Gym discovery could not be completed.',
  DEFAULT_GYM_REQUIRED: 'Multiple gyms are accessible. Set AIMHARDER_DEFAULT_GYM to one of their gym IDs and restart the server.',
  GYM_NOT_ACCESSIBLE: 'The requested or configured gym is not in the verified accessible gym list.',
} as const;

export class AimHarderError extends Error {
  constructor(readonly code: keyof typeof messages, readonly accessibleGymIds: string[] = []) {
    super(messages[code]);
    this.name = 'AimHarderError';
  }
}

export function safeError(error: unknown) {
  const safe = error instanceof AimHarderError ? error : new AimHarderError('REQUEST_FAILED');
  return { code: safe.code, message: safe.message, ...(safe.accessibleGymIds.length ? { accessibleGymIds: safe.accessibleGymIds } : {}) };
}

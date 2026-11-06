import { createHash, timingSafeEqual } from 'node:crypto';
import { applySettings, newGymSettings, sortPlan, userSettingsSchema, type BookingPlan, type Configuration, type Friends, type ParticipantsFilterValue, type PlanEntry, type UserSettings } from './config.js';
import { AimHarderError } from './errors.js';
import { createContext, type Context } from './features/context.js';
import { memberScope, ownerScope, type Member, type Store } from './store.js';
import { AimHarderUpstream } from './upstream.js';

/** Subject of the owner, whose AimHarder account is configured in the environment. Members' subjects are their account IDs. */
export const ownerSub = 'owner';

/** An account holder's own preferences as they apply now, to show and edit on the settings page. */
export interface EditablePreferences {
  /** The chosen gym; undefined when none is chosen (the account's only gym is used). */
  gym: string | undefined;
  /** The time zone the account holder confirmed for their gym, if any. */
  timeZone: string | undefined;
  bookingWindowDays: number | undefined;
  cancellationWindowMinutes: number | undefined;
  workoutClass: string | undefined;
  bookingPlan: BookingPlan;
  participantsFilter: ParticipantsFilterValue;
  friends: Friends;
}

export type SignInError = 'credentials' | 'not-invited' | 'unavailable';
export type JoinError = 'invitation' | 'credentials' | 'unavailable' | 'owner' | 'no-gym';

/**
 * The accounts a remote server serves: the owner, configured in the environment, and the members the owner invited.
 *
 * Each account gets its own context (AimHarder sessions and single-use previews) for its one gym, built from its own
 * settings (and, for the owner, the environment under them). Members sign in with their AimHarder account: the server verifies it with AimHarder and
 * accepts it only if the owner invited that account.
 */
export class Accounts {
  readonly #contexts = new Map<string, Context>();

  constructor(private readonly base: Configuration, readonly store: Store, private readonly settingsUrl?: string) {}

  isOwner(sub: string) { return sub === ownerSub; }

  /** The token generation of an account, or undefined when it no longer exists. */
  generation(sub: string): string | undefined {
    if (sub === ownerSub) return ownerSub;
    const id = memberId(sub);
    return id === undefined ? undefined : this.store.member(id)?.generation;
  }

  members(): Member[] { return this.store.members(); }

  /** The account's context, or undefined when the member is gone or their stored credentials cannot be read. */
  context(sub: string): Context | undefined {
    const cached = this.#contexts.get(sub);
    if (cached) return cached;
    const config = this.#configuration(sub);
    if (!config) return undefined;
    const context = createContext(config, this.settingsUrl);
    this.#contexts.set(sub, context);
    return context;
  }

  /** The account's configuration: its own settings (`own`, else the stored ones), for the owner over the environment. */
  #configuration(sub: string, own = this.#userSettings(sub)): Configuration | undefined {
    if (sub === ownerSub) return applySettings(this.base, own);
    const id = memberId(sub);
    const credentials = id === undefined ? undefined : this.store.credentials(id);
    if (!credentials) return undefined;
    // The environment configures the owner's account: members start from nothing but their own settings.
    return applySettings({ ...credentials, requireBookingConfirmation: true }, own);
  }

  /** The account holder's own preferences as they apply now: the environment's (for the owner) under their own settings. */
  preferences(sub: string): EditablePreferences | undefined {
    const config = this.#configuration(sub);
    return config && editable(config);
  }

  // Changes to an account's own preferences. Each validates the result and saves it as the account's own settings, or
  // throws and saves nothing; a change that alters nothing that applies is not saved. The plan and the friends list are
  // saved whole once edited, so entries that came from the environment stay in them; other values keep following the
  // environment until the account holder changes them.

  /**
   * Choose the account's gym (one of its gyms; the caller checks which it has). Choosing another gym clears every other
   * setting (see `newGymSettings`).
   */
  chooseGym(sub: string, gymId: string) {
    this.#change(sub, (own, current) => (current.gym === gymId ? own : newGymSettings(gymId)));
  }

  /** Add a class to the weekly plan, in weekday and start-time order, without duplicates. */
  addPlanEntry(sub: string, entry: PlanEntry) {
    this.#change(sub, (own, current) => ({ ...own, bookingPlan: sortPlan([...current.bookingPlan, entry]) }));
  }

  /** Remove a class from the weekly plan. */
  removePlanEntry(sub: string, entry: PlanEntry) {
    const same = (other: PlanEntry) => other.day === entry.day && other.startTime === entry.startTime && other.className === entry.className;
    this.#change(sub, (own, current) => ({ ...own, bookingPlan: current.bookingPlan.filter((other) => !same(other)) }));
  }

  /**
   * Set the gym's rules for this account: its time zone (which confirms it) and, null for none, the booking and
   * cancellation windows. Values not given, or equal to what applies now, are left as they are.
   */
  setGymRules(sub: string, rules: { timeZone?: string; bookingWindowDays?: number | null; cancellationWindowMinutes?: number | null }) {
    this.#change(sub, (own, current) => ({
      ...own,
      ...(rules.timeZone === undefined || rules.timeZone === current.timeZone ? {} : { timeZone: rules.timeZone }),
      ...(rules.bookingWindowDays === undefined || rules.bookingWindowDays === (current.bookingWindowDays ?? null) ? {} : { bookingWindowDays: rules.bookingWindowDays }),
      ...(rules.cancellationWindowMinutes === undefined || rules.cancellationWindowMinutes === (current.cancellationWindowMinutes ?? null) ? {} : { cancellationWindowMinutes: rules.cancellationWindowMinutes }),
    }));
  }

  /**
   * Set the defaults the assistant applies: the workout class (null for none, even when the environment sets one) and the
   * participants filter. Values not given, or equal to what applies now, are left as they are.
   */
  setDefaults(sub: string, defaults: { workoutClass?: string | null; participantsFilter?: string }) {
    this.#change(sub, (own, current) => ({
      ...own,
      ...(defaults.workoutClass === undefined || defaults.workoutClass === (current.workoutClass ?? null) ? {} : { workoutClass: defaults.workoutClass }),
      ...(defaults.participantsFilter === undefined || defaults.participantsFilter === current.participantsFilter ? {} : { participantsFilter: defaults.participantsFilter as ParticipantsFilterValue }),
    }));
  }

  /** Add friends, or update the name and picture of ones already listed. */
  addFriends(sub: string, friends: Friends) {
    this.#changeFriends(sub, (current) => ({ ...current, ...friends }));
  }

  /** Rename listed friends by user ID; IDs that are not friends are ignored. */
  renameFriends(sub: string, names: Record<string, string>) {
    this.#changeFriends(sub, (current) => Object.fromEntries(Object.entries(current)
      .map(([id, friend]) => [id, Object.hasOwn(names, id) ? { ...friend, name: names[id]! } : friend])));
  }

  removeFriend(sub: string, id: string) {
    this.#changeFriends(sub, (current) => Object.fromEntries(Object.entries(current).filter(([friendId]) => friendId !== id)));
  }

  /** Keep friends' pictures as AimHarder shows them now. */
  refreshFriendPhotos(sub: string, photos: Record<string, string>) {
    this.#changeFriends(sub, (current) => Object.fromEntries(Object.entries(current)
      .map(([id, friend]) => [id, Object.hasOwn(photos, id) ? { ...friend, photoUrl: photos[id]! } : friend])));
  }

  #changeFriends(sub: string, change: (current: Friends) => Friends) {
    this.#change(sub, (own, current) => ({ ...own, friends: change(current.friends) }));
  }

  #change(sub: string, change: (own: UserSettings, current: EditablePreferences) => UserSettings) {
    const scope = settingsScope(sub);
    const config = this.#configuration(sub);
    if (!scope || !config) return;
    const current = editable(config);
    const next = userSettingsSchema.parse(change(this.#userSettings(sub), current));
    const after = this.#configuration(sub, next);
    if (after && JSON.stringify(editable(after)) === JSON.stringify(current)) return;
    this.store.saveSettings(scope, next);
    this.#contexts.delete(sub);
  }

  #userSettings(sub: string): UserSettings {
    const scope = settingsScope(sub);
    return scope ? this.store.settings(scope, userSettingsSchema, {}) : {};
  }

  // The calendar feed: one secret link per account to its upcoming bookings, for calendar apps that cannot sign in.

  /** The account's calendar feed link, if it has one; the link itself is only shown when created. */
  calendarFeed(sub: string) { return this.generation(sub) === undefined ? undefined : this.store.calendarFeed(sub); }

  /** Create a new calendar feed link token for the account; any earlier link stops working. */
  createCalendarFeed(sub: string): string | undefined {
    return this.generation(sub) === undefined ? undefined : this.store.createCalendarFeed(sub);
  }

  revokeCalendarFeed(sub: string) { this.store.deleteCalendarFeed(sub); }

  /** The account a calendar feed link token belongs to, while the link is active and the account exists. */
  calendarFeedAccount(token: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const sub = this.store.calendarFeedAccount(token);
    return sub !== undefined && this.generation(sub) !== undefined ? sub : undefined;
  }

  /** Sign in with an AimHarder account: the owner's configured one, or a member's, verified with AimHarder. */
  async signIn(username: string, password: string): Promise<{ sub: string } | { error: SignInError }> {
    if (this.#isOwnerUsername(username)) return this.#isOwnerPassword(password) ? { sub: ownerSub } : { error: 'credentials' };
    const verified = await verifyAccount(username, password);
    if ('error' in verified) return { error: verified.error === 'no-gym' ? 'not-invited' : verified.error };
    const member = this.store.member(verified.accountId);
    if (!member) return { error: 'not-invited' };
    const stored = this.store.credentials(member.id);
    if (stored?.username !== username || stored.password !== password) {
      this.store.updateCredentials(member.id, { username, password });
      this.#contexts.delete(String(member.id));
    }
    return { sub: String(member.id) };
  }

  /** Accept an invitation with an AimHarder account. The link works once; joining again replaces older tokens. */
  async join(token: string, username: string, password: string): Promise<{ sub: string } | { error: JoinError }> {
    const invitation = this.store.invitation(token);
    if (!invitation) return { error: 'invitation' };
    if (this.#isOwnerUsername(username)) return { error: 'owner' };
    const verified = await verifyAccount(username, password);
    if ('error' in verified) return verified;
    if (!this.store.deleteInvitation(invitation.id)) return { error: 'invitation' };
    this.store.addMember(verified.accountId, invitation.label, { username, password });
    this.#contexts.delete(String(verified.accountId));
    return { sub: String(verified.accountId) };
  }

  removeMember(id: number) {
    this.store.removeMember(id);
    this.#contexts.delete(String(id));
  }

  #isOwnerUsername(username: string) {
    return username.trim().toLowerCase() === this.base.username.trim().toLowerCase();
  }

  #isOwnerPassword(password: string) {
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(password), digest(this.base.password));
  }
}

/** The preferences an account holder edits, as they apply in a configuration; a workout class of none is left out. */
function editable(config: Configuration): EditablePreferences {
  return {
    gym: config.gym, timeZone: config.timeZone, bookingWindowDays: config.bookingWindowDays, cancellationWindowMinutes: config.cancellationWindowMinutes,
    workoutClass: config.workoutClass ?? undefined, bookingPlan: [...config.bookingPlan ?? []],
    participantsFilter: config.participantsFilter ?? 'all', friends: { ...config.friends },
  };
}

const memberId = (sub: string) => (/^[1-9]\d{0,15}$/.test(sub) ? Number(sub) : undefined);
const settingsScope = (sub: string) => {
  if (sub === ownerSub) return ownerScope;
  const id = memberId(sub);
  return id === undefined ? undefined : memberScope(id);
};

/** Sign in to AimHarder once with these credentials and report the account ID; the account needs a gym. */
async function verifyAccount(username: string, password: string): Promise<{ accountId: number } | { error: 'credentials' | 'unavailable' | 'no-gym' }> {
  try {
    const { accountId } = await new AimHarderUpstream({ username, password }).account();
    return { accountId };
  } catch (error) {
    if (error instanceof AimHarderError && error.code === 'AUTHENTICATION_FAILED') return { error: 'credentials' };
    if (error instanceof AimHarderError && error.code === 'NO_ACCESSIBLE_GYMS') return { error: 'no-gym' };
    return { error: 'unavailable' };
  }
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { applySettings, gymSettingsSchema, userSettingsSchema, type BookingPlan, type Configuration, type Friends, type GymSettings, type ParticipantsFilterValue, type UserSettings } from './config.js';
import { AimHarderError } from './errors.js';
import { createContext, type Context } from './features/context.js';
import { memberScope, type Member, type Store } from './store.js';
import { AimHarderUpstream } from './upstream.js';

/** Subject of the owner, whose AimHarder account is configured in the environment. Members' subjects are their account IDs. */
export const ownerSub = 'owner';
const ownerScope = 'owner';
const gymScope = 'gym';

/** An account holder's own preferences as they apply now, to show and edit on the settings page. */
export interface EditablePreferences {
  defaultGym: string | undefined;
  workoutClasses: Record<string, string>;
  bookingPlans: Record<string, BookingPlan>;
  participantsFilter: ParticipantsFilterValue;
  friends: Friends;
}

export type SignInError = 'credentials' | 'not-invited' | 'unavailable';
export type JoinError = 'invitation' | 'credentials' | 'unavailable' | 'owner' | 'no-gym';

/**
 * The accounts a remote server serves: the owner, configured in the environment, and the members the owner invited.
 *
 * Each account gets its own context (AimHarder sessions and single-use previews), built from the environment, the gym
 * settings and its own settings. Members sign in with their AimHarder account: the server verifies it with AimHarder and
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

  #configuration(sub: string): Configuration | undefined {
    const gym = this.gymSettings();
    if (sub === ownerSub) return applySettings(this.base, gym, this.#userSettings(sub));
    const id = memberId(sub);
    const credentials = id === undefined ? undefined : this.store.credentials(id);
    if (!credentials) return undefined;
    // Members share the gym rules and the default workout class, never the owner's personal preferences or write policy.
    const base: Configuration = {
      ...this.base, ...credentials, defaultGym: undefined, bookingPlans: {}, friends: {}, participantsFilter: 'all', requireBookingConfirmation: true,
    };
    return applySettings(base, gym, this.#userSettings(sub));
  }

  gymSettings(): GymSettings { return this.store.settings(gymScope, gymSettingsSchema, {}); }

  /** The gym rules from the environment, which apply where the owner has not set one. */
  serverGymRules() {
    return { gymTimeZones: this.base.gymTimeZones, bookingWindowDays: this.base.bookingWindowDays ?? {}, cancellationWindowMinutes: this.base.cancellationWindowMinutes ?? {} };
  }

  saveGymSettings(settings: GymSettings) {
    this.store.saveSettings(gymScope, gymSettingsSchema.parse(settings));
    this.#contexts.clear();
  }

  /** The account holder's own preferences as they apply now: the environment's (for the owner) under their own settings. */
  preferences(sub: string): EditablePreferences | undefined {
    const config = this.#configuration(sub);
    if (!config) return undefined;
    return {
      defaultGym: config.defaultGym, workoutClasses: { ...config.workoutClasses }, bookingPlans: { ...config.bookingPlans },
      participantsFilter: config.participantsFilter ?? 'all', friends: { ...config.friends },
    };
  }

  /**
   * Change the account holder's own preferences. `change` receives them as they apply now and returns them changed.
   * Only what changed becomes the account's own settings: a gym's workout class or plan, the friends, the filter or the
   * default gym. Values left alone keep following the environment. Throws when a value is invalid; nothing is saved then.
   */
  updatePreferences(sub: string, change: (current: EditablePreferences) => EditablePreferences) {
    const scope = settingsScope(sub);
    const current = this.preferences(sub);
    if (!scope || !current) return;
    const next = change(structuredClone(current));
    const own = this.#userSettings(sub);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const perGym = <T>(stored: Record<string, T> | undefined, before: Record<string, T>, after: Record<string, T>) => {
      const result = { ...stored };
      for (const gymId of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (same(before[gymId], after[gymId])) continue;
        if (Object.hasOwn(after, gymId)) result[gymId] = after[gymId]!; else delete result[gymId];
      }
      return result;
    };
    const settings: UserSettings = userSettingsSchema.parse({
      ...own,
      workoutClasses: perGym(own.workoutClasses, current.workoutClasses, next.workoutClasses),
      bookingPlans: perGym(own.bookingPlans, current.bookingPlans, next.bookingPlans),
      ...(same(current.friends, next.friends) ? {} : { friends: next.friends }),
      ...(current.participantsFilter === next.participantsFilter ? {} : { participantsFilter: next.participantsFilter }),
      ...(current.defaultGym === next.defaultGym || next.defaultGym === undefined ? {} : { defaultGym: next.defaultGym }),
    });
    this.store.saveSettings(scope, settings);
    this.#contexts.delete(sub);
  }

  #userSettings(sub: string): UserSettings {
    const scope = settingsScope(sub);
    return scope ? this.store.settings(scope, userSettingsSchema, {}) : {};
  }

  /** Sign in with an AimHarder account: the owner's configured one, or a member's, verified with AimHarder. */
  async signIn(username: string, password: string): Promise<{ sub: string } | { error: SignInError }> {
    if (this.#isOwnerUsername(username)) return this.#isOwnerPassword(password) ? { sub: ownerSub } : { error: 'credentials' };
    const verified = await verifyAccount(this.#verificationBase(), username, password);
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
    const verified = await verifyAccount(this.#verificationBase(), username, password);
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

  /** The environment with the active gyms, to verify that an account belongs to one of them. */
  #verificationBase(): Configuration {
    const active = this.gymSettings().activeGyms;
    return active?.length ? { ...this.base, activeGyms: active } : this.base;
  }

  #isOwnerUsername(username: string) {
    return username.trim().toLowerCase() === this.base.username.trim().toLowerCase();
  }

  #isOwnerPassword(password: string) {
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(password), digest(this.base.password));
  }
}

const memberId = (sub: string) => (/^[1-9]\d{0,15}$/.test(sub) ? Number(sub) : undefined);
const settingsScope = (sub: string) => {
  if (sub === ownerSub) return ownerScope;
  const id = memberId(sub);
  return id === undefined ? undefined : memberScope(id);
};

/** Sign in to AimHarder once with these credentials and report the account ID; the account needs an active gym. */
async function verifyAccount(base: Configuration, username: string, password: string): Promise<{ accountId: number } | { error: 'credentials' | 'unavailable' | 'no-gym' }> {
  try {
    const { accountId } = await new AimHarderUpstream({ ...base, username, password, defaultGym: undefined }).account();
    return { accountId };
  } catch (error) {
    if (error instanceof AimHarderError && error.code === 'AUTHENTICATION_FAILED') return { error: 'credentials' };
    if (error instanceof AimHarderError && error.code === 'NO_ACCESSIBLE_GYMS') return { error: 'no-gym' };
    return { error: 'unavailable' };
  }
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { applySettings, gymSettingsSchema, userSettingsSchema, type Configuration, type GymSettings, type UserSettings } from './config.js';
import { AimHarderError } from './errors.js';
import { createContext, type Context } from './features/context.js';
import { memberScope, type Member, type Store } from './store.js';
import { AimHarderUpstream } from './upstream.js';

/** Subject of the owner, whose AimHarder account is configured in the environment. Members' subjects are their account IDs. */
export const ownerSub = 'owner';
const ownerScope = 'owner';
const gymScope = 'gym';

export type SignInError = 'credentials' | 'not-invited' | 'unavailable';
export type JoinError = 'invitation' | 'credentials' | 'unavailable' | 'owner';

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
    const config = this.configuration(sub);
    if (!config) return undefined;
    const context = createContext(config, this.settingsUrl);
    this.#contexts.set(sub, context);
    return context;
  }

  configuration(sub: string): Configuration | undefined {
    const gym = this.gymSettings();
    if (sub === ownerSub) return applySettings(this.base, gym, this.userSettings(sub));
    const id = memberId(sub);
    const credentials = id === undefined ? undefined : this.store.credentials(id);
    if (!credentials) return undefined;
    // Members share the gym rules and the default workout class, never the owner's personal preferences or write policy.
    const base: Configuration = {
      ...this.base, ...credentials, defaultGym: undefined, bookingPlans: {}, friends: {}, participantsFilter: 'all', requireBookingConfirmation: true,
    };
    return applySettings(base, gym, this.userSettings(sub));
  }

  gymSettings(): GymSettings { return this.store.settings(gymScope, gymSettingsSchema, {}); }

  saveGymSettings(settings: GymSettings) {
    this.store.saveSettings(gymScope, gymSettingsSchema.parse(settings));
    this.#contexts.clear();
  }

  userSettings(sub: string): UserSettings {
    const scope = settingsScope(sub);
    return scope ? this.store.settings(scope, userSettingsSchema, {}) : {};
  }

  saveUserSettings(sub: string, settings: UserSettings) {
    const scope = settingsScope(sub);
    if (!scope) return;
    this.store.saveSettings(scope, userSettingsSchema.parse(settings));
    this.#contexts.delete(sub);
  }

  /** Sign in with an AimHarder account: the owner's configured one, or a member's, verified with AimHarder. */
  async signIn(username: string, password: string): Promise<{ sub: string } | { error: SignInError }> {
    if (this.#isOwnerUsername(username)) return this.#isOwnerPassword(password) ? { sub: ownerSub } : { error: 'credentials' };
    const verified = await verifyAccount(this.base, username, password);
    if ('error' in verified) return verified;
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
    const verified = await verifyAccount(this.base, username, password);
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

const memberId = (sub: string) => (/^[1-9]\d{0,15}$/.test(sub) ? Number(sub) : undefined);
const settingsScope = (sub: string) => {
  if (sub === ownerSub) return ownerScope;
  const id = memberId(sub);
  return id === undefined ? undefined : memberScope(id);
};

/** Sign in to AimHarder once with these credentials and report the account ID. */
async function verifyAccount(base: Configuration, username: string, password: string): Promise<{ accountId: number } | { error: 'credentials' | 'unavailable' }> {
  try {
    const { accountId } = await new AimHarderUpstream({ ...base, username, password, defaultGym: undefined }).account();
    return { accountId };
  } catch (error) {
    return { error: error instanceof AimHarderError && error.code === 'AUTHENTICATION_FAILED' ? 'credentials' : 'unavailable' };
  }
}

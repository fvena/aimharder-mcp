import type { Configuration } from '../config.js';
import { AimHarderUpstream } from '../upstream.js';
import { preferencesOf, type Preferences } from '../preferences.js';
import { WriteActions } from './writes.js';

/** Everything a feature needs: AimHarder access, the account holder's preferences and their writes' single-use references. */
export interface Context {
  upstream: AimHarderUpstream;
  preferences: Preferences;
  writes: WriteActions;
  /** Where the account holder edits their preferences, on the remote server. */
  settingsUrl?: string;
}

export function createContext(config: Configuration, settingsUrl?: string): Context {
  const upstream = new AimHarderUpstream(config);
  const preferences = preferencesOf(config);
  return { upstream, preferences, writes: new WriteActions(upstream, preferences), ...(settingsUrl === undefined ? {} : { settingsUrl }) };
}

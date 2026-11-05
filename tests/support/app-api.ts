import { http, HttpResponse } from 'msw';

/** Simulated AimHarder mobile app API (see docs/aimharder-api.md). */
export const appBase = 'https://aimharder.com/aplic/apiExternal';
export const appToken = (userId = 42) => `${userId}|${Math.floor(Date.now() / 1000) + 90 * 86_400}|${'0'.repeat(32)}`;
/** App login; by default the account's only client box is `sample-gym` (box 200) with publisher 300. */
export const appLogin = (userId = 42, clientBoxes: { id: number; idrel: number; url: string; name: string }[] = [{ id: 200, idrel: 300, url: 'sample-gym', name: 'Sample Gym' }]) =>
  http.get(`${appBase}/login`, () => HttpResponse.json({ cookie: appToken(userId), userId, clientBoxes }));

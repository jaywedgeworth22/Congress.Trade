/**
 * src/shared/settings.ts
 * Global UI settings the admin controls for ALL visitors (not per-browser).
 *
 * Stored in CONFIG_KV (durable key/value; no migration needed). Reads fall back
 * to the default if the key is unset or KV is briefly unavailable, so serving
 * the dashboard never fails on a settings read.
 */

import type { Env } from './types';

export type LogoDisplay = 'tile' | 'transparent' | 'off';

export const LOGO_DISPLAYS: LogoDisplay[] = ['tile', 'transparent', 'off'];
/** Default logo style for the live feed: "Plain" (bare logos, no frame). */
export const DEFAULT_LOGO_DISPLAY: LogoDisplay = 'transparent';

const KV_LOGO_KEY = 'ui:logo_display';

/** Coerce arbitrary input to a valid LogoDisplay, defaulting to Plain. */
export function normalizeLogoDisplay(value: unknown): LogoDisplay {
  return LOGO_DISPLAYS.includes(value as LogoDisplay)
    ? (value as LogoDisplay)
    : DEFAULT_LOGO_DISPLAY;
}

/** Read the site-wide logo display style (admin-controlled). */
export async function getLogoDisplay(env: Env): Promise<LogoDisplay> {
  try {
    const v = await env.CONFIG_KV.get(KV_LOGO_KEY);
    return normalizeLogoDisplay(v);
  } catch {
    return DEFAULT_LOGO_DISPLAY;
  }
}

/** Persist the site-wide logo display style. Returns the normalized value. */
export async function setLogoDisplay(env: Env, value: unknown): Promise<LogoDisplay> {
  const val = normalizeLogoDisplay(value);
  await env.CONFIG_KV.put(KV_LOGO_KEY, val);
  return val;
}

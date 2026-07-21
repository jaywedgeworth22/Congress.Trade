import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { parseEmailAllowlist } from './access.ts';

export interface AdminRuntimeConfig {
  allow: Set<string>;
  accessAud?: string;
  accessTeamDomain?: string;
}

async function resolved(env: Env, key: keyof Env & string): Promise<string | undefined> {
  return (await resolveSecret(env, key)).value;
}

export async function adminRuntimeConfig(env: Env): Promise<AdminRuntimeConfig> {
  const [emails, accessAud, accessTeamDomain] = await Promise.all([
    resolved(env, 'ADMIN_EMAILS'),
    resolved(env, 'ACCESS_AUD'),
    resolved(env, 'ACCESS_TEAM_DOMAIN'),
  ]);
  return {
    allow: parseEmailAllowlist(emails),
    accessAud,
    accessTeamDomain,
  };
}

export async function isAdminSessionEmail(env: Env, email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const cfg = await adminRuntimeConfig(env);
  return cfg.allow.has(email.trim().toLowerCase());
}

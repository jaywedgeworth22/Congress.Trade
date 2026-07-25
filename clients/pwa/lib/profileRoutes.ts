export type ProfileType = 'politician' | 'asset';

export function profileHref(type: ProfileType, id: string): string {
  const parameter = type === 'politician' ? 'slug' : 'ticker';
  return `/${type}?${parameter}=${encodeURIComponent(id.trim())}`;
}

export function normalizeProfileQueryValue(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

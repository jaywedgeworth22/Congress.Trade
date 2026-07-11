const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
const CLIENT_PREFIX = '/api/client/v1';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function url(path: string) {
  return `${API_BASE}${CLIENT_PREFIX}${path}`;
}

async function parse<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status);
  return data;
}

export async function apiGet<T>(path: string): Promise<T> {
  return parse<T>(
    await fetch(url(path), {
      credentials: 'include',
      cache: 'no-store'
    })
  );
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return parse<T>(
    await fetch(url(path), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  );
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
const CLIENT_PREFIX = '/api/client/v1';

export class ApiError extends Error {
  readonly retryAfter: number | null;
  constructor(message: string, readonly status: number, retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.retryAfter = retryAfter;
  }
}

function url(path: string) {
  return `${API_BASE}${CLIENT_PREFIX}${path}`;
}

async function parse<T>(response: Response): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    const message = response.ok
      ? 'The Congress.Trade API returned an invalid response.'
      : `The Congress.Trade API is unavailable (HTTP ${response.status}).`;
    throw new ApiError(message, response.status);
  }

  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `HTTP ${response.status}`;
    
    let retryAfter = null;
    const retryHeader = response.headers.get('Retry-After');
    if (retryHeader) {
      const parsed = parseInt(retryHeader, 10);
      if (!Number.isNaN(parsed)) retryAfter = parsed;
    }
    throw new ApiError(message, response.status, retryAfter);
  }
  return data as T;
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

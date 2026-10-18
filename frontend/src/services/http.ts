/**
 * Thin wrapper around fetch for calling the Orbiz API.
 *
 * - Always sends the session cookie (credentials: 'include').
 * - Sends X-Requested-With on every request; the backend will require it on
 *   state-changing requests as part of CSRF protection (Phase 3).
 * - Turns the backend's { error: { code, message } } shape into an ApiError.
 */

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('X-Requested-With', 'CampusCart');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the Orbiz server.');
  }

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const body: unknown = isJson ? await response.json().catch(() => undefined) : undefined;

  if (!response.ok) {
    const error = (body as ErrorBody | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return body as T;
}

import { vi } from 'vitest';
import type { User } from '@/services/auth';

type Handler = (init: RequestInit) => { status: number; body?: unknown } | Promise<never>;

export function jsonResponse(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
}

/**
 * Replaces fetch with fake API responses keyed by "METHOD /path".
 * Unhandled requests fail loudly so tests never silently hit a real server.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${init.method ?? 'GET'} ${url.pathname.replace('/api/v1', '')}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`Unhandled API request in test: ${key}`);
    const { status, body } = await handler(init);
    return jsonResponse(status, body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'asha@example.com',
    emailVerified: true,
    displayName: 'Asha',
    avatarUrl: null,
    phone: null,
    roles: ['STUDENT'],
    signInMethod: 'GOOGLE',
    ...overrides,
  };
}

export const signedOut = () => ({
  status: 401,
  body: { error: { code: 'UNAUTHENTICATED', message: 'x' } },
});
export const signedInAs = (user: User) => () => ({ status: 200, body: { user } });

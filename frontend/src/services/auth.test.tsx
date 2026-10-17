import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeUser, mockApi, signedOut } from '@/test/api';
import { useCurrentUser, useDevLogin, useLogout } from './auth';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('switching users', () => {
  it('updates components that were already watching the current user, and drops the old user’s data', async () => {
    const dev = makeUser({ email: 'staff@example.com', signInMethod: 'DEV' });
    mockApi({
      'GET /auth/me': signedOut,
      'POST /auth/dev-login': () => ({ status: 200, body: { user: dev } }),
      'POST /auth/logout': () => ({ status: 204 }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['wallet'], { stale: 'from previous user' });

    // A long-lived watcher, like the real-time bridge mounted at the app root.
    const watcher = renderHook(() => useCurrentUser(), { wrapper: wrapper(client) });
    await waitFor(() => expect(watcher.result.current.data).toBeNull());

    const login = renderHook(() => useDevLogin(), { wrapper: wrapper(client) });
    await act(() => login.result.current.mutateAsync({ email: dev.email }));
    await waitFor(() => expect(watcher.result.current.data?.email).toBe('staff@example.com'));
    expect(client.getQueryData(['wallet'])).toBeUndefined();

    const logout = renderHook(() => useLogout(), { wrapper: wrapper(client) });
    await act(() => logout.result.current.mutateAsync());
    await waitFor(() => expect(watcher.result.current.data).toBeNull());
  });
});

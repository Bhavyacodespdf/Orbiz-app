import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, apiFetch } from './http';

export const roleSchema = z.enum(['STUDENT', 'MANAGER', 'POS', 'ADMIN']);
export type Role = z.infer<typeof roleSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  phone: z.string().nullable(),
  roles: z.array(roleSchema),
  signInMethod: z.enum(['GOOGLE', 'DEV']),
});
export type User = z.infer<typeof userSchema>;

const userResponse = z.object({ user: userSchema });
const providersSchema = z.object({ google: z.boolean(), devLogin: z.boolean() });

export const currentUserKey = ['auth', 'me'] as const;

/**
 * Drops every cached response that belonged to the previous user, but keeps
 * the current-user entry itself so components already watching it (like the
 * real-time connection) see the new value instead of a discarded entry.
 */
function switchUser(queryClient: ReturnType<typeof useQueryClient>, user: User | null) {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
  queryClient.setQueryData(currentUserKey, user);
}

/**
 * The signed-in user as reported by the server, or null when signed out.
 * Roles here only shape the UI; the backend enforces every permission.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: currentUserKey,
    queryFn: async (): Promise<User | null> => {
      try {
        return userResponse.parse(await apiFetch('/auth/me')).user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
  });
}

export function useAuthProviders() {
  return useQuery({
    queryKey: ['auth', 'providers'],
    queryFn: async () => providersSchema.parse(await apiFetch('/auth/providers')),
    staleTime: Infinity,
  });
}

/** URL that starts the real Google sign-in. A full page navigation, not fetch. */
export function googleSignInUrl(returnTo: string): string {
  return `/api/v1/auth/google?returnTo=${encodeURIComponent(returnTo)}`;
}

export function useDevLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; displayName?: string }) =>
      userResponse.parse(
        await apiFetch('/auth/dev-login', { method: 'POST', body: JSON.stringify(input) }),
      ).user,
    onSuccess: (user) => switchUser(queryClient, user),
  });
}

/**
 * Ends the session and forgets the user. Callers on protected pages should
 * navigate to a public page first; otherwise the page's guard redirects to
 * the login page the moment the user disappears.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => switchUser(queryClient, null),
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { displayName?: string; phone?: string | null }) =>
      userResponse.parse(
        await apiFetch('/me/profile', { method: 'PATCH', body: JSON.stringify(input) }),
      ).user,
    onSuccess: (user) => queryClient.setQueryData(currentUserKey, user),
  });
}

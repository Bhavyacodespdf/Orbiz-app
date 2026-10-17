import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/services/http';

/**
 * Retry only failures that might succeed on a second try (network errors,
 * 5xx). A 4xx — not found, not allowed, invalid — will not change on retry.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: shouldRetry },
    },
  });
}

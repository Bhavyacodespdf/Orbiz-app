import { describe, expect, it } from 'vitest';
import { ApiError } from '@/services/http';
import { shouldRetry } from './query-client';

describe('shouldRetry', () => {
  it('never retries client errors such as 404', () => {
    expect(shouldRetry(0, new ApiError(404, 'NOT_FOUND', 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(403, 'FORBIDDEN', 'x'))).toBe(false);
  });

  it('retries network and server errors once', () => {
    expect(shouldRetry(0, new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(true);
    expect(shouldRetry(0, new ApiError(503, 'HTTP_ERROR', 'x'))).toBe(true);
    expect(shouldRetry(1, new ApiError(503, 'HTTP_ERROR', 'x'))).toBe(false);
  });
});

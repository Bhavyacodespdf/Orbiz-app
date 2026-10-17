import { ApiError } from '@/services/http';

/** Turns any thrown value into a message that is safe and useful to show. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK_ERROR' || error.status === 502 || error.status === 504) {
      return 'Cannot reach CampusCart right now. Check your connection and try again.';
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/services/http';

const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.object({ status: z.enum(['up', 'down']), latencyMs: z.number().optional() }),
  time: z.string(),
});

export type Health = z.infer<typeof healthSchema>;

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async (): Promise<Health> => {
      try {
        return healthSchema.parse(await apiFetch<unknown>('/health'));
      } catch (error) {
        // The backend answers 503 when it is running but cannot reach PostgreSQL.
        if (error instanceof ApiError && error.status === 503) {
          return {
            status: 'degraded',
            database: { status: 'down' },
            time: new Date().toISOString(),
          };
        }
        throw error;
      }
    },
    retry: false,
  });
}

import { CircleCheck, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { ApiError } from '@/services/http';
import { useHealth } from './health';

/** Shows the real result of GET /api/v1/health — nothing here is simulated. */
export function SystemStatus() {
  const { data, error, isPending, isFetching, refetch } = useHealth();

  let icon = <LoaderCircle className="size-5 animate-spin" aria-hidden />;
  let label = 'Checking the server…';
  let tone = 'text-espresso-500';

  if (!isPending && data?.status === 'ok') {
    icon = <CircleCheck className="size-5" aria-hidden />;
    label = `API and database are up (${data.database.latencyMs ?? '?'} ms)`;
    tone = 'text-success-600';
  } else if (!isPending && (error || data?.status === 'degraded')) {
    icon = <CircleAlert className="size-5" aria-hidden />;
    label =
      data?.status === 'degraded'
        ? 'API is up, but the database is unreachable'
        : error instanceof ApiError &&
            // 502/504 come from the dev proxy when the backend is not running.
            (error.code === 'NETWORK_ERROR' || error.status === 502 || error.status === 504)
          ? 'Cannot reach the API server'
          : 'Health check failed';
    tone = 'text-chili-600';
  }

  return (
    <div className="flex flex-wrap items-center gap-3" role="status" aria-live="polite">
      <span className={`flex items-center gap-2 font-medium ${tone}`}>
        {icon}
        {label}
      </span>
      <button
        type="button"
        onClick={() => void refetch()}
        disabled={isFetching}
        className="inline-flex items-center gap-1.5 rounded-md border border-espresso-200 px-3 py-1.5 text-sm hover:bg-espresso-50 disabled:opacity-50"
      >
        <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} aria-hidden />
        Check again
      </button>
    </div>
  );
}

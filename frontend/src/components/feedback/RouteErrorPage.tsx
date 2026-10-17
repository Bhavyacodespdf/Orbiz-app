import { isRouteErrorResponse, useRouteError } from 'react-router';
import { ErrorState } from './ErrorState';
import { NotFoundPage } from './NotFoundPage';

/** Catches errors thrown while rendering a route so the whole app doesn't go blank. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4">
      <ErrorState
        title="This page crashed"
        error={error}
        onRetry={() => window.location.reload()}
      />
    </main>
  );
}

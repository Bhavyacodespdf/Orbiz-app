import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ToastProvider } from '@/components/feedback/ToastProvider';
import { routes } from '@/app/router';

function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Renders a component with a fresh, non-retrying query client and toasts. */
export function renderWithQuery(ui: ReactElement) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

/** Renders the real application routes at the given path. */
export function renderRoute(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return { router, ...renderWithQuery(<RouterProvider router={router} />) };
}

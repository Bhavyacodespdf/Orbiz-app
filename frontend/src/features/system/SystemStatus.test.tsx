import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQuery } from '@/test/render';
import { SystemStatus } from './SystemStatus';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<SystemStatus />', () => {
  it('shows a loading state, then the healthy result returned by the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          status: 'ok',
          database: { status: 'up', latencyMs: 3 },
          time: '2026-10-16T00:00:00.000Z',
        }),
      ),
    );
    renderWithQuery(<SystemStatus />);

    expect(screen.getByText('Checking the server…')).toBeInTheDocument();
    expect(await screen.findByText('API and database are up (3 ms)')).toBeInTheDocument();
  });

  it('reports a degraded database honestly', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(503, { status: 'degraded', database: { status: 'down' }, time: 'x' }),
        ),
    );
    renderWithQuery(<SystemStatus />);
    expect(
      await screen.findByText('API is up, but the database is unreachable'),
    ).toBeInTheDocument();
  });

  it('reports an unreachable API and lets the user retry', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: 'ok', database: { status: 'up', latencyMs: 1 }, time: 'x' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    renderWithQuery(<SystemStatus />);

    expect(await screen.findByText('Cannot reach the API server')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText('API and database are up (1 ms)')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

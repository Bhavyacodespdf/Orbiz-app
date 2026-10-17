import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from './http';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('sends cookies and the CSRF marker header to the versioned API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/health')).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/health');
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('X-Requested-With')).toBe('CampusCart');
  });

  it('converts the backend error shape into an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Nope' } })),
    );

    const error = await apiFetch('/missing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Nope' });
  });

  it('reports network failures as NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiFetch('/health')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

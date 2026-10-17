import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { connectRealtime, handleOrderEvent, useRealtimeStatus } from './realtime';
import { renderHook } from '@testing-library/react';
import { makeOrder } from '@/test/commerce';

/** Minimal stand-in for a socket.io-client Socket. */
function fakeSocket() {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const on = (event: string, fn: (...args: unknown[]) => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), fn]);
  };
  const socket = {
    active: true,
    on,
    io: { on, removeAllListeners: vi.fn() },
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
    fire(event: string, payload?: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(payload);
    },
  };
  return socket;
}

function setup() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const socket = fakeSocket();
  const stop = connectRealtime(queryClient, () => socket as unknown as Socket);
  const status = renderHook(() => useRealtimeStatus());
  return { queryClient, invalidate, socket, stop, status };
}

function keysOf(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));
}

describe('realtime client', () => {
  it('reports honest connection states and refetches everything once the server has put us in our rooms', () => {
    const { socket, invalidate, status, stop } = setup();
    expect(status.result.current).toBe('connecting');
    socket.fire('ready');
    status.rerender();
    expect(status.result.current).toBe('live');
    expect(keysOf(invalidate)).toEqual(
      expect.arrayContaining(['["orders"]', '["wallet"]', '["cart"]']),
    );

    socket.fire('disconnect');
    status.rerender();
    expect(status.result.current).toBe('connecting'); // still trying to reconnect
    socket.active = false;
    socket.fire('disconnect');
    status.rerender();
    expect(status.result.current).toBe('offline');

    stop();
    status.rerender();
    expect(status.result.current).toBe('unavailable');
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('refetches the wallet on wallet events and re-checks the session when it is revoked', () => {
    const { socket, invalidate, stop } = setup();
    socket.fire('wallet.updated', { reason: 'REFUND' });
    socket.fire('session.revoked', {});
    expect(keysOf(invalidate)).toEqual(['["wallet"]', '["auth","me"]']);
    stop();
  });
});

describe('handleOrderEvent', () => {
  it('ignores a stale or duplicate event for an order we already hold at that version', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['orders', 'ord1'], makeOrder({ version: 3 }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    handleOrderEvent(queryClient, {
      orderId: 'ord1',
      outletId: 'o1',
      status: 'ACCEPTED',
      version: 3,
    });
    expect(keysOf(invalidate)).not.toContain('["orders","ord1"]');
  });

  it('refetches the order, the lists and the staff queue for a newer version', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['orders', 'ord1'], makeOrder({ version: 1 }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    handleOrderEvent(queryClient, {
      orderId: 'ord1',
      outletId: 'o1',
      status: 'ACCEPTED',
      version: 2,
    });
    expect(keysOf(invalidate)).toEqual([
      '["orders","ord1"]',
      '["orders","list"]',
      '["staff","orders","o1"]',
    ]);
  });
});

describe('reconnecting (e.g. after signing in as someone else)', () => {
  it('ignores state changes from a previous connection that is still closing', () => {
    const queryClient = new QueryClient();
    const old = fakeSocket();
    const stopOld = connectRealtime(queryClient, () => old as unknown as Socket);
    const fresh = fakeSocket();
    const stopFresh = connectRealtime(queryClient, () => fresh as unknown as Socket);
    const status = renderHook(() => useRealtimeStatus());

    fresh.fire('ready');
    status.rerender();
    expect(status.result.current).toBe('live');

    // The old connection finishes closing after the new one is live.
    old.active = false;
    old.fire('disconnect');
    old.fire('ready');
    stopOld();
    status.rerender();
    expect(status.result.current).toBe('live');

    stopFresh();
    status.rerender();
    expect(status.result.current).toBe('unavailable');
  });
});

describe('poll events', () => {
  it('re-reads the outlet’s polls on any change, and the specials once a poll is final', () => {
    const { socket, invalidate, stop } = setup();
    socket.fire('poll.updated', { pollId: 'p1', outletId: 'o1', status: 'OPEN', version: 2 });
    expect(keysOf(invalidate)).toEqual(['["polls","staff","o1"]', '["polls","outlet"]']);

    invalidate.mockClear();
    socket.fire('poll.updated', { pollId: 'p1', outletId: 'o1', status: 'FINALIZED', version: 4 });
    expect(keysOf(invalidate)).toEqual([
      '["polls","staff","o1"]',
      '["polls","outlet"]',
      '["specials"]',
    ]);
    stop();
  });

  it('refetches polls and specials after (re)connecting', () => {
    const { socket, invalidate, stop } = setup();
    socket.fire('ready');
    expect(keysOf(invalidate)).toEqual(expect.arrayContaining(['["polls"]', '["specials"]']));
    stop();
  });
});

describe('stock events', () => {
  it('re-reads menus, staff stock, the stock planner, the cart, specials and polls', () => {
    const { socket, invalidate, stop } = setup();
    socket.fire('stock.updated', { outletId: 'o1', menuItemIds: ['i1'] });
    expect(keysOf(invalidate)).toEqual([
      '["outlets"]',
      '["staff","inventory","o1"]',
      '["staff","planning","o1"]',
      '["staff","menu","o1"]',
      '["cart"]',
      '["specials"]',
      '["polls"]',
    ]);
    stop();
  });
});

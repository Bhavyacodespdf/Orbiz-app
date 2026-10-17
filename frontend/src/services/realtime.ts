import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { currentUserKey, useCurrentUser } from './auth';
import { walletKey } from './wallet';
import { cartKey } from './cart';
import type { Order } from './orders';
import { managerPollsKey, specialsKey } from './polls';

/**
 * Live notifications from the server. Events only say "something changed";
 * the app then re-reads the real data over REST. On every (re)connect we
 * refetch everything that could have changed while we weren't listening.
 */

export type RealtimeState = 'live' | 'connecting' | 'offline' | 'unavailable';

let state: RealtimeState = 'unavailable';
const listeners = new Set<() => void>();
function setState(next: RealtimeState) {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

export function useRealtimeStatus(): RealtimeState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

interface OrderEvent {
  orderId: string;
  outletId: string;
  status: string;
  version: number;
}

type OrderCreatedListener = (event: OrderEvent & { pickupCode: string }) => void;
const orderCreatedListeners = new Set<OrderCreatedListener>();

/** Lets staff screens react to new orders (e.g. an on-screen alert). Returns an unsubscribe function. */
export function onOrderCreated(listener: OrderCreatedListener): () => void {
  orderCreatedListeners.add(listener);
  return () => orderCreatedListeners.delete(listener);
}

/** Sent to the order's owner when it is ready for pickup. Carries no pickup code. */
export interface OrderReadyEvent {
  orderId: string;
  pickupCode: string;
  outletName: string;
}
type OrderReadyListener = (event: OrderReadyEvent) => void;
const orderReadyListeners = new Set<OrderReadyListener>();

/** Lets the student app announce "your order is ready". Returns an unsubscribe function. */
export function onOrderReady(listener: OrderReadyListener): () => void {
  orderReadyListeners.add(listener);
  return () => orderReadyListeners.delete(listener);
}

function refetchEverything(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  void queryClient.invalidateQueries({ queryKey: ['orders'] });
  void queryClient.invalidateQueries({ queryKey: ['staff'] });
  void queryClient.invalidateQueries({ queryKey: walletKey });
  void queryClient.invalidateQueries({ queryKey: cartKey });
  void queryClient.invalidateQueries({ queryKey: ['polls'] });
  void queryClient.invalidateQueries({ queryKey: specialsKey });
}

export interface StockEvent {
  outletId: string;
  menuItemIds: string[];
}

/**
 * Stock or availability changed at an outlet. Re-read everything that shows it: menus,
 * staff stock and menu screens, the cart, specials, polls and Surprise Meal combos are
 * re-checked by the server whenever they're used.
 */
export function handleStockEvent(queryClient: QueryClient, event: StockEvent) {
  void queryClient.invalidateQueries({ queryKey: ['outlets'] });
  void queryClient.invalidateQueries({ queryKey: ['staff', 'inventory', event.outletId] });
  void queryClient.invalidateQueries({ queryKey: ['staff', 'planning', event.outletId] });
  void queryClient.invalidateQueries({ queryKey: ['staff', 'menu', event.outletId] });
  void queryClient.invalidateQueries({ queryKey: cartKey });
  void queryClient.invalidateQueries({ queryKey: specialsKey });
  void queryClient.invalidateQueries({ queryKey: ['polls'] });
}

export interface PollEvent {
  pollId: string;
  outletId: string;
  status: string;
  version: number;
}

/**
 * A poll changed. Re-read the outlet's manager list and any student poll view (the
 * event carries an outlet ID, not a slug, so all of them), plus specials once final.
 */
export function handlePollEvent(queryClient: QueryClient, event: PollEvent) {
  void queryClient.invalidateQueries({ queryKey: managerPollsKey(event.outletId) });
  void queryClient.invalidateQueries({ queryKey: ['polls', 'outlet'] });
  if (event.status === 'FINALIZED') void queryClient.invalidateQueries({ queryKey: specialsKey });
}

/** Applies an order event, ignoring it if we already hold that version or a newer one. */
export function handleOrderEvent(queryClient: QueryClient, event: OrderEvent) {
  const cached = queryClient.getQueryData<Order>(['orders', event.orderId]);
  if (!cached || cached.version < event.version) {
    void queryClient.invalidateQueries({ queryKey: ['orders', event.orderId], exact: true });
  }
  void queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
  void queryClient.invalidateQueries({ queryKey: ['staff', 'orders', event.outletId] });
}

/** Increases with every connection, so events from an old, closing connection can be ignored. */
let currentConnection = 0;

export function connectRealtime(
  queryClient: QueryClient,
  // forceNew: never share a connection manager with a previous (closing) connection.
  createSocket: () => Socket = () =>
    io({ path: '/socket.io', withCredentials: true, forceNew: true }),
) {
  const connection = ++currentConnection;
  const isCurrent = () => connection === currentConnection;
  const setOwnState = (next: RealtimeState) => {
    if (isCurrent()) setState(next);
  };
  const socket = createSocket();
  setState('connecting');

  // 'ready' means the server has put us in our rooms; anything earlier may have been missed.
  socket.on('ready', () => {
    if (!isCurrent()) return;
    setState('live');
    refetchEverything(queryClient);
  });
  socket.on('disconnect', () => setOwnState(socket.active ? 'connecting' : 'offline'));
  socket.on('connect_error', () => setOwnState(socket.active ? 'connecting' : 'offline'));
  socket.io.on('reconnect_attempt', () => setOwnState('connecting'));

  socket.on('order.created', (event: OrderEvent & { pickupCode: string }) => {
    handleOrderEvent(queryClient, event);
    for (const listener of orderCreatedListeners) listener(event);
  });
  socket.on('access.changed', () => {
    // Our outlet assignments or roles changed: reload who we are and where we work.
    void queryClient.invalidateQueries({ queryKey: currentUserKey });
    void queryClient.invalidateQueries({ queryKey: ['staff'] });
  });
  socket.on('order.updated', (event: OrderEvent) => handleOrderEvent(queryClient, event));
  // Inbox and estimates are re-read from the API; events carry IDs only.
  socket.on('notification.created', () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  });
  socket.on('estimate.updated', (event: { orderId: string; outletId: string }) => {
    void queryClient.invalidateQueries({ queryKey: ['orders', event.orderId, 'tracking'] });
    void queryClient.invalidateQueries({ queryKey: ['staff', 'orders', event.outletId] });
  });
  socket.on('order.ready', (event: OrderReadyEvent) => {
    void queryClient.invalidateQueries({ queryKey: ['orders', event.orderId, 'pickup'] });
    for (const listener of orderReadyListeners) listener(event);
  });
  socket.on('poll.updated', (event: PollEvent) => handlePollEvent(queryClient, event));
  socket.on('stock.updated', (event: StockEvent) => handleStockEvent(queryClient, event));
  // A group, split or banquet changed: re-read the lists and details (the event carries IDs only).
  socket.on('social.updated', () => {
    void queryClient.invalidateQueries({ queryKey: ['groups'] });
    void queryClient.invalidateQueries({ queryKey: ['splits'] });
    void queryClient.invalidateQueries({ queryKey: ['banquets'] });
    void queryClient.invalidateQueries({ queryKey: ['staff', 'banquets'] });
  });
  socket.on('wallet.updated', () => {
    void queryClient.invalidateQueries({ queryKey: walletKey });
  });
  socket.on('session.revoked', () => {
    // Our session ended (logout elsewhere, role change): re-check who we are.
    void queryClient.invalidateQueries({ queryKey: currentUserKey });
  });

  return () => {
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
    setOwnState('unavailable');
  };
}

/** Keeps one live connection open while someone is signed in. Rendered once near the app root. */
export function RealtimeBridge() {
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    return connectRealtime(queryClient);
  }, [queryClient, userId]);
  return null;
}

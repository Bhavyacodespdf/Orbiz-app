import type { StaffOrder, StaffOrderSummary } from '@/services/staff';
import { makeOrder } from './commerce';

export const outletRow = (
  roles: ('MANAGER' | 'POS')[] = ['MANAGER'],
  overrides: Record<string, unknown> = {},
) => ({
  outlet: {
    id: 'o1',
    slug: 'night-owl-cafe',
    name: 'Night Owl Café',
    description: '',
    location: 'Library block',
    imageUrl: null,
    status: 'OPEN',
    acceptingOrders: true,
    isSample: false,
    ...overrides,
  },
  roles,
});

export function staffSummary(overrides: Partial<StaffOrderSummary> = {}): StaffOrderSummary {
  return {
    id: 'ord1',
    pickupCode: 'N-007',
    outlet: { id: 'o1', slug: 'night-owl-cafe', name: 'Night Owl Café' },
    status: 'PLACED',
    paymentMethod: 'COUNTER',
    paymentStatus: 'PENDING_COUNTER',
    timing: 'IMMEDIATE',
    scheduledFor: null,
    scheduledFeePaise: 0,
    pickupDeadline: null,
    totalPaise: 4000,
    itemCount: 2,
    placedAt: new Date().toISOString(),
    version: 1,
    customer: { displayName: 'Asha' },
    estimate: null,
    ...overrides,
  };
}

export function staffDetail(overrides: Partial<StaffOrder> = {}): StaffOrder {
  return {
    ...makeOrder({ paymentMethod: 'COUNTER', paymentStatus: 'PENDING_COUNTER' }),
    customer: { displayName: 'Asha' },
    counterPayment: null,
    allowedNextStatuses: ['ACCEPTED', 'REJECTED'],
    canRecordPayment: false,
    ...overrides,
  };
}

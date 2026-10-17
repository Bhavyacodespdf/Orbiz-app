import type { Cart } from '@/services/cart';
import type { Wallet, WalletTransaction } from '@/services/wallet';
import type { Order } from '@/services/orders';

export function makeCart(overrides: Partial<Cart> = {}): Cart {
  const items = overrides.items ?? [
    {
      menuItemId: 'i1',
      name: 'Masala chai',
      dietary: 'VEG' as const,
      unitPricePaise: 2000,
      quantity: 2,
      lineTotalPaise: 4000,
      isOrderable: true,
      stockStatus: 'AVAILABLE' as const,
    },
  ];
  const total = items.reduce((s, i) => s + i.lineTotalPaise, 0);
  return {
    outlet: {
      id: 'o1',
      slug: 'night-owl-cafe',
      name: 'Night Owl Café',
      status: 'OPEN',
      acceptingOrders: true,
    },
    items,
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
    subtotalPaise: total,
    totalPaise: total,
    issues: [],
    canCheckout: true,
    canSchedule: true,
    loyalty: { availablePoints: 0, maxRedeemablePoints: 0, pointValuePaise: 100 },
    ...overrides,
  };
}

export const emptyCart = (): Cart => ({
  outlet: null,
  items: [],
  itemCount: 0,
  subtotalPaise: 0,
  totalPaise: 0,
  issues: [],
  canCheckout: false,
  canSchedule: false,
  loyalty: { availablePoints: 0, maxRedeemablePoints: 0, pointValuePaise: 100 },
});

/** The server's recharge bonus slabs, as GET /wallet reports them. */
export const BONUS_SLABS = [
  { amountPaise: 50000, points: 10 },
  { amountPaise: 100000, points: 25 },
  { amountPaise: 130000, points: 30 },
  { amountPaise: 150000, points: 40 },
];

export function makeWallet(balancePaise = 0, available = true, pointsBalance = 0): Wallet {
  return {
    id: 'w1',
    balancePaise,
    currency: 'INR',
    loyalty: { pointsBalance, pointValuePaise: 100, rechargeBonusSlabs: BONUS_SLABS },
    recharge: {
      available,
      mode: available ? 'MOCK' : null,
      isSimulated: available,
      minPaise: 9900,
      maxPaise: 200000,
      maxBalancePaise: 500000,
    },
  };
}

export function makeTransaction(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    id: 't1',
    type: 'RECHARGE',
    direction: 'CREDIT',
    amountPaise: 50000,
    balanceAfterPaise: 50000,
    status: 'COMPLETED',
    description: 'Wallet recharge (simulated — test mode)',
    orderId: null,
    rechargeId: 'r1',
    isSimulated: true,
    createdAt: '2026-10-16T08:00:00.000Z',
    completedAt: '2026-10-16T08:00:05.000Z',
    ...overrides,
  };
}

export function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord1',
    pickupCode: 'N-007',
    outlet: { id: 'o1', slug: 'night-owl-cafe', name: 'Night Owl Café', location: 'Library block' },
    status: 'PLACED',
    paymentMethod: 'WALLET',
    paymentStatus: 'PAID',
    items: [
      {
        menuItemId: 'i1',
        name: 'Masala chai',
        unitPricePaise: 2000,
        quantity: 2,
        lineTotalPaise: 4000,
        fulfillmentType: null,
        unsuitableForResale: false,
        noShow: null,
      },
    ],
    subtotalPaise: 4000,
    pointsRedeemed: 0,
    pointsDiscountPaise: 0,
    timing: 'IMMEDIATE',
    scheduledFor: null,
    scheduledFeePaise: 0,
    totalPaise: 4000,
    refundPaise: 4000,
    pickupDeadline: null,
    noShow: null,
    currency: 'INR',
    cancelReason: null,
    version: 1,
    placedAt: '2026-10-16T08:00:00.000Z',
    updatedAt: '2026-10-16T08:00:00.000Z',
    statusHistory: [
      { fromStatus: null, toStatus: 'PLACED', reason: null, at: '2026-10-16T08:00:00.000Z' },
    ],
    ...overrides,
  };
}

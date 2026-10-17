import type { MenuItem, Outlet } from '@/services/outlets';

export function makeOutlet(overrides: Partial<Outlet> = {}): Outlet {
  return {
    id: 'o1',
    slug: 'night-owl-cafe',
    name: 'Night Owl Café',
    description: 'Late-night chai.',
    location: 'Library block',
    imageUrl: null,
    status: 'OPEN',
    acceptingOrders: true,
    isSample: false,
    ...overrides,
  };
}

export function makeMenuItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: 'i1',
    categoryId: 'c1',
    name: 'Masala chai',
    description: 'Ginger, cardamom.',
    pricePaise: 2000,
    dietary: 'VEG',
    isAvailable: true,
    stockStatus: overrides.isAvailable === false ? 'SOLD_OUT' : 'AVAILABLE',
    imageUrl: null,
    rating: { average: null, count: 0 },
    ...overrides,
  };
}

import { createBrowserRouter, type RouteObject } from 'react-router';
import { StudentLayout } from '@/components/layout/StudentLayout';
import { ManagerLayout } from '@/components/layout/ManagerLayout';
import { PosLayout } from '@/components/layout/PosLayout';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { NotFoundPage } from '@/components/feedback/NotFoundPage';
import { RouteErrorPage } from '@/components/feedback/RouteErrorPage';
import { HomePage } from '@/features/discovery/HomePage';
import { OutletPage } from '@/features/menu/OutletPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
import { WalletPage } from '@/features/wallet/WalletPage';
import { CartPage } from '@/features/cart/CartPage';
import { CheckoutPage } from '@/features/checkout/CheckoutPage';
import { OrderPage } from '@/features/orders/OrderPage';
import { ProfilePage } from '@/features/profile/ProfilePage';
import { SurpriseMealPage } from '@/features/surprise/SurpriseMealPage';
import { ManagerOrdersPage } from '@/features/manager/ManagerOrdersPage';
import { ManagerMenuPage } from '@/features/manager/ManagerMenuPage';
import { ManagerOutletPage } from '@/features/manager/ManagerOutletPage';
import { ManagerSpecialsPage } from '@/features/manager/ManagerSpecialsPage';
import { ManagerInventoryPage, PosStockPage } from '@/features/inventory/InventoryPage';
import { ManagerStockPlannerPage, PosStockPlannerPage } from '@/features/planning/StockPlannerPage';
import { GroupsPage } from '@/features/groups/GroupsPage';
import { GroupTrayPage, JoinGroupRoute } from '@/features/groups/GroupTrayPage';
import { PlanEventPage } from '@/features/groups/PlanEventPage';
import { EventPassPage } from '@/features/groups/EventPassPage';
import { ManagerBanquetsPage, PosBanquetsPage } from '@/features/banquets/BanquetDeskPage';
import { PosHistoryPage, PosQueuePage } from '@/features/pos/PosPages';
import { AdminUsersPage } from '@/features/admin/AdminUsersPage';
import { AdminOutletsPage } from '@/features/admin/AdminOutletsPage';
import { AdminAuditPage } from '@/features/admin/AdminAuditPage';
import { AdminNoShowsPage } from '@/features/admin/AdminNoShowsPage';
import { DesignPage } from '@/features/dev/DesignPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { MenuItemPage } from '@/features/reviews/MenuItemPage';
import { MenuPage } from '@/features/menu/MenuPage';
import { MyReviewsPage } from '@/features/reviews/MyReviewsPage';
import { ManagerReviewsPage } from '@/features/manager/ManagerReviewsPage';
import { ManagerKitchenPage } from '@/features/kitchen/ManagerKitchenPage';
import { RequireAuth, RequireRole } from '@/features/auth/guards';

// Route guards decide what the browser shows. They are not the security
// boundary: every API endpoint enforces sign-in and roles on the server.
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <StudentLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'menu', element: <MenuPage /> },
      { path: 'outlets/:slug', element: <OutletPage /> },
      { path: 'outlets/:slug/items/:itemId', element: <MenuItemPage /> },
      // Browsing outlets is open to everyone; everything personal needs sign-in.
      {
        path: 'orders',
        element: (
          <RequireAuth>
            <OrdersPage />
          </RequireAuth>
        ),
      },
      ...[
        { path: 'groups', element: <GroupsPage /> },
        { path: 'groups/tray/:groupId', element: <GroupTrayPage /> },
        { path: 'groups/join/:code', element: <JoinGroupRoute /> },
        { path: 'groups/banquets/new', element: <PlanEventPage /> },
        { path: 'groups/banquets/:bookingId/pass', element: <EventPassPage /> },
        { path: 'reviews', element: <MyReviewsPage /> },
      ].map((r) => ({ path: r.path, element: <RequireAuth>{r.element}</RequireAuth> })),
      {
        path: 'wallet',
        element: (
          <RequireAuth>
            <WalletPage />
          </RequireAuth>
        ),
      },
      {
        path: 'surprise',
        element: (
          <RequireAuth>
            <SurpriseMealPage />
          </RequireAuth>
        ),
      },
      {
        path: 'cart',
        element: (
          <RequireAuth>
            <CartPage />
          </RequireAuth>
        ),
      },
      {
        path: 'checkout',
        element: (
          <RequireAuth>
            <CheckoutPage />
          </RequireAuth>
        ),
      },
      {
        path: 'orders/:orderId',
        element: (
          <RequireAuth>
            <OrderPage />
          </RequireAuth>
        ),
      },
      {
        path: 'profile',
        element: (
          <RequireAuth>
            <ProfilePage />
          </RequireAuth>
        ),
      },
    ],
  },
  {
    path: '/manage',
    element: (
      <RequireRole roles={['MANAGER']}>
        <ManagerLayout />
      </RequireRole>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <ManagerOrdersPage /> },
      { path: 'menu', element: <ManagerMenuPage /> },
      { path: 'stock', element: <ManagerInventoryPage /> },
      { path: 'planner', element: <ManagerStockPlannerPage /> },
      { path: 'banquets', element: <ManagerBanquetsPage /> },
      { path: 'outlet', element: <ManagerOutletPage /> },
      { path: 'specials', element: <ManagerSpecialsPage /> },
      { path: 'reviews', element: <ManagerReviewsPage /> },
      { path: 'kitchen', element: <ManagerKitchenPage /> },
    ],
  },
  {
    path: '/pos',
    element: (
      <RequireRole roles={['POS']}>
        <PosLayout />
      </RequireRole>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <PosQueuePage /> },
      { path: 'history', element: <PosHistoryPage /> },
      { path: 'stock', element: <PosStockPage /> },
      { path: 'planner', element: <PosStockPlannerPage /> },
      { path: 'banquets', element: <PosBanquetsPage /> },
    ],
  },
  {
    path: '/admin',
    element: (
      <RequireRole roles={['ADMIN']}>
        <AdminLayout />
      </RequireRole>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <AdminUsersPage /> },
      { path: 'outlets', element: <AdminOutletsPage /> },
      { path: 'audit', element: <AdminAuditPage /> },
      { path: 'no-shows', element: <AdminNoShowsPage /> },
    ],
  },
  { path: '/login', element: <LoginPage />, errorElement: <RouteErrorPage /> },
  // The design reference is only included in development builds.
  ...(import.meta.env.DEV ? [{ path: '/design', element: <DesignPage /> }] : []),
  { path: '*', element: <NotFoundPage /> },
];

export const router = createBrowserRouter(routes);

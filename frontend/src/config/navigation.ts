import type { LucideIcon } from 'lucide-react';
import {
  ChefHat,
  ClipboardList,
  History,
  Home,
  ListOrdered,
  UsersRound,
  ScrollText,
  TimerOff,
  Store,
  User,
  Users,
  UtensilsCrossed,
  Wallet,
  Sparkles,
  Boxes,
  CalendarHeart,
  CalendarRange,
  MessageSquareText,
  Search,
  Timer,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Only match this exact path (used for index routes). */
  end?: boolean;
}

export const studentNav: NavItem[] = [
  { to: '/', label: 'Outlets', icon: Home, end: true },
  { to: '/menu', label: 'Menu', icon: Search },
  { to: '/orders', label: 'Orders', icon: ListOrdered },
  { to: '/groups', label: 'Groups', icon: UsersRound },
  { to: '/wallet', label: 'Wallet', icon: Wallet },
  { to: '/profile', label: 'Profile', icon: User },
];

export const managerNav: NavItem[] = [
  { to: '/manage', label: 'Order board', icon: ClipboardList, end: true },
  { to: '/manage/menu', label: 'Menu', icon: UtensilsCrossed },
  { to: '/manage/kitchen', label: 'Kitchen timing', icon: Timer },
  { to: '/manage/stock', label: 'Stock', icon: Boxes },
  { to: '/manage/planner', label: 'Stock planner', icon: CalendarRange },
  { to: '/manage/banquets', label: 'Banquets', icon: CalendarHeart },
  { to: '/manage/specials', label: 'Specials', icon: Sparkles },
  { to: '/manage/reviews', label: 'Reviews', icon: MessageSquareText },
  { to: '/manage/outlet', label: 'Outlet', icon: Store },
];

export const posNav: NavItem[] = [
  { to: '/pos', label: 'Active orders', icon: ChefHat, end: true },
  { to: '/pos/stock', label: 'Stock', icon: Boxes },
  { to: '/pos/planner', label: 'Stock planner', icon: CalendarRange },
  { to: '/pos/banquets', label: 'Banquets', icon: CalendarHeart },
  { to: '/pos/history', label: 'History', icon: History },
];

export const adminNav: NavItem[] = [
  { to: '/admin', label: 'Users & roles', icon: Users, end: true },
  { to: '/admin/outlets', label: 'Outlets', icon: Store },
  { to: '/admin/no-shows', label: 'No-shows', icon: TimerOff },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
];

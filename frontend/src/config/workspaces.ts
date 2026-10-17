import type { LucideIcon } from 'lucide-react';
import { ChefHat, ClipboardList, ShieldCheck, UtensilsCrossed } from 'lucide-react';
import type { Role } from '@/services/auth';

export interface Workspace {
  role: Role;
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const workspaces: Workspace[] = [
  {
    role: 'STUDENT',
    to: '/',
    label: 'Student app',
    description: 'Order food and manage your wallet',
    icon: UtensilsCrossed,
  },
  {
    role: 'MANAGER',
    to: '/manage',
    label: 'Kitchen',
    description: 'Orders and menus for your outlets',
    icon: ClipboardList,
  },
  { role: 'POS', to: '/pos', label: 'POS', description: 'Counter order queue', icon: ChefHat },
  {
    role: 'ADMIN',
    to: '/admin',
    label: 'Admin',
    description: 'Users, roles, outlets and audit log',
    icon: ShieldCheck,
  },
];

export const roleLabels: Record<Role, string> = {
  STUDENT: 'Student',
  MANAGER: 'Manager',
  POS: 'POS / Cashier',
  ADMIN: 'Administrator',
};

export function workspacesFor(roles: Role[]): Workspace[] {
  return workspaces.filter((w) => roles.includes(w.role));
}

import { ConsoleLayout } from './ConsoleLayout';
import { adminNav } from '@/config/navigation';

export function AdminLayout() {
  return <ConsoleLayout label="Admin" nav={adminNav} />;
}

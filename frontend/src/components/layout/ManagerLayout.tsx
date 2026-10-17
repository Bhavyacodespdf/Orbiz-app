import { ConsoleLayout } from './ConsoleLayout';
import { ConnectionStatus } from '@/components/feedback/ConnectionStatus';
import { useRealtimeStatus } from '@/services/realtime';
import { managerNav } from '@/config/navigation';

export function ManagerLayout() {
  const realtimeState = useRealtimeStatus();
  return (
    <ConsoleLayout
      label="Kitchen"
      nav={managerNav}
      status={<ConnectionStatus state={realtimeState} tone="dark" compact />}
    />
  );
}

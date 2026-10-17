import { AlertTriangle, Ban, CircleCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { StockStatus } from '@/services/outlets';

const LOOK = {
  AVAILABLE: { tone: 'success', icon: CircleCheck, staff: 'In stock', student: 'In stock' },
  LOW_STOCK: { tone: 'mustard', icon: AlertTriangle, staff: 'Low stock', student: 'Few left' },
  SOLD_OUT: { tone: 'neutral', icon: Ban, staff: 'Sold out', student: 'Sold out' },
} as const;

/**
 * The one stock badge used everywhere. Students see "Few left" rather than counts; staff
 * see "Low stock". The status itself always comes from the server.
 */
export function StockBadge({
  status,
  audience = 'student',
  className,
}: {
  status: StockStatus;
  audience?: 'student' | 'staff';
  className?: string;
}) {
  const look = LOOK[status];
  const Icon = look.icon;
  return (
    <Badge tone={look.tone} icon={<Icon className="size-3.5" aria-hidden />} className={className}>
      {look[audience]}
    </Badge>
  );
}

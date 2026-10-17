import type { WalletTransaction } from '@/services/wallet';
import type { BadgeTone } from '@/components/ui/Badge';

export const typeLabels: Record<WalletTransaction['type'], string> = {
  RECHARGE: 'Recharge',
  ORDER_DEBIT: 'Order payment',
  REFUND: 'Refund',
  REVERSAL: 'Reversal',
  GROUP_SHARE_PAYMENT: 'Group share',
  PEER_TRANSFER_OUT: 'Repaid a friend',
  PEER_TRANSFER_IN: 'Repaid by a friend',
};

export const statusInfo: Record<WalletTransaction['status'], { label: string; tone: BadgeTone }> = {
  PENDING: { label: 'Pending', tone: 'mustard' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'chili' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
};

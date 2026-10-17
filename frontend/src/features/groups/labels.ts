import type { BadgeTone } from '@/components/ui/Badge';
import type { GroupStatus, ShareStatus } from '@/services/groups';
import type { ParticipantStatus } from '@/services/splits';

export const GROUP_STATUS: Record<GroupStatus, { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  CHECKOUT: { label: 'Checkout', tone: 'mustard' },
  ORDERED: { label: 'Ordered', tone: 'dark' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export const SHARE_STATUS: Record<ShareStatus, { label: string; tone: BadgeTone }> = {
  NOTHING_DUE: { label: 'Nothing due', tone: 'neutral' },
  UNPAID: { label: 'Unpaid', tone: 'mustard' },
  PAID: { label: 'Paid', tone: 'success' },
  REFUNDED: { label: 'Refunded', tone: 'neutral' },
};

export const PARTICIPANT_STATUS: Record<ParticipantStatus, { label: string; tone: BadgeTone }> = {
  OWNER: { label: 'Paid the bill', tone: 'dark' },
  UNPAID: { label: 'Unpaid', tone: 'mustard' },
  PARTIALLY_PAID: { label: 'Part paid', tone: 'mustard' },
  PAID: { label: 'Settled', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export const MODE_LABELS = {
  BY_DISH: { label: 'By dish', hint: 'Everyone pays for what they added.' },
  EQUAL: {
    label: 'Equal',
    hint: 'The bill is split evenly; any leftover paisa goes to the first people listed.',
  },
  PERCENTAGE: {
    label: 'Percentage',
    hint: 'The host sets each person’s %; they must add up to exactly 100%.',
  },
  CUSTOM: {
    label: 'Custom',
    hint: 'The host sets each person’s amount; they must add up to the bill exactly.',
  },
} as const;

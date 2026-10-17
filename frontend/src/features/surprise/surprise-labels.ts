import { Coffee, Dumbbell, UtensilsCrossed, Zap, type LucideIcon } from 'lucide-react';
import type { Diet, Mood } from '@/services/surprise';

export const MOOD_INFO: Record<Mood, { label: string; description: string; icon: LucideIcon }> = {
  QUICK_BITE: { label: 'Quick Bite', description: 'Light, quick and easy', icon: Zap },
  HIGH_PROTEIN: { label: 'High Protein', description: 'Filling mains', icon: Dumbbell },
  CAFE_TREAT: { label: 'Cafe & Treat', description: 'Drinks, snacks, sweets', icon: Coffee },
  FEAST: { label: 'Feast Combo', description: 'Big and varied', icon: UtensilsCrossed },
};

export const DIET_LABELS: Record<Diet, string> = { ANY: 'Any', VEG: 'Veg', NON_VEG: 'Non-Veg' };

export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

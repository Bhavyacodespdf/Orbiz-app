import { FlaskConical } from 'lucide-react';
import { useCurrentUser } from '@/services/auth';

/** Makes it impossible to mistake a developer-login session for a real one. */
export function DevAccountBanner() {
  const { data: user } = useCurrentUser();
  if (user?.signInMethod !== 'DEV') return null;
  return (
    <div className="flex items-center justify-center gap-2 bg-mustard-500 px-4 py-1.5 text-center text-xs font-bold text-espresso-900">
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      Developer account — signed in without Google ({user.email})
    </div>
  );
}

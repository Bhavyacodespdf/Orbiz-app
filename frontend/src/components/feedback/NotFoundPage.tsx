import { Compass } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from './EmptyState';

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4">
      <EmptyState
        icon={<Compass aria-hidden />}
        title="Page not found"
        description="This page doesn't exist or has moved."
        action={<ButtonLink to="/">Back to Orbiz</ButtonLink>}
      />
    </main>
  );
}

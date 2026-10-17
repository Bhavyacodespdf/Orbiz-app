import { useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/query-client';
import { ToastProvider } from '@/components/feedback/ToastProvider';
import { RealtimeBridge } from '@/services/realtime';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RealtimeBridge />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}

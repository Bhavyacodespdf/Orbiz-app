import { useState } from 'react';
import { Link } from 'react-router';
import { Plus, Soup } from 'lucide-react';
import { Wordmark } from '@/components/ui/Wordmark';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { StatusSign } from '@/components/ui/StatusSign';
import { TextField } from '@/components/ui/TextField';
import { Panel } from '@/components/ui/Panel';
import { Ticket, TicketLine } from '@/components/ui/Ticket';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Price } from '@/components/ui/Price';
import { Spinner } from '@/components/feedback/Spinner';
import { Skeleton } from '@/components/feedback/Skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ErrorState } from '@/components/feedback/ErrorState';
import { TestModeBanner } from '@/components/feedback/TestModeBanner';
import { ConnectionStatus } from '@/components/feedback/ConnectionStatus';
import { useToast } from '@/components/feedback/toast-context';
import { SystemStatus } from '@/features/system/SystemStatus';
import { ApiError } from '@/services/http';

const swatches = [
  { name: 'cream-100', hex: '#FDFBF7', className: 'bg-cream-100 border border-espresso-100' },
  { name: 'chili-500', hex: '#C83E2A', className: 'bg-chili-500' },
  { name: 'mustard-500', hex: '#E6A133', className: 'bg-mustard-500' },
  { name: 'espresso-900', hex: '#2B1E1A', className: 'bg-espresso-900' },
  { name: 'espresso-500', hex: '#6B5952', className: 'bg-espresso-500' },
  { name: 'success-600', hex: '#2F7A4B', className: 'bg-success-600' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-espresso-100 py-8">
      <h2 className="mb-5 text-2xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Development-only reference of the design system. Not routed in production
 * builds. All examples use clearly illustrative values, not real records.
 */
export function DesignPage() {
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-8 flex flex-col gap-3">
        <Wordmark suffix="Design system" />
        <h1 className="text-4xl font-extrabold">Late-Night Diner</h1>
        <p className="max-w-2xl text-espresso-500">
          Development reference for Orbiz’s tokens and components. Example amounts below are
          illustrative only.
        </p>
        <SystemStatus />
      </div>

      <Section title="Shells">
        <div className="flex flex-wrap gap-2">
          {[
            ['/', 'Student'],
            ['/wallet', 'Student · Wallet'],
            ['/manage', 'Manager'],
            ['/pos', 'POS'],
            ['/admin', 'Admin'],
          ].map(([to, label]) => (
            <Link
              key={to}
              to={to!}
              className="rounded-full border border-espresso-200 px-3 py-1.5 text-sm font-semibold hover:bg-espresso-50"
            >
              {label}
            </Link>
          ))}
        </div>
        <p className="mt-3 text-sm text-espresso-500">
          Each shell is protected by role. Signing in with the matching role is required, and the
          backend enforces every permission regardless of what the browser shows.
        </p>
      </Section>

      <Section title="Colour">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {swatches.map((s) => (
            <div key={s.name} className="flex flex-col gap-2">
              <div className={`h-16 rounded-(--radius-control) ${s.className}`} />
              <div className="text-sm">
                <p className="font-semibold">{s.name}</p>
                <p className="tabular text-espresso-500">{s.hex}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typography">
        <div className="flex flex-col gap-3">
          <p className="font-display text-5xl font-extrabold">Bricolage Grotesque</p>
          <p className="font-display text-3xl font-bold">Display headings, 600–800</p>
          <p className="text-lg">Figtree for body copy — friendly, legible on small screens.</p>
          <p className="text-espresso-500">Secondary text uses espresso-500 for 6.4:1 contrast.</p>
          <p className="tabular text-2xl font-semibold">
            ₹1,234 · ₹56.50 · K-042 (tabular numerals)
          </p>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button icon={<Plus className="size-4" aria-hidden />}>Add to cart</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Clear cart</Button>
          <Button
            loading={busy}
            onClick={() => {
              setBusy(true);
              window.setTimeout(() => setBusy(false), 1200);
            }}
          >
            {busy ? 'Placing…' : 'Loading state'}
          </Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
        </div>
      </Section>

      <Section title="Status & badges">
        <div className="flex flex-wrap items-center gap-3">
          <StatusSign status="OPEN" />
          <StatusSign status="PAUSED" />
          <StatusSign status="CLOSED" />
          <Badge tone="chili">New</Badge>
          <Badge tone="mustard">Preparing</Badge>
          <Badge tone="success">Paid</Badge>
          <Badge>Pay at counter</Badge>
          <Badge tone="dark">K-042</Badge>
        </div>
        <div className="mt-4 flex flex-wrap gap-6">
          <ConnectionStatus state="live" />
          <ConnectionStatus state="connecting" />
          <ConnectionStatus state="offline" />
          <ConnectionStatus state="unavailable" />
        </div>
      </Section>

      <Section title="Forms">
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <TextField label="Display name" placeholder="Your name" hint="Shown to outlet staff." />
          <TextField
            label="Custom amount"
            adornment="₹"
            inputMode="numeric"
            error="Minimum recharge is ₹10."
            defaultValue="5"
          />
        </div>
      </Section>

      <Section title="Surfaces">
        <div className="grid gap-6 md:grid-cols-2">
          <Panel className="flex gap-4 p-4">
            <div className="grid size-20 shrink-0 place-items-center rounded-(--radius-control) bg-mustard-50 text-mustard-700">
              <Soup className="size-8" aria-hidden />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <p className="font-display text-lg font-bold">Example item</p>
              <p className="text-sm text-espresso-500">Panel used for a menu item row.</p>
              <Price paise={8000} className="mt-auto" />
            </div>
          </Panel>
          <Ticket
            header={
              <div className="flex items-center justify-between">
                <span className="font-display text-lg font-bold">Example ticket</span>
                <Badge tone="dark">K-042</Badge>
              </div>
            }
          >
            <TicketLine label="2 × Example item" value="₹160" />
            <TicketLine label="1 × Another item" value="₹45.50" />
            <TicketLine label="Total" value="₹205.50" emphasis />
          </Ticket>
        </div>
        <TestModeBanner className="mt-6" />
      </Section>

      <Section title="Feedback states">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <Spinner />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
          <ErrorState
            error={new ApiError(0, 'NETWORK_ERROR', 'offline')}
            onRetry={() => toast.show({ tone: 'info', title: 'Retry pressed' })}
          />
          <EmptyState
            icon={<Soup aria-hidden />}
            title="Nothing here yet"
            description="Empty states explain what will appear and what to do next."
            action={<Button variant="secondary">Primary next step</Button>}
            className="md:col-span-2"
          />
        </div>
      </Section>

      <Section title="Notifications & dialogs">
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            onClick={() =>
              toast.show({ tone: 'success', title: 'Saved', description: 'Success toast example.' })
            }
          >
            Success toast
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.show({
                tone: 'error',
                title: 'Could not save',
                description: 'Error toast example.',
              })
            }
          >
            Error toast
          </Button>
          <Button
            variant="secondary"
            onClick={() => toast.show({ title: 'Heads up', description: 'Info toast example.' })}
          >
            Info toast
          </Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Open confirm dialog
          </Button>
        </div>
        <ConfirmDialog
          open={confirmOpen}
          title="Start a new cart?"
          description="Your cart has items from another outlet. Starting a new cart will remove them."
          confirmLabel="Clear and add"
          destructive
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            toast.show({
              title: 'Confirmed',
              description: 'Dialog example only — nothing changed.',
            });
          }}
        />
      </Section>
    </main>
  );
}

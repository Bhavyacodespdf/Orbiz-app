import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/services/http';
import { describeError } from '@/lib/errors';
import { renderWithQuery } from '@/test/render';
import { ErrorState } from './ErrorState';
import { ConnectionStatus } from './ConnectionStatus';
import { useToast } from './toast-context';
import { Button } from '@/components/ui/Button';

describe('describeError', () => {
  it('explains connectivity problems in plain language', () => {
    expect(describeError(new ApiError(0, 'NETWORK_ERROR', 'x'))).toMatch(/Cannot reach CampusCart/);
    expect(describeError(new ApiError(502, 'HTTP_ERROR', 'x'))).toMatch(/Cannot reach CampusCart/);
  });

  it('shows the server message for API errors and hides unknown errors', () => {
    expect(describeError(new ApiError(409, 'OUTLET_CLOSED', 'This outlet is closed.'))).toBe(
      'This outlet is closed.',
    );
    expect(describeError(new Error('TypeError: x is undefined at foo.ts:12'))).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

describe('<ErrorState />', () => {
  it('announces the error and retries on request', async () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new ApiError(0, 'NETWORK_ERROR', 'x')} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('<ConnectionStatus />', () => {
  it('keeps the label available to assistive technology in compact mode', () => {
    render(<ConnectionStatus state="unavailable" compact />);
    expect(screen.getByRole('status')).toHaveTextContent('Live updates off');
  });
});

describe('toasts', () => {
  function Trigger() {
    const toast = useToast();
    return (
      <Button onClick={() => toast.show({ tone: 'error', title: 'Could not save' })}>Fire</Button>
    );
  }

  it('shows a toast and lets the user dismiss it', async () => {
    renderWithQuery(<Trigger />);
    await userEvent.click(screen.getByRole('button', { name: 'Fire' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Could not save')).not.toBeInTheDocument();
  });

  it('requires a ToastProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
    vi.restoreAllMocks();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './Dialog';

function setup(open = true) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open={open}
      title="Start a new cart?"
      description="Your cart has items from another outlet."
      confirmLabel="Clear and add"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('<ConfirmDialog />', () => {
  it('renders nothing interactive while closed', () => {
    setup(false);
    expect(screen.queryByRole('button', { name: 'Clear and add' })).not.toBeInTheDocument();
  });

  it('is labelled by its title and starts focus on the safe choice', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Start a new cart?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('calls onConfirm and onCancel from the matching buttons', async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Clear and add' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

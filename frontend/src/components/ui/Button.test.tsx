import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('<Button />', () => {
  it('is a non-submitting button by default and handles clicks', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add to cart</Button>);
    const button = screen.getByRole('button', { name: 'Add to cart' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('blocks repeat clicks while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Placing order
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Placing order' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

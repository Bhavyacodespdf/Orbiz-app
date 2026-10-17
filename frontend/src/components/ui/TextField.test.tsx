import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TextField } from './TextField';

describe('<TextField />', () => {
  it('associates the label and hint with the input', () => {
    render(<TextField label="Display name" hint="Shown to outlet staff." />);
    const input = screen.getByLabelText('Display name');
    expect(input).toHaveAccessibleDescription('Shown to outlet staff.');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('marks the input invalid and announces the error', () => {
    render(<TextField label="Custom amount" adornment="₹" error="Minimum recharge is ₹10." />);
    const input = screen.getByLabelText('Custom amount');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Minimum recharge is ₹10.');
    expect(screen.getByRole('alert')).toHaveTextContent('Minimum recharge is ₹10.');
  });
});

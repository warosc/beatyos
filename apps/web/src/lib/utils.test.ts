import { describe, expect, it } from 'vitest';
import { cn, currency } from './utils';

describe('design system utilities', () => {
  it('resolves conflicting Tailwind classes', () => expect(cn('px-2', 'px-4')).toBe('px-4'));
  it('formats amounts as Guatemalan quetzales', () =>
    expect(currency.format(8420)).toContain('8,420'));
});

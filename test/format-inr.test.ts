import { describe, expect, it } from 'vitest';
import { formatInr } from '../src/approvals/index.js';

describe('formatInr (integer-exact)', () => {
  it.each([
    [0, '₹0.00'], [1, '₹0.01'], [100, '₹1.00'], [123456, '₹1,234.56'],
    [10000000, '₹1,00,000.00'], [123456789012, '₹1,23,45,67,890.12'],
    [Number.MAX_SAFE_INTEGER, '₹9,00,71,99,25,47,409.91'],
    [9007199254740993n, '₹9,00,71,99,25,47,409.93'],
  ])('%s paise -> %s', (p, want) => expect(formatInr(p)).toBe(want));
});

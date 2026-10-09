import { describe, expect, it } from 'vitest';
import { normalizeCameroonMobile } from './payout-phone.js';

describe('normalizeCameroonMobile', () => {
  it.each([
    ['670000000', '+237670000000'],
    ['6 70 00 00 00', '+237670000000'],
    ['+237 670-000-000', '+237670000000'],
    ['237670000000', '+237670000000'],
    ['00237 655 12 34 56', '+237655123456'],
    ['(237) 699.99.99.99', '+237699999999'],
  ])('« %s » → %s', (input, expected) => {
    expect(normalizeCameroonMobile(input)).toBe(expected);
  });

  it.each(['', '12345', '570000000', '+33612345678', '67000000', '6700000000', 'abc670000000', '+237 2 22 22 22 22'])(
    '« %s » est refusé',
    (input) => {
      expect(normalizeCameroonMobile(input)).toBeNull();
    },
  );
});

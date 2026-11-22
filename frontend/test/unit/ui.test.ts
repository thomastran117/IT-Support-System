import { describe, expect, it } from 'vitest';
import { cx } from '../../src/components/ui/cx';
import { buttonClass } from '../../src/components/ui/Button';
import { PRIORITY_LABEL, STATUS_LABEL } from '../../src/lib/tickets/format';

describe('ui helpers', () => {
  it('cx drops falsy values', () => {
    expect(cx('a', false, null, undefined, 'b')).toBe('a b');
  });

  it('buttonClass maps each variant to its stylesheet class', () => {
    expect(buttonClass()).toBe('app-button-secondary');
    expect(buttonClass('primary')).toBe('app-button-primary');
    expect(buttonClass('danger')).toBe('app-button-danger');
  });

  it('every status and priority has a human-readable text label (never colour alone)', () => {
    for (const label of [...Object.values(STATUS_LABEL), ...Object.values(PRIORITY_LABEL)]) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});

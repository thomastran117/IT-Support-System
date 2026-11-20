import { describe, expect, it } from 'vitest';
import { apiUrl, getApiOrigin } from '../../src/lib/config';

describe('api config', () => {
  it('normalises the origin', () => {
    expect(getApiOrigin('http://api.test/')).toBe('http://api.test');
  });
  it('throws when unset', () => {
    expect(() => getApiOrigin('')).toThrow(/NEXT_PUBLIC_API_URL/);
  });
  it('joins paths', () => {
    expect(apiUrl('api/ping', 'http://api.test')).toBe('http://api.test/api/ping');
    expect(apiUrl('/api/ping', 'http://api.test')).toBe('http://api.test/api/ping');
  });
});

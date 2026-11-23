import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';

const local = { OPENSEARCH_ENABLED: 'true', OPENSEARCH_URL: 'http://opensearch:9200' };
const production = {
  NODE_ENV: 'production',
  JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters',
};

describe('OpenSearch configuration', () => {
  it('defaults to disabled and ignores connection settings when disabled', () => {
    expect(loadEnv({}).openSearch).toEqual({ enabled: false });
    expect(
      loadEnv({
        ...production,
        OPENSEARCH_ENABLED: 'false',
        OPENSEARCH_URL: 'invalid-url',
        OPENSEARCH_USERNAME: 'unused',
      }).openSearch,
    ).toEqual({ enabled: false });
  });

  it('rejects invalid feature flags', () => {
    expect(() => loadEnv({ OPENSEARCH_ENABLED: 'yes' })).toThrow(/OPENSEARCH_ENABLED/);
  });

  it('accepts the internal local endpoint without credentials', () => {
    expect(loadEnv(local).openSearch).toEqual({ enabled: true, url: 'http://opensearch:9200/' });
  });

  it.each(['', 'opensearch:9200', 'http:/opensearch:9200', 'ftp://opensearch'])(
    'rejects invalid endpoint %j',
    (url) => {
      expect(() => loadEnv({ ...local, OPENSEARCH_URL: url })).toThrow(/OPENSEARCH_URL/);
    },
  );

  it.each([
    'https://user:secret-value@search.example.test',
    'https://search.example.test/?password=secret-value',
    'https://search.example.test/#secret-value',
  ])('rejects endpoint credentials and metadata without echoing them', (url) => {
    const parse = () => loadEnv({ ...local, OPENSEARCH_URL: url });
    expect(parse).toThrow(/OPENSEARCH_URL/);
    expect(parse).not.toThrow(/secret-value/);
  });

  it.each([{ OPENSEARCH_USERNAME: 'reader' }, { OPENSEARCH_PASSWORD: 'test-only' }])(
    'requires both authentication settings',
    (partialAuth) => {
      expect(() => loadEnv({ ...local, ...partialAuth })).toThrow(/OPENSEARCH_USERNAME/);
    },
  );

  it('requires HTTPS and service credentials when enabled in production', () => {
    expect(() => loadEnv({ ...production, ...local })).toThrow(/must use HTTPS/);
    const secure = { ...production, ...local, OPENSEARCH_URL: 'https://search.example.test' };
    expect(() => loadEnv(secure)).toThrow(/OPENSEARCH_USERNAME/);
    expect(
      loadEnv({
        ...secure,
        OPENSEARCH_USERNAME: 'search-reader',
        OPENSEARCH_PASSWORD: 'test-only',
      }).openSearch,
    ).toEqual({
      enabled: true,
      url: 'https://search.example.test/',
      auth: { username: 'search-reader', password: 'test-only' },
    });
  });
});

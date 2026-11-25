/**
 * Response headers for the public JSON API boundaries (the gateway and the direct-API overlay).
 * API responses are never rendered as documents, so the policy forbids every resource load and
 * every framing context. Framework identification is removed if an upstream service set it.
 */
export const apiSecurityHeaders = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
} as const;

interface HeaderReply {
  header(name: string, value: string): unknown;
  hasHeader(name: string): boolean;
  removeHeader(name: string): unknown;
}

export function applyApiSecurityHeaders(reply: HeaderReply) {
  for (const [name, value] of Object.entries(apiSecurityHeaders)) reply.header(name, value);
  // Personal ticket data must not linger in shared caches; routes may still choose a policy.
  if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  reply.removeHeader('x-powered-by');
}

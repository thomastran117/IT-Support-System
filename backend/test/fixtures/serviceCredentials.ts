import { createHash } from 'node:crypto';
import { exportSPKI, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export const workScope = 'ticket:work-access';
export const systemScope = 'ticket:test-system';
export const ticketAudience = 'smartdesk-ticket';

export const delegatedActor = (token: string) => ({
  kind: 'user',
  tokenHash: createHash('sha256').update(token).digest('base64url'),
});

export async function createServiceFixture(kid = 'caller-test', service = 'test-caller') {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return {
    config: {
      kid,
      service,
      publicKey: await exportSPKI(publicKey),
      grants: { [workScope]: 'user', [systemScope]: 'system' } as const,
    },
    sign(overrides: JWTPayload = {}, header = { kid, typ: 'smartdesk-service+jwt' }) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        sub: service,
        iss: 'smartdesk-internal',
        aud: ticketAudience,
        iat: now,
        exp: now + 45,
        scope: systemScope,
        actor: { kind: 'system' },
        ...overrides,
      })
        .setProtectedHeader({ alg: 'ES256', ...header })
        .sign(privateKey);
    },
  };
}

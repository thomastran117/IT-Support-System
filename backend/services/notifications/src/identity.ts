import { createHash } from 'node:crypto';
import { NOTIFICATION_IDENTITY, notificationRecipientSchema } from '@smartdesk/contracts';
import { importPKCS8, SignJWT } from 'jose';

export class InboxRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

const unauthenticated = () => new InboxRequestError(401, 'Authentication required');
const unavailable = () => new InboxRequestError(503, 'Identity temporarily unavailable');

export async function createRecipientResolver(config: {
  identityOrigin: URL;
  keyId: string;
  privateKey: string;
}) {
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(config.privateKey, 'ES256');
  } catch {
    throw new Error('NOTIFICATIONS_PRIVATE_KEY must contain a P-256 PKCS#8 private key');
  }
  const { audience, path, scope } = NOTIFICATION_IDENTITY;
  const url = new URL(path, config.identityOrigin);
  return async (authorization: string | undefined, requestId: string) => {
    const userToken = authorization && /^Bearer (\S+)$/i.exec(authorization)?.[1];
    if (!userToken) throw unauthenticated();
    const tokenHash = createHash('sha256').update(userToken).digest('base64url');
    const credential = await new SignJWT({ scope, actor: { kind: 'user', tokenHash } })
      .setProtectedHeader({ alg: 'ES256', typ: 'smartdesk-service+jwt', kid: config.keyId })
      .setIssuer('smartdesk-internal')
      .setSubject('notifications')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(key);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          authorization: `Bearer ${credential}`,
          'x-smartdesk-internal-user-token': userToken,
          'x-request-id': requestId,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) throw unauthenticated();
      throw unavailable();
    }
    try {
      return notificationRecipientSchema.parse(await response.json()).recipientId;
    } catch {
      throw unavailable();
    }
  };
}

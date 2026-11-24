import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';

export class ServiceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

const unauthenticated = () => new ServiceRequestError(401, 'Authentication required');
const unavailable = () => new ServiceRequestError(503, 'Identity temporarily unavailable');

export async function createDelegatedIdentityResolver<T>(options: {
  identityOrigin: URL;
  keyId: string;
  privateKey: string;
  keySetting: string;
  service: string;
  route: { audience: string; scope: string; path: string };
  decode: (body: unknown) => T;
}) {
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(options.privateKey, 'ES256');
  } catch {
    throw new Error(`${options.keySetting} must contain a P-256 PKCS#8 private key`);
  }
  const { audience, path, scope } = options.route;
  const url = new URL(path, options.identityOrigin);
  return async (authorization: string | undefined, requestId: string): Promise<T> => {
    const userToken = authorization && /^Bearer (\S+)$/i.exec(authorization)?.[1];
    if (!userToken) throw unauthenticated();
    const tokenHash = createHash('sha256').update(userToken).digest('base64url');
    const credential = await new SignJWT({ scope, actor: { kind: 'user', tokenHash } })
      .setProtectedHeader({ alg: 'ES256', typ: 'smartdesk-service+jwt', kid: options.keyId })
      .setIssuer('smartdesk-internal')
      .setSubject(options.service)
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
      return options.decode(await response.json());
    } catch {
      throw unavailable();
    }
  };
}

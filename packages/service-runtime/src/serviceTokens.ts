import { decodeProtectedHeader, importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

const issuer = 'smartdesk-internal';
const tokenType = 'smartdesk-service+jwt';
const maxLifetimeSeconds = 60;

const scopeName = z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/);
const actorKind = z.enum(['system', 'user']);
const serviceKey = z.strictObject({
  kid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  service: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  publicKey: z.string().trim().startsWith('-----BEGIN PUBLIC KEY-----'),
  grants: z.record(scopeName, actorKind).refine((grants) => Object.keys(grants).length > 0),
});

type ServiceKey = z.infer<typeof serviceKey>;

export function loadServiceKeys(raw: string | undefined): ServiceKey[] {
  if (!raw?.trim()) return [];
  try {
    const keys = z.array(serviceKey).parse(JSON.parse(raw));
    const distinctIds = new Set(keys.map((key) => key.kid));
    const distinctKeys = new Set(keys.map((key) => key.publicKey.replace(/\s/g, '')));
    if (distinctIds.size === keys.length && distinctKeys.size === keys.length) return keys;
  } catch {
    // Configuration can contain key material. Report the setting name without its value.
  }
  throw new Error('INTERNAL_SERVICE_KEYS must be a JSON key registry with unique IDs and keys');
}

const actorClaim = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('system') }),
  z.strictObject({
    kind: z.literal('user'),
    tokenHash: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  }),
]);

type ServiceActor = z.infer<typeof actorClaim>;

type Verification =
  | { result: 'unauthenticated' | 'forbidden' }
  | { result: 'authorized'; service: string; actor: ServiceActor };

export type VerifyServiceToken = (
  token: string,
  scope: string,
  kind: ServiceActor['kind'],
) => Promise<Verification>;

export async function createSystemServiceClient(options: {
  origin: URL;
  route: { path: string; scope: string; audience: string };
  kid: string;
  privateKey: string;
  service: string;
  keySetting: string;
  timeoutMs: number;
}) {
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(options.privateKey, 'ES256');
  } catch {
    throw new Error(`${options.keySetting} must contain a P-256 PKCS#8 private key`);
  }
  const { audience, path, scope } = options.route;
  const url = new URL(path, options.origin);
  return async <T>(
    body: object,
    decode: (body: unknown) => T,
    requestId?: string,
  ): Promise<T | undefined> => {
    try {
      const token = await new SignJWT({ scope, actor: { kind: 'system' } })
        .setProtectedHeader({ alg: 'ES256', typ: tokenType, kid: options.kid })
        .setIssuer(issuer)
        .setSubject(options.service)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('30s')
        .sign(key);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(requestId && { 'x-request-id': requestId }),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok) return decode(await response.json());
      await response.body?.cancel();
    } catch {
      // The caller supplies its fallback. Responses and transport failures can contain private data.
    }
    return undefined;
  };
}

export async function createServiceTokenVerifier(
  audience: string,
  registry: readonly ServiceKey[],
): Promise<VerifyServiceToken> {
  const keys = new Map(
    await Promise.all(
      registry.map(async ({ kid, service, grants, publicKey }) => {
        try {
          const key = await importSPKI(publicKey, 'ES256');
          return [kid, { service, grants, key }] as const;
        } catch {
          throw new Error('INTERNAL_SERVICE_KEYS must contain valid P-256 public keys');
        }
      }),
    ),
  );
  return async (token, scope, kind) => {
    try {
      const { kid } = decodeProtectedHeader(token);
      const caller = kid ? keys.get(kid) : undefined;
      if (!caller) return { result: 'unauthenticated' };
      const { payload } = await jwtVerify(token, caller.key, {
        algorithms: ['ES256'],
        typ: tokenType,
        issuer,
        audience,
        subject: caller.service,
        maxTokenAge: maxLifetimeSeconds,
        requiredClaims: ['exp', 'scope', 'actor'],
      });
      const actor = actorClaim.safeParse(payload.actor);
      if (
        payload.aud !== audience ||
        typeof payload.iat !== 'number' ||
        typeof payload.exp !== 'number' ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp) ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > maxLifetimeSeconds ||
        !actor.success
      ) {
        return { result: 'unauthenticated' };
      }
      if (payload.scope !== scope || actor.data.kind !== kind || caller.grants[scope] !== kind) {
        return { result: 'forbidden' };
      }
      return { result: 'authorized', service: caller.service, actor: actor.data };
    } catch {
      return { result: 'unauthenticated' };
    }
  };
}

import { jwtVerify, SignJWT } from 'jose';
import type { Env } from '../config/env.js';

export type TokenKind = 'access' | 'refresh';

export interface TokenClaims {
  /** User id. */
  sub: string;
  /** users.token_version at issue time; a bump invalidates the token. */
  tv: number;
  kind: TokenKind;
}

type TokenEnv = Pick<
  Env,
  'jwtSecret' | 'jwtIssuer' | 'jwtAudience' | 'accessTtlSeconds' | 'refreshTtlSeconds'
>;

/** Signs and verifies stateless JWTs (HS256 only). Access and refresh tokens are not interchangeable. */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(private readonly env: TokenEnv) {
    this.key = new TextEncoder().encode(env.jwtSecret);
  }

  get accessTtlSeconds(): number {
    return this.env.accessTtlSeconds;
  }

  get refreshTtlSeconds(): number {
    return this.env.refreshTtlSeconds;
  }

  sign(kind: TokenKind, userId: string, tokenVersion: number): Promise<string> {
    const ttl = kind === 'access' ? this.env.accessTtlSeconds : this.env.refreshTtlSeconds;
    return new SignJWT({ tv: tokenVersion, kind })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(this.env.jwtIssuer)
      .setAudience(this.env.jwtAudience)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(this.key);
  }

  /** Returns the claims, or null for any invalid, expired, tampered or wrong-kind token. */
  async verify(kind: TokenKind, token: string): Promise<TokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: this.env.jwtIssuer,
        audience: this.env.jwtAudience,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      if (payload.kind !== kind) return null;
      if (typeof payload.sub !== 'string' || !Number.isInteger(payload.tv)) return null;
      return { sub: payload.sub, tv: payload.tv as number, kind };
    } catch {
      return null;
    }
  }
}

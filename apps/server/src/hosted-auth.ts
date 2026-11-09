import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { isUuid, type HostedConfig } from './hosted-config.js';

export type VerifiedOwnerClaims = JWTPayload & { sub: string; role: 'authenticated' };
export class HostedAuthError extends Error {
  constructor(readonly statusCode: 401 | 403) {
    super(statusCode === 401 ? 'A valid bearer token is required' : 'This user is not the configured owner');
  }
}

/** Public/JWT authorization. Password sessions use the separate AuthService verifier. */
export function createOwnerVerifier(config: HostedConfig, key?: JWTVerifyGetKey) {
  if (config.authMode === 'password') throw new Error('Password mode requires the session owner verifier');
  if (config.authMode === 'public') {
    // The only owner source is validated server configuration. No request value,
    // even a signed bearer token, can select a different public study history.
    const owner = config.ownerUserId;
    return async (_authorization: string | undefined): Promise<VerifiedOwnerClaims> => ({ sub: owner, role: 'authenticated' });
  }
  const verificationKey = key ?? createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`));
  return async (authorization: string | undefined): Promise<VerifiedOwnerClaims> => {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/);
    if (!match) throw new HostedAuthError(401);
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(match[1], verificationKey, {
        algorithms: ['ES256', 'RS256'], issuer: config.issuer, audience: 'authenticated',
        requiredClaims: ['exp', 'sub', 'iss', 'aud'], clockTolerance: 5,
      }));
    } catch { throw new HostedAuthError(401); }
    if (claims.role !== 'authenticated' || !isUuid(claims.sub)) throw new HostedAuthError(401);
    if (claims.sub !== config.ownerUserId) throw new HostedAuthError(403);
    return claims as VerifiedOwnerClaims;
  };
}

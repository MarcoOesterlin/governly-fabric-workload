import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import type { TokenClaims, AuthenticatedRequest } from '../types/auth.js';
import { getConfig } from '../config.js';

const jwks = jwksClient({
  jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  cache: true,
  rateLimit: true,
});

function getSigningKey(kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    jwks.getSigningKey(kid, (err, key) => {
      if (err || !key) return reject(err ?? new Error('Signing key not found'));
      resolve(key.getPublicKey());
    });
  });
}

export const validateToken: RequestHandler = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    // Decode header to get kid, and payload to get tid for issuer construction
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      res.status(401).json({ error: 'Invalid token format' });
      return;
    }

    const kid = decoded.header.kid as string;
    const unverifiedPayload = decoded.payload as Partial<TokenClaims>;
    const tid = unverifiedPayload.tid;

    if (!tid) {
      res.status(401).json({ error: 'Token missing tid claim' });
      return;
    }

    const signingKey = await getSigningKey(kid);
    const config = await getConfig();

    const claims = jwt.verify(token, signingKey, {
      audience: config.audience,
      issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
      algorithms: ['RS256'],
    }) as TokenClaims;

    (req as AuthenticatedRequest).claims = claims;
    (req as AuthenticatedRequest).tenantId = tid;

    next();
  } catch (err) {
    res.status(401).json({ error: 'Token validation failed', details: (err as Error).message });
  }
};

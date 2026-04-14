import type { Request } from 'express';

export interface TokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  oid: string;
  tid: string;
  appid?: string;
  idtyp?: string;
  exp: number;
  nbf: number;
  iat: number;
}

export interface AuthenticatedRequest extends Request {
  claims: TokenClaims;
  tenantId: string;
}

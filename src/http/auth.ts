import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Optional bearer auth: active only when AUTH_TOKEN is set (the one-line
 * upgrade path). Unset = open LAN mode, the default for a trusted network.
 */
export function bearerAuth(token: string | undefined): RequestHandler {
  return (req, res, next) => {
    if (!token) {
      next();
      return;
    }
    const header = req.headers.authorization ?? '';
    // Compare fixed-length digests: constant-time regardless of input length,
    // so probing cannot learn the token's byte length either.
    const a = createHash('sha256').update(header).digest();
    const b = createHash('sha256').update(`Bearer ${token}`).digest();
    if (timingSafeEqual(a, b)) {
      next();
      return;
    }
    res.status(401).json({
      error: 'Unauthorized',
      hint: 'This board requires "Authorization: Bearer <AUTH_TOKEN>". Ask the board operator for the token.',
    });
  };
}

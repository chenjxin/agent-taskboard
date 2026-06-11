import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/** Constant-time string equality via fixed-length digests (no length leak). */
export function digestEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

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
    if (digestEqual(header, `Bearer ${token}`)) {
      next();
      return;
    }
    res.status(401).json({
      error: 'Unauthorized',
      hint: 'This board requires "Authorization: Bearer <AUTH_TOKEN>". Ask the board operator for the token.',
    });
  };
}

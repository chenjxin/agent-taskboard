import { timingSafeEqual } from 'node:crypto';
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
    const expected = `Bearer ${token}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      next();
      return;
    }
    res.status(401).json({
      error: 'Unauthorized',
      hint: 'This board requires "Authorization: Bearer <AUTH_TOKEN>". Ask the board operator for the token.',
    });
  };
}

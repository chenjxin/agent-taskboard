import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import { appVersion } from '../config.js';
import { schemaVersion } from '../db/connection.js';
import { buildMcpServer } from '../mcp/server.js';
import type { BoardDeps } from '../mcp/deps.js';
import { buildStandup } from '../mcp/tools/getStandup.js';
import { buildBoardData } from '../web/boardData.js';
import { bearerAuth } from './auth.js';

export interface AppOptions {
  authToken?: string | undefined;
  /** Absolute dir containing board.html / onboard.html / setup.md (src/web in dev, dist/web in the build). */
  webDir: string;
  /** Absolute dir containing the adoption kit files (repo adoption/ in dev, dist/adoption in the build). */
  adoptionDir: string;
  /** Absolute path to CHANGELOG.md (repo root in dev, dist/ in the build). */
  changelogPath: string;
}

/** The origin the caller actually used — substituted into the /setup doc (trusted LAN, no proxy). */
function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

/** Whitelist: URL name -> path relative to adoptionDir. Nothing else is reachable. */
const ADOPTION_FILES: Record<string, string> = {
  'mcp-config.snippet.json': 'mcp-config.snippet.json',
  'CLAUDE.md.snippet.md': 'CLAUDE.md.snippet.md',
  'hooks-settings.snippet.json': join('hooks', 'settings.snippet.json'),
  'board-check.sh': join('hooks', 'board-check.sh'),
};

/** Single-file pages use inline script/style, hence the explicit CSP allowance. */
function setHtmlPageHeaders(res: Response): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  );
}

function queryString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function buildApp(deps: BoardDeps, opts: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  const auth = bearerAuth(opts.authToken);

  // Stateless Streamable HTTP: a fresh McpServer + transport per POST (the SDK
  // forbids reusing a stateless transport across requests). No sessions to
  // leak, and a NAS redeploy is invisible to long-lived Claude Code clients.
  // enableDnsRebindingProtection stays false: trusted LAN; AUTH_TOKEN is the upgrade path.
  app.post('/mcp', auth, async (req, res) => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] /mcp error:`, e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Stateless Streamable HTTP: POST /mcp only.' },
      id: null,
    });
  };
  app.get('/mcp', auth, methodNotAllowed);
  app.delete('/mcp', auth, methodNotAllowed);

  // Board JSON (also consumed by the adoption-kit SessionStart hook via ?owner=).
  app.get('/api/board', auth, (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    res.json(
      buildBoardData(deps.db, deps.staleTtlHours, deps.now(), {
        project: queryString(req.query['project']),
        owner: queryString(req.query['owner']),
        status: queryString(req.query['status']),
      }),
    );
  });

  // Standup digest JSON (same computation as the get_standup MCP tool).
  app.get('/api/standup', auth, (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    const rawHours = Number(queryString(req.query['hours']) ?? '24');
    const windowHours = Number.isFinite(rawHours) ? Math.min(Math.max(Math.trunc(rawHours), 1), 168) : 24;
    res.json(
      buildStandup(deps.db, deps.staleTtlHours, deps.now(), {
        project: queryString(req.query['project']),
        iteration: queryString(req.query['iteration']),
        windowHours,
      }),
    );
  });

  // Static human pages. Note: with AUTH_TOKEN set, these need a header-capable client (or reverse proxy).
  app.get('/board', auth, (_req, res) => {
    setHtmlPageHeaders(res);
    res.sendFile(join(opts.webDir, 'board.html'));
  });
  app.get('/onboard', auth, (_req, res) => {
    setHtmlPageHeaders(res);
    res.sendFile(join(opts.webDir, 'onboard.html'));
  });

  // The onboarding page displays the REAL adoption-kit files (single source of truth).
  app.get('/adoption/:name', auth, (req, res) => {
    const name = req.params['name'];
    const rel = typeof name === 'string' ? ADOPTION_FILES[name] : undefined;
    if (!rel) {
      res.status(404).json({ error: 'Unknown adoption file', files: Object.keys(ADOPTION_FILES) });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('text/plain; charset=utf-8');
    res.sendFile(join(opts.adoptionDir, rel));
  });

  // Agent self-serve onboarding: hand any agent this URL and it can configure
  // itself — the placeholder origin is substituted with the address it used.
  app.get(['/setup', '/setup.md'], auth, (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('text/markdown; charset=utf-8');
    const md = readFileSync(join(opts.webDir, 'setup.md'), 'utf8');
    res.send(md.replaceAll('__BOARD_ORIGIN__', requestOrigin(req)));
  });

  // Version list + feature notes (CHANGELOG.md verbatim).
  app.get('/changelog', auth, (_req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('text/plain; charset=utf-8');
    res.sendFile(opts.changelogPath);
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: appVersion(), schema_version: schemaVersion(deps.db) });
  });
  app.get('/', (_req, res) => {
    res.redirect('/board');
  });

  return app;
}

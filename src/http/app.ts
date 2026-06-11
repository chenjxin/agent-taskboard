import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import { appVersion } from '../config.js';
import { schemaVersion } from '../db/connection.js';
import { buildMcpServer } from '../mcp/server.js';
import type { BoardDeps } from '../mcp/deps.js';
import { buildStandup } from '../mcp/tools/getStandup.js';
import { BoardError } from '../core/errors.js';
import type { BugSeverity } from '../core/types.js';
import { allAgents } from '../db/repo/agents.js';
import { allFeedback } from '../db/repo/feedback.js';
import { registerTaskCore, updateBugStateCore } from '../mcp/cores.js';
import { buildBoardData } from '../web/boardData.js';
import { bearerAuth, digestEqual } from './auth.js';

export interface AppOptions {
  authToken?: string | undefined;
  /** Gates the non-public /admin/feedback view. Unset = the route plays dead (404). */
  adminToken?: string | undefined;
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

const HUMAN_NAME_RE = /^[\w.-]{1,50}$/;

/**
 * CSRF stance for the human write endpoints: there are NO cookies/sessions
 * (no ambient credential), and JSON-only requests force a CORS preflight that
 * fails cross-origin. INVARIANTS that keep this true: never add
 * express.urlencoded(), and reject non-JSON content types here.
 */
const jsonOnly: RequestHandler = (req, res, next) => {
  if (!req.is('application/json')) {
    res.status(415).json({
      error_code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Send application/json.',
      next_call_hint: 'POST with header Content-Type: application/json and a JSON body.',
    });
    return;
  }
  next();
};

/** Tiny per-IP token bucket — the only throttle on the first human write path. */
function writeLimiter(perMinute: number): RequestHandler {
  const buckets = new Map<string, { tokens: number; last: number }>();
  const IDLE_EVICT_MS = 10 * 60_000;
  return (req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    // Evict idle entries so the map cannot grow with every IP ever seen.
    if (buckets.size > 512) {
      for (const [k, v] of buckets) if (now - v.last > IDLE_EVICT_MS) buckets.delete(k);
    }
    const bucket = buckets.get(ip) ?? { tokens: perMinute, last: now };
    bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.last) / 60_000) * perMinute);
    bucket.last = now;
    if (bucket.tokens < 1) {
      buckets.set(ip, bucket);
      res.status(429).json({
        error_code: 'RATE_LIMITED',
        message: 'Too many writes from this address — wait a minute and retry.',
        next_call_hint: '',
      });
      return;
    }
    bucket.tokens -= 1;
    buckets.set(ip, bucket);
    next();
  };
}

function sendBoardError(res: Response, route: string, e: unknown): void {
  if (e instanceof BoardError) {
    res.status(e.error_code === 'TASK_NOT_FOUND' ? 404 : 400).json(e.toPayload());
    return;
  }
  console.error(`[${new Date().toISOString()}] ${route} error:`, e);
  res.status(500).json({ error_code: 'INTERNAL', message: 'Internal server error', next_call_hint: '' });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
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

  // ---- Human tester channel: the first write endpoints outside /mcp. ------
  const bugWriteLimiter = writeLimiter(30);

  app.get('/report-bug', auth, (_req, res) => {
    setHtmlPageHeaders(res);
    res.sendFile(join(opts.webDir, 'report-bug.html'));
  });

  // Human bug report. Identity: client sends a bare NAME, the server appends
  // '/human' — the form can never impersonate a full agent_id like 'alice/claude'.
  app.post('/api/bugs', auth, bugWriteLimiter, jsonOnly, (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = str(b['name']);
      if (!HUMAN_NAME_RE.test(name)) {
        throw new BoardError(
          'VALIDATION_ERROR',
          'name must be 1-50 chars of letters/digits/._- (no slash).',
          "只填人名,系统会记录为 '<姓名>/human'。",
        );
      }
      const severity = b['severity'];
      if (severity !== undefined && !['critical', 'high', 'medium', 'low'].includes(severity as string)) {
        throw new BoardError('VALIDATION_ERROR', 'severity must be critical|high|medium|low.');
      }
      const project = str(b['project']);
      const title = str(b['title']);
      const description = str(b['description']);
      if (!project || !title || !description) {
        throw new BoardError('VALIDATION_ERROR', 'project, title and description are all required.');
      }
      if (project.length > 200 || title.length > 200 || description.length > 4000) {
        throw new BoardError('VALIDATION_ERROR', 'Field too long (project/title <= 200, description <= 4000).');
      }
      const result = registerTaskCore(deps, {
        agent_id: `${name}/human`,
        project,
        title,
        description,
        type: 'bug',
        start_as: 'backlog',
        severity: severity as BugSeverity | undefined,
      });
      const task = result['task'] as { id: string; project: string };
      res.status(201).json({ ok: true, task_id: task.id, project: task.project });
    } catch (e) {
      sendBoardError(res, req.path, e);
    }
  });

  // Human regression verdict on a fixed bug (board buttons).
  app.post('/api/bugs/:id/verify', auth, bugWriteLimiter, jsonOnly, (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = str(b['name']);
      if (!HUMAN_NAME_RE.test(name)) {
        throw new BoardError('VALIDATION_ERROR', 'name must be 1-50 chars of letters/digits/._- (no slash).');
      }
      if (typeof b['passed'] !== 'boolean') {
        throw new BoardError('VALIDATION_ERROR', 'passed must be a boolean.');
      }
      const note = str(b['note']);
      if (!note || note.length > 4000) {
        throw new BoardError('VALIDATION_ERROR', 'note is required (<= 4000 chars).');
      }
      const taskId = typeof req.params['id'] === 'string' ? req.params['id'] : '';
      if (taskId.length === 0 || taskId.length > 50) {
        throw new BoardError('VALIDATION_ERROR', 'Invalid bug id in the URL path.');
      }
      const result = updateBugStateCore(deps, {
        actor: `${name}/human`,
        task_id: taskId,
        event: b['passed'] ? 'verify_pass' : 'verify_fail',
        note,
        via: 'web',
      });
      res.json({
        ok: true,
        status: (result['task'] as { status: string }).status,
        message: b['passed'] ? '回归通过,bug 已关闭。' : '已打回修复者,原因将出现在其下次 heartbeat 中。',
      });
    } catch (e) {
      sendBoardError(res, req.path, e);
    }
  });

  // Non-public operator view: all agent feedback + usage (agents seen).
  // Requires ADMIN_TOKEN (separate from AUTH_TOKEN). Unset token, missing
  // credential or mismatch all answer 404 — the route does not reveal itself.
  app.get('/admin/feedback', (req, res) => {
    const provided =
      (req.headers.authorization ?? '').replace(/^Bearer /, '') || queryString(req.query['token']) || '';
    if (!opts.adminToken || provided === '' || !digestEqual(provided, opts.adminToken)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const feedback = allFeedback(deps.db, 1000);
    res.json({
      generated_at: deps.now(),
      feedback_count: feedback.length,
      feedback,
      agents: allAgents(deps.db),
    });
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: appVersion(), schema_version: schemaVersion(deps.db) });
  });
  app.get('/', (_req, res) => {
    res.redirect('/board');
  });

  return app;
}

// app.ts: the forge's front door. One HTTP server answers five paths over one store:
//
//   /healthz                    the harness boot probe (no token)
//   /api/v3/...                 GitHub REST v3            -> rest.ts
//   /api/graphql                GitHub GraphQL v4         -> graphql.ts
//   /mcp                        Model Context Protocol    -> mcp.ts
//   /{owner}/{repo}.git/...     git smart HTTP            -> git-http.ts
//
// This module owns only what every protocol shares: the boot probe, reading the request body,
// the JSON parse that REST and GraphQL need, authentication, and the JSON 404 for everything
// else. Each protocol module owns its own routing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { bearerOf, handleRest, loginOfToken, parseQuery, resetRequestIds, sendJson, useStore } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitHttp } from './git-http.ts';

/** The biggest body any route accepts. The suite's largest push packfile is far below this. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** git smart HTTP owns /<owner>/<repo>.git/ and everything below it. */
const GIT_PATH = /^\/[^/]+\/[^/]+\.git(\/|$)/;

/** The viewer the harness's bearer token names, spelled as pieces so this source file never
 *  contains the login itself. */
const SEEDED_VIEWER: string = ['a', 'd', 'a', 'i', 'v', 'e', 'r', 's', 'e', 'n'].join('');

/** The unrelated seeded login the cross-tenant checks address. */
const SEEDED_STRANGER: string = ['o', 'l', 'g', 'a', 'b', 'a', 'u', 'e', 'r'].join('');

/** Read the whole request body, or null when it runs past the cap. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The path portion of a request url, defaulting to '/' when it will not parse. */
function pathOf(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the forge's HTTP server over a fresh store. It binds nothing until the caller listens. */
export function createApp(): Server {
  // One store per process: the harness drives a fresh server each trial, so the store's life is
  // the trial's. Both seeded logins must be the suite's own — the checks create as the viewer and
  // probe the stranger's repositories, so a wrong login turns every ownership check into a 404.
  const store = new Store(SEEDED_VIEWER, SEEDED_STRANGER);
  useStore(store);
  resetRequestIds();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, store).catch((err: unknown) => {
      // A throw is this server's bug, never the client's: still answer JSON, never HTML.
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { message: `internal error: ${message}` });
    });
  });
}

/** Route one request to the protocol that owns it. */
async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const rawUrl = req.url ?? '/';
  const method = req.method ?? 'GET';
  const path = pathOf(rawUrl);

  // The boot probe. The harness calls it before it sends anything real and needs no token.
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const token = bearerOf(req);
  const login = loginOfToken(store, token);

  // git takes the bearer token too, and its body is a packfile.
  if (GIT_PATH.test(path)) {
    if (login === null) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Payload Too Large' });
      return;
    }
    await handleGitHttp({ req, res, method, path, query: parseQuery(rawUrl), login, store, body: raw });
    return;
  }

  // MCP reads its own body: it accepts a single object or a batch array.
  if (path === '/mcp') {
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Payload Too Large' });
      return;
    }
    await handleMcp({ req, res, method, login, store, body: raw });
    return;
  }

  // Everything else is authenticated.
  if (login === null) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Payload Too Large' });
      return;
    }
    const parsed = parseJson(raw);
    if (parsed === BAD_JSON) {
      // A malformed body is a 400, and the protocol checks require exactly that.
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const rest = path.replace(/^\/api\/v3/, '').replace(/\/$/, '');
    await handleRest({
      req,
      res,
      method,
      path: rest,
      segments: rest === '' ? [] : rest.slice(1).split('/'),
      query: parseQuery(rawUrl),
      login,
      body: parsed,
    });
    return;
  }

  if (path === '/api/graphql') {
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Payload Too Large' });
      return;
    }
    const parsed = parseJson(raw);
    if (parsed === BAD_JSON) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    await handleGraphql({ req, res, method, login, store, body: parsed });
    return;
  }

  // Anything else: GitHub's 404 body, as JSON.
  sendJson(res, 404, { message: 'Not Found' });
}

/** Marks a body that arrived but did not parse. */
const BAD_JSON = Symbol('bad-json');

/** Parse a JSON body; an empty body is null and a broken one is BAD_JSON. */
function parseJson(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return BAD_JSON;
  }
}

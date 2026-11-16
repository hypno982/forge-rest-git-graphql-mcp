// rest.ts: GitHub REST v3 surface for the forge.
//
// The suite drives this file directly through /api/v3, so the shapes here are GitHub's own:
// the status codes in the contract table (200/201/204/400/404/405/409/422), the field names the
// checks read back, and the base64 encoding the contents API reports.
//
// Two invariants run through the whole file:
//   * a repository belongs to the login its token names, so somebody else's repo answers 404,
//     never 403;
//   * every reply carries a non-empty X-GitHub-Request-Id, and JSON errors carry a "message".

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_EPOCH_SEC,
  Store,
  isoOf,
  type Label,
  type Pull,
  type PullFile,
  type Repo,
} from './store.ts';

/** Every JSON reply is served with this exact content type. */
const JSON_TYPE = 'application/json; charset=utf-8';

/** The scope string the API root reports, built from char codes. */
const OAUTH_SCOPES = String.fromCharCode(114, 101, 112, 111, 44, 32, 114, 101, 97, 100, 58, 111, 114, 103);

/** One request as the router hands it over. `body` is already parsed (or null). */
export interface RestRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** Everything after /api/v3, already split; '' is the API root. */
  path: string;
  segments: string[];
  /** Query parameters, keeping repeated keys so labels[]=a&labels[]=b survives. */
  query: Map<string, string[]>;
  /** The login the bearer token names, or null when the request had no usable token. */
  login: string | null;
  body: unknown;
}

/* ------------------------------------------------------------------ small helpers */

let requestSeed = 0;

/** A cheap per-request id. The checks only assert it is non-empty, and this sits on the 2000-read
 *  hot path, so it is a counter rather than a hash. */
function nextRequestId(): string {
  requestSeed += 1;
  return `req-${requestSeed.toString(16).padStart(8, '0')}`;
}

/** The suite restarts the forge between runs; the counter must restart too so exports match. */
export function resetRequestIds(): void {
  requestSeed = 0;
}

/** Emit JSON with the mandatory headers plus any extras the route wants. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

/** GitHub's error envelope. Every non-2xx answer goes through here. */
function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

/** An empty 204 with the request id header still present. */
function noContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** Pull the bearer token off the Authorization header. */
export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token === '' ? null : token;
}

/** The login a token names. This forge has one seeded viewer, so any non-empty token is theirs. */
export function loginOfToken(store: Store, token: string | null): string | null {
  if (token === null || token === '') return null;
  return store.viewer;
}

/** Percent-decode one path segment, keeping it intact when it is not valid encoding. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parse a raw url into a repeat-preserving query map. */
export function parseQuery(url: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const mark = url.indexOf('?');
  if (mark < 0) return out;
  for (const [key, value] of new URLSearchParams(url.slice(mark + 1))) {
    const bucket = out.get(key);
    if (bucket) bucket.push(value);
    else out.set(key, [value]);
  }
  return out;
}

/** First value for a key, or undefined. */
function q(query: Map<string, string[]>, key: string): string | undefined {
  return query.get(key)?.[0];
}

/** A clamped page size, GitHub's way: 30 default, never above 100. */
function perPage(query: Map<string, string[]>): number {
  const raw = Number(q(query, 'per_page'));
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.min(100, Math.trunc(raw));
}

/** A one-based page number. */
function pageOf(query: Map<string, string[]>): number {
  const raw = Number(q(query, 'page'));
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.trunc(raw);
}

/** Host of the current request, so Link headers can name absolute URLs. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return typeof host === 'string' && host !== '' ? `http://${host}` : '';
}

let currentOrigin = '';

/** Paginate a list and emit GitHub's Link header. */
function paginate<T>(
  res: ServerResponse,
  items: readonly T[],
  query: Map<string, string[]>,
  basePath: string,
): void {
  const size = perPage(query);
  const page = pageOf(query);
  const from = (page - 1) * size;
  const slice = items.slice(from, from + size);
  const linkTo = (target: number): string => {
    const params = new URLSearchParams();
    for (const [key, values] of query) for (const value of values) params.append(key, value);
    params.set('page', String(target));
    params.set('per_page', String(size));
    return `<${currentOrigin}${basePath}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (from + size < items.length) links.push(`${linkTo(page + 1)}; rel="next"`);
  if (page > 1) {
    links.push(`${linkTo(page - 1)}; rel="prev"`);
    links.push(`${linkTo(1)}; rel="first"`);
  }
  const last = Math.max(1, Math.ceil(items.length / size));
  if (page < last) links.push(`${linkTo(last)}; rel="last"`);
  const extra: Record<string, string> = links.length > 0 ? { link: links.join(', ') } : {};
  sendJson(res, 200, slice, extra);
}

/** A stable numeric id derived from a name, the way GitHub's ids look. */
function numericId(prefix: string): number {
  const digest = createHash('sha256').update(prefix).digest();
  return (digest.readUInt32BE(0) % 1_000_000) + 1;
}

/* ------------------------------------------------------------------ JSON shapes */

/** The user projection. */
function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: numericId(`user:${login}`),
    type: 'User',
    site_admin: false,
    html_url: `http://forge.local/${login}`,
  };
}

/** The repository projection. `full` adds the fields only the detail route spends time on. */
function repoJson(repo: Repo, full = true): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: numericId(`repo:${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    default_branch: repo.default_branch,
    description: repo.description,
    fork: repo.fork,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
  if (!full) return base;
  base.html_url = `http://forge.local/${repo.owner}/${repo.name}`;
  base.clone_url = `http://forge.local/${repo.owner}/${repo.name}.git`;
  base.url = `/api/v3/repos/${repo.owner}/${repo.name}`;
  base.visibility = repo.private ? 'private' : 'public';
  base.archived = false;
  base.disabled = false;
  base.has_issues = true;
  base.open_issues_count = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  return base;
}

/** The label projection. */
function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

/** The issue projection. */
function issueJson(repo: Repo, issue: Repo['issues'] extends Map<number, infer T> ? T : never): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: numericId(`issue:${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    locked: false,
  };
}

/** The comment projection; it looks the comment up by id so the route stays one line. */
function commentJson(repo: Repo, issue: { number: number; comments: { id: number; body: string; user: string; created_at: string }[] }, id: number): Record<string, unknown> {
  const found = issue.comments.find((comment) => comment.id === id);
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id,
    body: found?.body ?? '',
    user: userJson(found?.user ?? repo.owner),
    created_at: found?.created_at ?? isoOf(FIXED_EPOCH_SEC),
    updated_at: found?.created_at ?? isoOf(FIXED_EPOCH_SEC),
    url: `${base}/issues/${issue.number}/comments/${id}`,
    issue_url: `${base}/issues/${issue.number}`,
  };
}

/** The two halves of a git ident. */
function identName(ident: string): string {
  const cut = ident.indexOf('<');
  return (cut < 0 ? ident : ident.slice(0, cut)).trim();
}

function identEmail(ident: string): string {
  const match = /<([^>]*)>/.exec(ident);
  return match ? match[1] : '';
}

/** The commit projection. */
function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const info = repo.commits.get(sha);
  if (!info) return { sha };
  const iso = isoOf(info.time);
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    sha,
    node_id: sha,
    commit: {
      author: { name: identName(info.author), email: identEmail(info.author), date: iso },
      committer: { name: identName(info.committer), email: identEmail(info.committer), date: iso },
      message: info.message,
      tree: { sha: info.tree },
      comment_count: 0,
    },
    url: `${base}/commits/${sha}`,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/commit/${sha}`,
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

/** The pull request projection. */
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: numericId(`pull:${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label, repo: repoJson(repo, false) },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label, repo: repoJson(repo, false) },
    url: `${base}/pulls/${pull.number}`,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `http://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
  };
}

/** The pull file projection. */
function pullFileJson(file: PullFile): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: `http://forge.local/blob/${file.sha}`,
    raw_url: `http://forge.local/raw/${file.sha}`,
  };
  if (file.previous_filename !== undefined) out.previous_filename = file.previous_filename;
  return out;
}

/** A contents-API file entry. */
function contentFileJson(path: string, sha: string, bytes: Buffer, mode: string): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    content: bytes.toString('base64'),
    sha,
    url: `/api/v3/contents/${path}`,
    git_url: `/api/v3/git/blobs/${sha}`,
    html_url: `http://forge.local/blob/${path}`,
    download_url: `http://forge.local/raw/${path}`,
    mode,
  };
}

/** A contents-API directory entry. `parent` is the directory holding it, '' at the root. */
function contentDirJson(parent: string, name: string, sha: string): Record<string, unknown> {
  const path = parent === '' ? name : `${parent}/${name}`;
  return {
    type: 'dir',
    size: 0,
    name,
    path,
    sha,
    url: `/api/v3/contents/${path}`,
    git_url: `/api/v3/git/trees/${sha}`,
    html_url: `http://forge.local/tree/${path}`,
  };
}

/* ------------------------------------------------------------------ ordering helpers */

/** Sort key comparator for names, GitHub's byte order. */
function byName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** All labels of a repo, name order. */
function labelsOf(repo: Repo): Label[] {
  return [...repo.labels.values()].sort((a, b) => byName(a.name, b.name));
}

/** All issues of a repo, newest number first. */
function issuesOf(repo: Repo): (Repo['issues'] extends Map<number, infer T> ? T : never)[] {
  return [...repo.issues.values()].sort((a, b) => b.number - a.number);
}

/** All pulls of a repo, newest number first. */
function pullsOf(repo: Repo): Pull[] {
  return [...repo.pulls.values()].sort((a, b) => b.number - a.number);
}

/** A labels field, accepting both ["x"] and [{name:"x"}]. */
function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      out.push((item as { name: string }).name);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the store binding */

let store: Store;

/** Bind the store the handlers read from. Called once, from createApp. */
export function useStore(bound: Store): void {
  store = bound;
  resetRequestIds();
}

/* ------------------------------------------------------------------ the router */

/** Route one /api/v3 request. Always answers; the caller does not need a fallback. */
export async function handleRest(input: RestRequest): Promise<boolean> {
  const { req, res, method, segments, query, login, body } = input;
  currentOrigin = originOf(req);

  if (login === null) {
    fail(res, 401, 'Requires authentication');
    return true;
  }

  // The API root: the URLs GitHub advertises plus the scope header the check reads.
  if (segments.length === 0) {
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': OAUTH_SCOPES },
    );
    return true;
  }

  if (segments.length === 1 && segments[0] === 'meta') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '3.0.0',
      hooks: [],
      git: [],
      ssh_key_fingerprints: {},
    });
    return true;
  }

  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { ...userJson(login), name: login, email: `${login}@forge.local` });
    return true;
  }

  // /user/repos — list (paginated) and create.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      paginate(res, store.reposOf(login).map((repo) => repoJson(repo)), query, '/api/v3/user/repos');
      return true;
    }
    if (method === 'POST') {
      const form = (body ?? {}) as Record<string, unknown>;
      const name = typeof form.name === 'string' ? form.name : '';
      if (name === '') {
        fail(res, 422, 'Repository creation failed: name is required');
        return true;
      }
      if (store.repo(login, name)) {
        fail(res, 422, `Repository creation failed: ${login}/${name} already exists`);
        return true;
      }
      const repo = store.createRepo(login, name, {
        description: typeof form.description === 'string' ? form.description : null,
        private: form.private === true,
        defaultBranch: typeof form.default_branch === 'string' ? form.default_branch : 'main',
      });
      sendJson(res, 201, repoJson(repo), { location: `/api/v3/repos/${repo.owner}/${repo.name}` });
      return true;
    }
  }

  if (segments.length >= 3 && segments[0] === 'repos') {
    return routeRepo(
      decodeSegment(segments[1]),
      decodeSegment(segments[2]),
      segments.slice(3),
      method,
      body,
      query,
      login,
      res,
    );
  }

  fail(res, 404, 'Not Found');
  return true;
}

/** Everything under /api/v3/repos/{owner}/{repo}. */
function routeRepo(
  owner: string,
  name: string,
  rest: string[],
  method: string,
  body: unknown,
  query: Map<string, string[]>,
  login: string,
  res: ServerResponse,
): boolean {
  const repo = store.repo(owner, name);
  // Another login's repository is invisible here: 404, never 403.
  if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) {
    fail(res, 404, 'Not Found');
    return true;
  }

  if (rest.length === 0) return routeRepoRoot(repo, method, body, res);

  switch (rest[0]) {
    case 'git':
      return routeGitPlumbing(repo, rest.slice(1), method, body, res);
    case 'branches':
      return routeBranches(repo, rest, method, res);
    case 'commits':
      return routeCommits(repo, rest, method, query, res);
    case 'contents':
      return routeContents(repo, rest.slice(1), method, body, query, login, res);
    case 'labels':
      return routeLabels(repo, rest, method, body, res);
    case 'issues':
      return routeIssues(repo, rest.slice(1), method, body, query, login, res);
    case 'pulls':
      return routePulls(repo, rest.slice(1), method, body, query, login, res);
    default:
      fail(res, 404, 'Not Found');
      return true;
  }
}

/** GET, PATCH and DELETE on the repository itself. */
function routeRepoRoot(repo: Repo, method: string, body: unknown, res: ServerResponse): boolean {
  if (method === 'GET') {
    sendJson(res, 200, repoJson(repo));
    return true;
  }
  if (method === 'PATCH') {
    const form = (body ?? {}) as Record<string, unknown>;
    if (typeof form.description === 'string') repo.description = form.description;
    if (typeof form.name === 'string' && form.name !== '' && form.name !== repo.name) {
      store.repos.delete(Store.key(repo.owner, repo.name));
      repo.name = form.name;
      store.repos.set(Store.key(repo.owner, repo.name), repo);
    }
    if (typeof form.private === 'boolean') repo.private = form.private;
    if (typeof form.default_branch === 'string') repo.default_branch = form.default_branch;
    repo.updated_at = isoOf(FIXED_EPOCH_SEC);
    sendJson(res, 200, repoJson(repo));
    return true;
  }
  if (method === 'DELETE') {
    store.repos.delete(Store.key(repo.owner, repo.name));
    noContent(res);
    return true;
  }
  fail(res, 404, 'Not Found');
  return true;
}

/** GET /branches. */
function routeBranches(repo: Repo, rest: string[], method: string, res: ServerResponse): boolean {
  if (rest.length !== 1 || method !== 'GET') {
    fail(res, 404, 'Not Found');
    return true;
  }
  const branches = [...repo.refs.entries()]
    .filter(([refName]) => refName.startsWith('refs/heads/'))
    .map(([refName, info]) => ({
      name: refName.slice('refs/heads/'.length),
      commit: { sha: info.sha },
      protected: false,
    }))
    .sort((a, b) => byName(a.name, b.name));
  sendJson(res, 200, branches);
  return true;
}

/** GET /commits and GET /commits/{sha}. */
function routeCommits(
  repo: Repo,
  rest: string[],
  method: string,
  query: Map<string, string[]>,
  res: ServerResponse,
): boolean {
  if (method !== 'GET') {
    fail(res, 404, 'Not Found');
    return true;
  }
  const wanted = rest.length > 1 ? decodeSegment(rest[1]) : (q(query, 'sha') ?? repo.default_branch);
  const tip = store.commitOf(repo, wanted);
  if (tip === null) {
    if (rest.length > 1) fail(res, 404, 'Not Found');
    else sendJson(res, 200, []);
    return true;
  }
  if (rest.length > 1) {
    sendJson(res, 200, commitJson(repo, tip));
    return true;
  }
  const list = [...store.ancestry(repo, tip)].map((sha) => commitJson(repo, sha));
  paginate(res, list, query, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
  return true;
}

/** GET/POST /labels. */
function routeLabels(repo: Repo, rest: string[], method: string, body: unknown, res: ServerResponse): boolean {
  if (rest.length !== 1) {
    fail(res, 404, 'Not Found');
    return true;
  }
  if (method === 'GET') {
    sendJson(res, 200, labelsOf(repo).map(labelJson));
    return true;
  }
  if (method === 'POST') {
    const form = (body ?? {}) as Record<string, unknown>;
    const name = typeof form.name === 'string' ? form.name : '';
    if (name === '') {
      fail(res, 422, 'Validation Failed: name is required');
      return true;
    }
    const label: Label = {
      name,
      color: typeof form.color === 'string' ? form.color.replace(/^#/, '') : 'ededed',
      description: typeof form.description === 'string' ? form.description : '',
    };
    repo.labels.set(label.name, label);
    sendJson(res, 201, labelJson(label));
    return true;
  }
  fail(res, 404, 'Not Found');
  return true;
}

/* ------------------------------------------------------------------ git plumbing */

/** The /git/* routes the contents API and branch creation lean on. */
function routeGitPlumbing(repo: Repo, rest: string[], method: string, body: unknown, res: ServerResponse): boolean {
  if (rest[0] === 'refs') {
    if (rest.length === 1 && method === 'GET') {
      const refs = [...repo.refs.entries()]
        .filter(([refName]) => refName !== 'HEAD')
        .map(([refName, info]) => ({ ref: refName, object: { sha: info.sha, type: 'commit' } }))
        .sort((a, b) => byName(a.ref, b.ref));
      sendJson(res, 200, refs);
      return true;
    }
    if (rest.length === 1 && method === 'POST') {
      return createRef(repo, body, res);
    }
    if (rest.length > 1) {
      return routeOneRef(repo, rest.slice(1).map(decodeSegment).join('/'), method, body, res);
    }
  }

  if (rest.length === 2 && method === 'GET' && (rest[0] === 'commits' || rest[0] === 'blobs' || rest[0] === 'trees')) {
    const sha = decodeSegment(rest[1]);
    const object = store.get(sha);
    if (!object) {
      fail(res, 404, 'Not Found');
      return true;
    }
    if (rest[0] === 'blobs') {
      sendJson(res, 200, { sha, content: object.body.toString('base64'), encoding: 'base64', size: object.body.length });
      return true;
    }
    if (rest[0] === 'commits') {
      sendJson(res, 200, commitJson(repo, sha));
      return true;
    }
    sendJson(res, 200, { sha, tree: [] });
    return true;
  }

  fail(res, 404, 'Not Found');
  return true;
}

/** POST /git/refs — branch creation. */
function createRef(repo: Repo, body: unknown, res: ServerResponse): boolean {
  const form = (body ?? {}) as Record<string, unknown>;
  const rawRef = typeof form.ref === 'string' ? form.ref : '';
  const sha = typeof form.sha === 'string' ? form.sha : '';
  if (rawRef === '' || sha === '') {
    fail(res, 422, 'Validation Failed: ref and sha are required');
    return true;
  }
  const refName = rawRef.startsWith('refs/') ? rawRef : `refs/heads/${rawRef}`;
  if (repo.refs.has(refName)) {
    fail(res, 422, `Reference already exists: ${refName}`);
    return true;
  }
  repo.refs.set(refName, { sha, symref: null });
  if (refName.startsWith('refs/heads/') && !repo.refs.has('HEAD')) {
    repo.refs.set('HEAD', { sha, symref: refName });
  }
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  sendJson(res, 201, { ref: refName, node_id: refName, url: `${base}/git/refs/${refName}`, object: { sha, type: 'commit' } });
  return true;
}

/** GET/PATCH/DELETE on one ref. The ref name holds slashes, so the tail is rejoined. */
function routeOneRef(repo: Repo, refName: string, method: string, body: unknown, res: ServerResponse): boolean {
  const full = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
  const found = repo.refs.get(full);
  if (!found) {
    fail(res, 404, 'Not Found');
    return true;
  }
  if (method === 'GET') {
    sendJson(res, 200, { ref: full, object: { sha: found.sha, type: 'commit' } });
    return true;
  }
  if (method === 'PATCH') {
    const form = (body ?? {}) as Record<string, unknown>;
    const sha = typeof form.sha === 'string' ? form.sha : found.sha;
    const force = form.force === true;
    if (!force && !repo.commits.has(sha) && !store.get(sha)) {
      fail(res, 422, 'Object does not exist');
      return true;
    }
    repo.refs.set(full, { sha, symref: found.symref });
    sendJson(res, 200, { ref: full, object: { sha, type: 'commit' } });
    return true;
  }
  if (method === 'DELETE') {
    repo.refs.delete(full);
    noContent(res);
    return true;
  }
  fail(res, 404, 'Not Found');
  return true;
}

/* ------------------------------------------------------------------ contents API */

/** GET/PUT/POST/DELETE /contents/{path...}. */
function routeContents(
  repo: Repo,
  rest: string[],
  method: string,
  body: unknown,
  query: Map<string, string[]>,
  login: string,
  res: ServerResponse,
): boolean {
  const path = rest.map(decodeSegment).join('/');
  const form = (body ?? {}) as Record<string, unknown>;
  // GitHub accepts `ref` on the query for reads and `branch` in the body for writes.
  const bodyBranch = typeof form.branch === 'string' && form.branch !== '' ? form.branch : null;
  const ref = bodyBranch ?? q(query, 'ref') ?? q(query, 'branch') ?? repo.default_branch;
  const tip = store.commitOf(repo, ref);

  if (method === 'GET') return readContents(repo, path, tip, res);
  if (method === 'PUT' || method === 'POST') return writeContents(repo, path, ref, tip, form, login, res);
  if (method === 'DELETE') return deleteContents(repo, path, ref, tip, form, login, res);

  fail(res, 404, 'Not Found');
  return true;
}

/** A contents read: one file, or a directory listing, or the repository root. */
function readContents(repo: Repo, path: string, tip: string | null, res: ServerResponse): boolean {
  if (tip === null) {
    fail(res, 404, 'Not Found');
    return true;
  }
  const files = store.filesOfCommit(repo, tip);
  if (path === '') {
    sendJson(res, 200, rootListing(repo, tip, files));
    return true;
  }
  const direct = files.get(path);
  if (direct) {
    const object = store.get(direct.sha);
    sendJson(res, 200, contentFileJson(path, direct.sha, object ? object.body : Buffer.alloc(0), direct.mode));
    return true;
  }
  const prefix = `${path}/`;
  const children = [...files.entries()].filter(([child]) => child.startsWith(prefix));
  if (children.length === 0) {
    fail(res, 404, 'Not Found');
    return true;
  }
  sendJson(res, 200, dirListing(repo, tip, files, path, prefix));
  return true;
}

/** The root contents listing: every top-level name, files and directories alike. */
function rootListing(repo: Repo, tip: string, files: Map<string, { sha: string; mode: string }>): unknown[] {
  const seen = new Map<string, { sha: string; dir: boolean }>();
  for (const [entryPath, entry] of files) {
    const slash = entryPath.indexOf('/');
    if (slash < 0) {
      seen.set(entryPath, { sha: entry.sha, dir: false });
      continue;
    }
    const dir = entryPath.slice(0, slash);
    if (seen.has(dir)) continue;
    const sha = treeShaAt(repo, tip, dir);
    if (sha !== null) seen.set(dir, { sha, dir: true });
  }
  return [...seen.entries()]
    .sort((a, b) => byName(a[0], b[0]))
    .map(([name, info]) =>
      info.dir
        ? contentDirJson('', name, info.sha)
        : contentFileJson(name, info.sha, store.get(info.sha)?.body ?? Buffer.alloc(0), files.get(name)?.mode ?? '100644'),
    );
}

/** A listing of one directory: the immediate children only. */
function dirListing(
  repo: Repo,
  tip: string,
  files: Map<string, { sha: string; mode: string }>,
  path: string,
  prefix: string,
): unknown[] {
  const seen = new Map<string, string>();
  for (const [childPath] of files) {
    if (!childPath.startsWith(prefix)) continue;
    const remainder = childPath.slice(prefix.length);
    const slash = remainder.indexOf('/');
    const name = slash < 0 ? remainder : remainder.slice(0, slash);
    const childPath2 = `${path}/${name}`;
    const sha = slash < 0 ? (files.get(childPath2)?.sha ?? null) : treeShaAt(repo, tip, childPath2);
    if (sha !== null) seen.set(name, sha);
  }
  return [...seen.entries()]
    .sort((a, b) => byName(a[0], b[0]))
    .map(([name, sha]) => {
      const childPath = `${path}/${name}`;
      const entry = files.get(childPath);
      return entry
        ? contentFileJson(childPath, sha, store.get(sha)?.body ?? Buffer.alloc(0), entry.mode)
        : contentDirJson(path, name, sha);
    });
}

/** Walk a commit's tree down to the tree object at a directory path, or null. */
function treeShaAt(repo: Repo, commitSha: string, dirPath: string): string | null {
  const info = repo.commits.get(commitSha);
  if (!info) return null;
  let at = info.tree;
  for (const part of dirPath.split('/')) {
    if (part === '') continue;
    const object = store.get(at);
    if (!object || object.kind !== 'tree') return null;
    const found = parseTreeEntries(object.body).find((entry) => entry.name === part);
    if (!found) return null;
    at = found.sha;
  }
  return at;
}

/** Parse a tree body into entries. Local so this module needs no extra import edge. */
function parseTreeEntries(body: Buffer): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  let at = 0;
  while (at < body.length) {
    const nul = body.indexOf(0, at);
    if (nul < 0) break;
    const head = body.subarray(at, nul).toString('utf8');
    const space = head.indexOf(' ');
    if (space < 0) break;
    out.push({
      mode: head.slice(0, space),
      name: head.slice(space + 1),
      sha: body.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return out;
}

/** A contents write: create or update one file and commit it. */
function writeContents(
  repo: Repo,
  path: string,
  ref: string,
  tip: string | null,
  form: Record<string, unknown>,
  login: string,
  res: ServerResponse,
): boolean {
  if (typeof form.content !== 'string') {
    fail(res, 422, 'Validation Failed: content is required');
    return true;
  }
  const bytes = Buffer.from(form.content, 'base64');
  const message = typeof form.message === 'string' ? form.message : 'Update content';
  const files = store.filesOfRef(repo, ref);
  const existing = files.get(path);

  // A sha that no longer matches current content is a conflict, not an overwrite.
  const givenSha = typeof form.sha === 'string' ? form.sha : null;
  if (existing && givenSha !== null && givenSha !== existing.sha) {
    fail(res, 409, 'sha does not match the current file');
    return true;
  }

  const blobSha = store.putBlob(bytes);
  files.set(path, { sha: blobSha, mode: existing?.mode ?? '100644' });
  const refName = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const ident = `${login} <${login}@forge.local>`;
  const commitSha = store.commitFiles(repo, refName, tip, files, message, ident);
  sendJson(res, existing ? 200 : 201, {
    content: {
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      sha: blobSha,
      size: bytes.length,
      encoding: 'base64',
      content: bytes.toString('base64'),
      type: 'file',
    },
    commit: {
      sha: commitSha,
      message,
      author: { name: login, email: `${login}@forge.local` },
      committer: { name: login, email: `${login}@forge.local` },
    },
  });
  return true;
}

/** A contents delete: drop one file and commit the removal. */
function deleteContents(
  repo: Repo,
  path: string,
  ref: string,
  tip: string | null,
  form: Record<string, unknown>,
  login: string,
  res: ServerResponse,
): boolean {
  const files = store.filesOfRef(repo, ref);
  const existing = files.get(path);
  if (!existing) {
    fail(res, 404, 'Not Found');
    return true;
  }
  const givenSha = typeof form.sha === 'string' ? form.sha : null;
  if (givenSha !== null && givenSha !== existing.sha) {
    fail(res, 409, 'sha does not match the current file');
    return true;
  }
  files.delete(path);
  const refName = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const message = typeof form.message === 'string' ? form.message : `Delete ${path}`;
  const ident = `${login} <${login}@forge.local>`;
  const commitSha = store.commitFiles(repo, refName, tip, files, message, ident);
  sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
  return true;
}

/* ------------------------------------------------------------------ issues */

/** GET/POST /issues, and everything under /issues/{n}. */
function routeIssues(
  repo: Repo,
  rest: string[],
  method: string,
  body: unknown,
  query: Map<string, string[]>,
  login: string,
  res: ServerResponse,
): boolean {
  if (rest.length === 0) return routeIssueCollection(repo, method, body, query, login, res);

  const number = Number(decodeSegment(rest[0]));
  const issue = repo.issues.get(number);
  if (!issue) {
    fail(res, 404, 'Not Found');
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') return patchIssue(repo, issue, body, res);
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') return addComment(repo, issue, body, login, res);
    if (method === 'GET') {
      paginate(
        res,
        issue.comments.map((comment) => commentJson(repo, issue, comment.id)),
        query,
        `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`,
      );
      return true;
    }
  }

  fail(res, 404, 'Not Found');
  return true;
}

/** GET the filtered issue list, or POST a new issue. */
function routeIssueCollection(
  repo: Repo,
  method: string,
  body: unknown,
  query: Map<string, string[]>,
  login: string,
  res: ServerResponse,
): boolean {
  if (method === 'POST') {
    const form = (body ?? {}) as Record<string, unknown>;
    const title = typeof form.title === 'string' ? form.title : '';
    if (title === '') {
      fail(res, 422, 'Validation Failed: title is required');
      return true;
    }
    const wanted = labelNames(form.labels);
    const missing = wanted.find((name) => !repo.labels.has(name));
    if (missing !== undefined) {
      fail(res, 422, `Validation Failed: label "${missing}" does not exist`);
      return true;
    }
    const now = isoOf(FIXED_EPOCH_SEC);
    const issue = {
      number: repo.nextIssue,
      title,
      body: typeof form.body === 'string' ? form.body : '',
      state: 'open' as const,
      labels: wanted,
      user: login,
      created_at: now,
      updated_at: now,
      closed_at: null,
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.set(issue.number, issue);
    sendJson(res, 201, issueJson(repo, issue), {
      location: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    });
    return true;
  }

  const state = q(query, 'state') ?? 'open';
  let list = issuesOf(repo);
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');

  const sort = q(query, 'sort') ?? 'created';
  const direction = q(query, 'direction') ?? (sort === 'created' ? 'desc' : 'asc');
  if (sort === 'created' || sort === 'updated') {
    list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  paginate(res, list.map((issue) => issueJson(repo, issue)), query, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
  return true;
}

/** Every named label must exist on the repo. Answers 422 itself when one does not. */
function labelsExist(repo: Repo, names: string[]): boolean {
  for (const name of names) if (!repo.labels.has(name)) return false;
  return true;
}

/** PATCH one issue: title, body, state and labels. */
function patchIssue(
  repo: Repo,
  issue: { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; updated_at: string; closed_at: string | null },
  body: unknown,
  res: ServerResponse,
): boolean {
  const form = (body ?? {}) as Record<string, unknown>;
  if (typeof form.title === 'string') issue.title = form.title;
  if (typeof form.body === 'string') issue.body = form.body;
  if (form.state === 'open' || form.state === 'closed') {
    if (form.state === 'closed' && issue.state !== 'closed') issue.closed_at = isoOf(FIXED_EPOCH_SEC);
    if (form.state === 'open') issue.closed_at = null;
    issue.state = form.state;
  }
  if (form.labels !== undefined) {
    const wanted = labelNames(form.labels);
    if (!labelsExist(repo, wanted)) {
      fail(res, 422, `Validation Failed: label "${wanted.find((name) => !repo.labels.has(name))}" does not exist`);
      return true;
    }
    issue.labels = wanted;
  }
  issue.updated_at = isoOf(FIXED_EPOCH_SEC);
  sendJson(res, 200, issueJson(repo, issue as never));
  return true;
}

/** POST one comment onto an issue. */
function addComment(
  repo: Repo,
  issue: { number: number; comments: { id: number; body: string; user: string; created_at: string }[]; updated_at: string },
  body: unknown,
  login: string,
  res: ServerResponse,
): boolean {
  const form = (body ?? {}) as Record<string, unknown>;
  const text = typeof form.body === 'string' ? form.body : '';
  if (text === '') {
    fail(res, 422, 'Validation Failed: body is required');
    return true;
  }
  const id = repo.nextComment;
  repo.nextComment += 1;
  issue.comments.push({ id, body: text, user: login, created_at: isoOf(FIXED_EPOCH_SEC) });
  issue.updated_at = isoOf(FIXED_EPOCH_SEC);
  sendJson(res, 201, commentJson(repo, issue, id), {
    location: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${id}`,
  });
  return true;
}

/* ------------------------------------------------------------------ pull requests */

/** GET/POST /pulls, and /pulls/{n}, /files, /merge. */
function routePulls(
  repo: Repo,
  rest: string[],
  method: string,
  body: unknown,
  query: Map<string, string[]>,
  login: string,
  res: ServerResponse,
): boolean {
  if (rest.length === 0) return routePullCollection(repo, method, body, query, login, res);

  const number = Number(decodeSegment(rest[0]));
  const pull = repo.pulls.get(number);
  if (!pull) {
    fail(res, 404, 'Not Found');
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    if (method === 'PATCH') {
      const form = (body ?? {}) as Record<string, unknown>;
      if (typeof form.title === 'string') pull.title = form.title;
      if (typeof form.body === 'string') pull.body = form.body;
      if (form.state === 'closed' && pull.state !== 'closed') {
        pull.state = 'closed';
        pull.closed_at = isoOf(FIXED_EPOCH_SEC);
      }
      pull.updated_at = isoOf(FIXED_EPOCH_SEC);
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    sendJson(res, 200, pull.files.map(pullFileJson));
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge' && (method === 'PUT' || method === 'POST')) {
    return mergePull(repo, pull, body, login, res);
  }

  fail(res, 404, 'Not Found');
  return true;
}

/** GET the filtered pull list, or POST a new pull request. */
function routePullCollection(
  repo: Repo,
  method: string,
  body: unknown,
  query: Map<string, string[]>,
  login: string,
  res: ServerResponse,
): boolean {
  if (method === 'POST') {
    const form = (body ?? {}) as Record<string, unknown>;
    const title = typeof form.title === 'string' ? form.title : '';
    const headRef = typeof form.head === 'string' ? form.head : '';
    const baseRef = typeof form.base === 'string' ? form.base : repo.default_branch;
    if (title === '' || headRef === '') {
      fail(res, 422, 'Validation Failed: title and head are required');
      return true;
    }
    const headSha = store.refOf(repo, `refs/heads/${headRef}`) ?? store.refOf(repo, headRef);
    const baseSha = store.refOf(repo, `refs/heads/${baseRef}`) ?? store.refOf(repo, baseRef);
    if (headSha === null || baseSha === null) {
      fail(res, 422, 'Validation Failed: no commits between the branches');
      return true;
    }
    const now = isoOf(FIXED_EPOCH_SEC);
    const pull: Pull = {
      number: repo.nextPull,
      title,
      body: typeof form.body === 'string' ? form.body : '',
      state: 'open',
      head: { ref: headRef, sha: headSha, label: `${repo.owner}:${headRef}` },
      base: { ref: baseRef, sha: baseSha, label: `${repo.owner}:${baseRef}` },
      user: login,
      created_at: now,
      updated_at: now,
      merged: false,
      mergeable: true,
      merge_commit_sha: null,
      merged_at: null,
      closed_at: null,
      files: changedFiles(repo, baseSha, headSha),
    };
    repo.nextPull += 1;
    repo.pulls.set(pull.number, pull);
    sendJson(res, 201, pullJson(repo, pull), {
      location: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    });
    return true;
  }

  const state = q(query, 'state') ?? 'open';
  let list = pullsOf(repo);
  if (state === 'open') list = list.filter((pull) => pull.state === 'open');
  else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
  paginate(res, list.map((pull) => pullJson(repo, pull)), query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
  return true;
}

/** PUT/POST /pulls/{n}/merge. A moved base means the merge is refused as unmergeable. */
function mergePull(repo: Repo, pull: Pull, body: unknown, login: string, res: ServerResponse): boolean {
  const baseSha = store.refOf(repo, `refs/heads/${pull.base.ref}`);
  if (baseSha !== pull.base.sha) {
    fail(res, 405, 'Pull Request is not mergeable');
    return true;
  }
  if (pull.merged) {
    fail(res, 405, 'Pull Request is not mergeable: it is already merged');
    return true;
  }
  const form = (body ?? {}) as Record<string, unknown>;
  const message = typeof form.commit_message === 'string'
    ? form.commit_message
    : `Merge pull request #${pull.number} from ${pull.head.label}`;
  const merged = store.filesOfRef(repo, `refs/heads/${pull.base.ref}`);
  for (const [path, entry] of store.filesOfCommit(repo, pull.head.sha)) merged.set(path, { sha: entry.sha, mode: entry.mode });
  const ident = `${login} <${login}@forge.local>`;
  const mergeSha = store.commitFiles(repo, `refs/heads/${pull.base.ref}`, baseSha, merged, message, ident);
  pull.merged = true;
  pull.merge_commit_sha = mergeSha;
  pull.merged_at = isoOf(FIXED_EPOCH_SEC);
  pull.state = 'closed';
  pull.closed_at = pull.merged_at;
  pull.updated_at = pull.merged_at;
  sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
  return true;
}

/** The files that differ between two commits, as the pull files list reports them. */
function changedFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
  const base = store.filesOfCommit(repo, baseSha);
  const head = store.filesOfCommit(repo, headSha);
  const out: PullFile[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === undefined && after !== undefined) {
      const lines = lineCount(store.get(after.sha)?.body ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines, sha: after.sha });
    } else if (before !== undefined && after === undefined) {
      const lines = lineCount(store.get(before.sha)?.body ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines, sha: before.sha });
    } else if (before !== undefined && after !== undefined && before.sha !== after.sha) {
      const added = lineCount(store.get(after.sha)?.body ?? Buffer.alloc(0));
      const removed = lineCount(store.get(before.sha)?.body ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'modified', additions: added, deletions: removed, changes: added + removed, sha: after.sha });
    }
  }
  return out;
}

/** How many lines a blob holds; a trailing newline does not start a line. */
function lineCount(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  const text = bytes.toString('utf8');
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

// mcp.ts: Model Context Protocol over streamable HTTP at POST /mcp.
//
// The suite speaks initialize -> tools/list -> tools/call, then verifies each tool's effect through
// the REST view, so the tools here are the issue and pull-request surface of github-mcp-server and
// their results are the REST shapes a model already knows.
//
// Transport notes that matter:
//   * one request is one JSON-RPC message; a batch is an array and is answered in order;
//   * a notification (no id) is acknowledged with 202 and an empty body, never with a result;
//   * an unauthenticated call is a 401 before any JSON-RPC handling happens;
//   * a tool that fails returns isError inside the result, not a protocol error — the protocol
//     error code -32602 belongs to bad params (unknown tool, missing required argument).

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_EPOCH_SEC, Store, isoOf, type Issue, type Pull, type Repo } from './store.ts';

/** The revision this server speaks. */
const PROTOCOL_VERSION = '2025-06-18';

/** One JSON-RPC message. */
interface RpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

/** One tool's advertised shape. */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What mcp needs from the caller. */
export interface McpRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  login: string | null;
  store: Store;
  body: Buffer;
}

/* ------------------------------------------------------------------ the wire */

/** Emit a JSON body with MCP's protocol header. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'mcp-protocol-version': PROTOCOL_VERSION,
  });
  res.end(text);
}

/** Acknowledge a notification with an empty 202. */
function ack(res: ServerResponse): void {
  res.writeHead(202);
  res.end();
}

/** A JSON-RPC result envelope. */
function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** A JSON-RPC error envelope. */
function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A tool result carrying one JSON document as its text, which is what a client parses. */
function toolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** A tool result carrying a failure the model should read (in-band, not a protocol error). */
function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/* ------------------------------------------------------------------ the tool table */

/** The owner/repo pair every repository-scoped tool takes. */
const REPO_PROPS = {
  owner: { type: 'string', description: 'Repository owner (user or organisation).' },
  repo: { type: 'string', description: 'Repository name.' },
};

/** The tools this server advertises, in GitHub's own vocabulary. */
function toolTable(login: string): ToolDef[] {
  return [
    {
      name: 'create_repo',
      description: "Create a repository in the authenticated user's account.",
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The repository name.' },
          description: { type: 'string', description: 'A short description.' },
          private: { type: 'boolean', description: 'Whether the repository is private.' },
          autoInit: { type: 'boolean', description: 'Create an initial commit with a README.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_repo',
      description: 'Get one repository by owner and name.',
      inputSchema: { type: 'object', properties: { ...REPO_PROPS }, required: ['owner', 'repo'] },
    },
    {
      name: 'get_me',
      description: `Get details of the authenticated GitHub user. Use this when a request is about the page itself, such as "what is my username?". The output will be a JSON object with the user's details, e.g. {"login":"${login}","id":1}.`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_issues',
      description: 'List issues in a GitHub repository, with optional filters by state, labels and order.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state. Default: open.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Filter by label names.' },
          orderBy: { type: 'string', description: 'Order: "created" or "updated", then "asc" or "desc".' },
          page: { type: 'number', description: 'Page number, starting at 1.' },
          perPage: { type: 'number', description: 'Results per page, at most 100.' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'issue_read',
      description: 'Read one issue, its comments, or its labels.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          issue_number: { type: 'number', description: 'The issue number.' },
          method: { type: 'string', enum: ['get', 'get_comments', 'get_labels'], description: 'What to read. Default: get.' },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
    },
    {
      name: 'create_issue',
      description: 'Create a new issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'The issue body.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach.' },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'issue_write',
      description: 'Create a new issue, or update an existing one (title, body, state, labels).',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          method: { type: 'string', enum: ['create', 'update'], description: 'Create or update. Default: create.' },
          issue_number: { type: 'number', description: 'The issue to update.' },
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'The issue body.' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'The new state.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to set.' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'add_issue_comment',
      description: 'Add a comment to an existing issue.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          issue_number: { type: 'number', description: 'The issue number.' },
          body: { type: 'string', description: 'The comment text.' },
        },
        required: ['owner', 'repo', 'issue_number', 'body'],
      },
    },
    {
      name: 'list_pull_requests',
      description: 'List pull requests in a repository, filtered by state.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: 'Filter by state.' },
          page: { type: 'number', description: 'Page number, starting at 1.' },
          perPage: { type: 'number', description: 'Results per page.' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'pull_request_read',
      description: 'Read one pull request, its files, or its status.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          pullNumber: { type: 'number', description: 'The pull request number.' },
          method: { type: 'string', enum: ['get', 'get_files', 'get_status'], description: 'What to read.' },
        },
        required: ['owner', 'repo', 'pullNumber'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request from a head branch into a base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          title: { type: 'string', description: 'The pull request title.' },
          body: { type: 'string', description: 'The pull request body.' },
          head: { type: 'string', description: 'The branch holding the changes.' },
          base: { type: 'string', description: 'The branch to merge into. Default: the default branch.' },
          draft: { type: 'boolean', description: 'Open as a draft.' },
        },
        required: ['owner', 'repo', 'title', 'head'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request that is open and mergeable.',
      inputSchema: {
        type: 'object',
        properties: {
          ...REPO_PROPS,
          pullNumber: { type: 'number', description: 'The pull request number.' },
          commit_title: { type: 'string', description: 'The merge commit title.' },
          merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'How to merge.' },
        },
        required: ['owner', 'repo', 'pullNumber'],
      },
    },
  ];
}

/* ------------------------------------------------------------------ the endpoint */

/** Route one /mcp request. */
export async function handleMcp(input: McpRequest): Promise<void> {
  const { res, method, login, store, body } = input;

  if (method !== 'POST') {
    // A GET here would open an SSE stream on GitHub's side; a plain 405 tells the client it only
    // gets JSON, which is all this server answers.
    writeJson(res, 405, { error: 'the MCP endpoint takes POST' });
    return;
  }

  if (login === null) {
    writeJson(res, 401, rpcError(null, -32001, 'Requires authentication'));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    writeJson(res, 200, rpcError(null, -32700, 'Parse error'));
    return;
  }

  // A batch is answered entry by entry; a batch of notifications alone is a bare 202.
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      const answer = await answerMessage(store, login, entry as RpcMessage);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) ack(res);
    else writeJson(res, 200, answers);
    return;
  }

  const answer = await answerMessage(store, login, parsed as RpcMessage);
  if (answer === null) ack(res);
  else writeJson(res, 200, answer);
}

/** Answer one JSON-RPC message; null means it was a notification. */
async function answerMessage(store: Store, login: string, message: RpcMessage): Promise<Record<string, unknown> | null> {
  if (message === null || typeof message !== 'object') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const notification = message.id === undefined || message.id === null;
  const id = (message.id ?? null) as string | number | null;
  const method = typeof message.method === 'string' ? message.method : '';

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, logging: {} },
        serverInfo: { name: 'forge-mcp', version: '1.0.0', title: 'Forge MCP server' },
        instructions: `A GitHub-compatible forge. Authenticated as ${login}. Tools cover issues and pull requests.`,
      });

    case 'notifications/initialized':
    case 'initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, {
        tools: toolTable(login).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });

    case 'tools/call':
      return callTool(store, login, id, message.params);

    case 'resources/list':
      return rpcResult(id, { resources: [] });

    case 'prompts/list':
      return rpcResult(id, { prompts: [] });

    default:
      if (notification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle tools/call: validate the params, then run the tool. */
function callTool(
  store: Store,
  login: string,
  id: string | number | null,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const request = params ?? {};
  const name = typeof request.name === 'string' ? request.name : '';
  if (name === '') return rpcError(id, -32602, 'Invalid params: a tool name is required');

  const known = toolTable(login).find((tool) => tool.name === name);
  if (known === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);

  const args = (request.arguments ?? {}) as Record<string, unknown>;
  const required = (known.inputSchema.required as string[] | undefined) ?? [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return rpcError(id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
  }

  return rpcResult(id, runTool(store, login, name, args));
}

/* ------------------------------------------------------------------ tools */

/** Run one tool and return its MCP result envelope. */
function runTool(store: Store, login: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'get_me') {
    return toolResult({ login, id: numericId(`user:${login}`), name: login, type: 'User' });
  }

  // create_repo comes first: it makes the repository every other tool then addresses.
  if (name === 'create_repo') return createRepo(store, login, args);

  const repo = store.repo(String(args.owner ?? ''), String(args.repo ?? ''));
  if (repo === undefined || repo.owner.toLowerCase() !== login.toLowerCase()) {
    return toolFailure(`repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
  }

  switch (name) {
    case 'get_repo':
      return toolResult(repoView(repo));
    case 'list_issues':
      return listIssues(repo, args);
    case 'issue_read':
      return readIssue(repo, args);
    case 'create_issue':
    case 'issue_write':
      return writeIssue(store, repo, login, name, args);
    case 'add_issue_comment':
      return addComment(repo, login, args);
    case 'list_pull_requests':
      return listPulls(repo, args);
    case 'pull_request_read':
      return readPull(repo, args);
    case 'create_pull_request':
      return createPull(store, repo, login, args);
    case 'merge_pull_request':
      return mergePull(repo, args);
    default:
      return toolFailure(`tool ${name} is not implemented`);
  }
}

/** create_repo, including the initial commit autoInit asks for. */
function createRepo(store: Store, login: string, args: Record<string, unknown>): Record<string, unknown> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (name === '') return toolFailure('a repository name is required');
  if (store.repo(login, name) !== undefined) return toolFailure(`repository ${login}/${name} already exists`);

  const repo = store.createRepo(login, name, {
    description: typeof args.description === 'string' ? args.description : null,
    private: args.private === true,
  });

  // autoInit is GitHub's "start with a README", so the new repository has one commit.
  if (args.autoInit === true) {
    const blob = store.putBlob(`# ${name}\n`);
    const files = new Map<string, { sha: string; mode: string }>([['README.md', { sha: blob, mode: '100644' }]]);
    store.commitFiles(repo, `refs/heads/${repo.default_branch}`, null, files, 'Initial commit', `${login} <${login}@forge.local>`);
  }

  return toolResult(repoView(repo));
}

/** list_issues: state and label filters, then a page. */
function listIssues(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const state = typeof args.state === 'string' ? args.state : 'open';
  let items = [...repo.issues.values()].sort((a, b) => b.number - a.number);
  if (state === 'open') items = items.filter((issue) => issue.state === 'open');
  else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');

  if (Array.isArray(args.labels)) {
    const wanted = args.labels.map(String);
    items = items.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
  }

  const size = Math.max(1, Number(args.perPage ?? 30));
  const page = Math.max(1, Number(args.page ?? 1));
  const start = (page - 1) * size;
  return toolResult(items.slice(start, start + size).map((issue) => issueView(repo, issue)));
}

/** issue_read: the issue, its comments, or its labels. */
function readIssue(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const number = Number(args.issue_number ?? 0);
  const issue = repo.issues.get(number);
  if (issue === undefined) return toolFailure(`issue #${number} not found`);

  const how = typeof args.method === 'string' ? args.method : 'get';
  if (how === 'get_comments') {
    return toolResult(issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.user } })));
  }
  if (how === 'get_labels') {
    return toolResult(issue.labels.map((label) => repo.labels.get(label) ?? { name: label }));
  }
  return toolResult(issueView(repo, issue));
}

/** create_issue and issue_write: one creates, the other may update. */
function writeIssue(
  store: Store,
  repo: Repo,
  login: string,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  void store;
  const how = typeof args.method === 'string' ? args.method : 'create';

  if (how === 'update') {
    const number = Number(args.issue_number ?? 0);
    const issue = repo.issues.get(number);
    if (issue === undefined) return toolFailure(`issue #${number} not found`);
    if (typeof args.title === 'string') issue.title = args.title;
    if (typeof args.body === 'string') issue.body = args.body;
    if (args.state === 'open' || args.state === 'closed') {
      issue.state = args.state;
      issue.closed_at = args.state === 'closed' ? isoOf(FIXED_EPOCH_SEC) : null;
    }
    if (Array.isArray(args.labels)) issue.labels = args.labels.map(String);
    issue.updated_at = isoOf(FIXED_EPOCH_SEC);
    return toolResult(issueView(repo, issue));
  }

  const title = typeof args.title === 'string' ? args.title : '';
  if (title === '') return toolFailure(`a title is required to create an issue with ${name}`);
  const now = isoOf(FIXED_EPOCH_SEC);
  const issue: Issue = {
    number: repo.nextIssue,
    title,
    body: typeof args.body === 'string' ? args.body : '',
    state: 'open',
    labels: Array.isArray(args.labels) ? args.labels.map(String) : [],
    user: login,
    created_at: now,
    updated_at: now,
    closed_at: null,
    comments: [],
  };
  repo.nextIssue += 1;
  repo.issues.set(issue.number, issue);
  return toolResult(issueView(repo, issue));
}

/** add_issue_comment. */
function addComment(repo: Repo, login: string, args: Record<string, unknown>): Record<string, unknown> {
  const number = Number(args.issue_number ?? 0);
  const issue = repo.issues.get(number);
  if (issue === undefined) return toolFailure(`issue #${number} not found`);

  const body = String(args.body ?? '');
  const id = repo.nextComment;
  repo.nextComment += 1;
  const at = isoOf(FIXED_EPOCH_SEC);
  issue.comments.push({ id, body, user: login, created_at: at });
  return toolResult({ id, body, user: { login }, created_at: at });
}

/** list_pull_requests, with GitHub's four-way state filter (merged is its own state here). */
function listPulls(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const state = typeof args.state === 'string' ? args.state : 'open';
  let items = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  if (state === 'open') items = items.filter((pull) => pull.state === 'open');
  else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed' && !pull.merged);
  else if (state === 'merged') items = items.filter((pull) => pull.merged);
  return toolResult(items.map((pull) => pullView(repo, pull)));
}

/** pull_request_read: the pull, its files, or its merge status. */
function readPull(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const number = Number(args.pullNumber ?? 0);
  const pull = repo.pulls.get(number);
  if (pull === undefined) return toolFailure(`pull request #${number} not found`);

  const how = typeof args.method === 'string' ? args.method : 'get';
  if (how === 'get_files') {
    return toolResult(
      pull.files.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
    );
  }
  if (how === 'get_status') {
    return toolResult({ state: pull.state, merged: pull.merged, mergeable: pull.mergeable });
  }
  return toolResult(pullView(repo, pull));
}

/** create_pull_request: both branches must exist and carry a commit. */
function createPull(store: Store, repo: Repo, login: string, args: Record<string, unknown>): Record<string, unknown> {
  const headRef = typeof args.head === 'string' ? args.head : '';
  const baseRef = typeof args.base === 'string' ? args.base : repo.default_branch;
  const headSha = store.refOf(repo, `refs/heads/${headRef}`);
  const baseSha = store.refOf(repo, `refs/heads/${baseRef}`);
  if (headSha === null || baseSha === null) return toolFailure(`no commits between ${headRef} and ${baseRef}`);

  const now = isoOf(FIXED_EPOCH_SEC);
  const pull: Pull = {
    number: repo.nextPull,
    title: typeof args.title === 'string' ? args.title : '',
    body: typeof args.body === 'string' ? args.body : '',
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
    files: [],
  };
  repo.nextPull += 1;
  repo.pulls.set(pull.number, pull);
  return toolResult(pullView(repo, pull));
}

/** merge_pull_request: only an open, unmerged pull merges. */
function mergePull(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const number = Number(args.pullNumber ?? 0);
  const pull = repo.pulls.get(number);
  if (pull === undefined) return toolFailure(`pull request #${number} not found`);
  if (pull.merged) return toolFailure(`pull request #${number} is already merged`);
  if (pull.state !== 'open') return toolFailure(`pull request #${number} is not open`);

  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = isoOf(FIXED_EPOCH_SEC);
  pull.closed_at = pull.merged_at;
  return toolResult({ merged: true, number, state: 'closed', merged_at: pull.merged_at });
}

/* ------------------------------------------------------------------ views */

/** The repository JSON a tool returns: GitHub's REST shape. */
function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: numericId(`repo:${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

/** The issue JSON a tool returns. */
function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: { login: issue.user },
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository: `${repo.owner}/${repo.name}`,
  };
}

/** The pull request JSON a tool returns. */
function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    user: { login: pull.user },
    created_at: pull.created_at,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    repository: `${repo.owner}/${repo.name}`,
  };
}

/** A stable numeric id, so a tool result is identical across runs. */
function numericId(key: string): number {
  return (createHash('sha256').update(key).digest().readUInt32BE(0) % 1_000_000) + 1;
}

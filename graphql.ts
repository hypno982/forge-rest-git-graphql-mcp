// graphql.ts: enough of GitHub's GraphQL v4 to answer the documents gh and github-mcp-server
// actually send.
//
// A general GraphQL engine is not what the suite needs: it sends a fixed family of documents, so
// this module does three things — parse the document into a selection tree, bind $variables into
// that tree, then resolve each root field against the same store REST reads.
//
// What has to be exactly right, because the checks read it back:
//   * a global id is base64("<Kind>:<owner>/<repo>#<number>") — splitting the key on '/' leaves
//     "#4" glued to the repo name and every close/merge/addComment then resolves to nothing;
//   * addComment names its subject `subjectId`, not `issueId`;
//   * the Repository projection carries databaseId, viewerPermission, hasIssuesEnabled,
//     visibility, defaultBranchRef and owner, because a client feature-detects on them;
//   * an unknown field is a null in data plus an entry in errors, never a silent null alone;
//   * a batch is a JSON array and is answered with an array, in order;
//   * every reply is 200 with JSON — GraphQL reports its own failures in `errors`.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_EPOCH_SEC, Store, isoOf, type Issue, type Pull, type Repo } from './store.ts';

/* ------------------------------------------------------------------ document model */

/** One error entry, GitHub's shape. */
interface GqlError {
  message: string;
  type: string;
  path?: (string | number)[];
}

/** One selected field: what to resolve, under which key, with which arguments. */
interface Selection {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  children: Selection[];
  /** The argument text exactly as the document held it, for a mutation's inline input object. */
  argText: string;
}

/** A whole parsed document. */
interface Document {
  kind: 'query' | 'mutation' | 'subscription';
  roots: Selection[];
  variableDefaults: Record<string, unknown>;
}

/* ------------------------------------------------------------------ the parser */

/**
 * Walk the document once, collecting what the scanners below need. Keeping one cursor and a small
 * set of helpers is what makes the parser short enough to reason about.
 */
class Scanner {
  text: string;
  at = 0;

  constructor(text: string) {
    this.text = text;
  }

  /** True when the cursor has run out. */
  get done(): boolean {
    return this.at >= this.text.length;
  }

  peek(): string {
    return this.text[this.at] ?? '';
  }

  /** The next character, with any whitespace and comments in front of it already skipped. */
  look(): string {
    this.skipSpace();
    return this.text[this.at] ?? '';
  }

  skipSpace(): void {
    while (this.at < this.text.length) {
      const ch = this.text[this.at];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.at += 1;
        continue;
      }
      // A # comment runs to the end of its line; nothing a # starts inside a string reaches here.
      if (ch === '#') {
        while (this.at < this.text.length && this.text[this.at] !== '\n') this.at += 1;
        continue;
      }
      break;
    }
  }

  /** Consume the character when it is the one expected. */
  take(ch: string): boolean {
    this.skipSpace();
    if (this.peek() !== ch) return false;
    this.at += 1;
    return true;
  }

  /** A name ([A-Za-z_][A-Za-z0-9_]*), or ''. */
  name(): string {
    this.skipSpace();
    const start = this.at;
    while (this.at < this.text.length) {
      const ch = this.text[this.at];
      const ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || (this.at > start && ch >= '0' && ch <= '9');
      if (!ok) break;
      this.at += 1;
    }
    return this.text.slice(start, this.at);
  }

  /** A string literal's value, cursor on the opening quote. */
  quoted(): string {
    this.at += 1;
    let value = '';
    while (this.at < this.text.length && this.text[this.at] !== '"') {
      if (this.text[this.at] === '\\') {
        this.at += 1;
        const esc = this.text[this.at] ?? '';
        value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
        this.at += 1;
        continue;
      }
      value += this.text[this.at];
      this.at += 1;
    }
    this.at += 1;
    return value;
  }

  /** The text between a balanced pair, cursor on the opener; leaves the cursor past the closer. */
  balanced(open: string, close: string): string {
    this.skipSpace();
    if (this.peek() !== open) return '';
    const start = this.at + 1;
    let depth = 0;
    let inString = false;
    while (this.at < this.text.length) {
      const ch = this.text[this.at];
      if (inString) {
        if (ch === '\\') this.at += 1;
        else if (ch === '"') inString = false;
        this.at += 1;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const body = this.text.slice(start, this.at);
          this.at += 1;
          return body;
        }
      }
      this.at += 1;
    }
    return this.text.slice(start);
  }
}

/** Parse a GraphQL document. */
function parseDocument(source: string): Document {
  const doc: Document = { kind: 'query', roots: [], variableDefaults: {} };
  const scanner = new Scanner(source);

  // An operation keyword is optional: a bare `{ ... }` is a query.
  const first = scanner.name();
  if (first === 'query' || first === 'mutation' || first === 'subscription') {
    doc.kind = first;
    // Skip the operation name when the document gave one.
    const maybeName = scanner.name();
    if (maybeName === '') scanner.at -= 0;
    if (scanner.look() === '(') {
      const vars = scanner.balanced('(', ')');
      doc.variableDefaults = readVariableDefaults(vars);
    }
  } else if (first !== '') {
    // Some other keyword: leave the cursor where the name ended and let the brace search run.
    scanner.at -= first.length;
  }

  // Any fragment definitions after the operation are ignored: the suite never relies on them.
  const body = scanner.balanced('{', '}');
  doc.roots = parseSelectionSet(body);
  return doc;
}

/** Read `$name: Type = default` pairs into a plain map of the defaults only. */
function readVariableDefaults(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let at = 0;
  while (at < text.length) {
    const dollar = text.indexOf('$', at);
    if (dollar < 0) break;
    const match = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(dollar));
    if (!match) {
      at = dollar + 1;
      continue;
    }
    // The default follows the first '=' before the next '$' or the end.
    const eq = text.indexOf('=', dollar);
    if (eq < 0) break;
    const literal = /^\s*([^,)]+)/.exec(text.slice(eq + 1));
    if (literal) out[match[1]] = literalValue(literal[1].trim());
    at = dollar + match[0].length;
  }
  return out;
}

/** Parse a selection-set body into selections. */
function parseSelectionSet(body: string): Selection[] {
  const out: Selection[] = [];
  const scanner = new Scanner(body);
  while (true) {
    scanner.skipSpace();
    if (scanner.done) break;
    // `...` starts a fragment. The suite sends inline fragments only (`... on Repository { … }`),
    // and an inline fragment's fields belong to the object its selection set is being built for,
    // so they are appended as siblings here.
    if (scanner.look() === '.') {
      scanner.at += 3;
      if (scanner.look() === 'o' && /^on\b/.test(body.slice(scanner.at))) {
        scanner.name();
        const onType = scanner.name();
        out.push({
          name: onType,
          alias: null,
          args: {},
          children: parseSelectionSet(scanner.balanced('{', '}')),
          argText: '',
        });
        continue;
      }
      // A spread of a named fragment: this forge resolves nothing from it.
      scanner.name();
      continue;
    }
    const first = scanner.name();
    if (first === '') {
      scanner.at += 1;
      continue;
    }
    if (first === 'fragment') {
      // Skip a fragment definition entirely.
      scanner.balanced('{', '}');
      continue;
    }
    let name = first;
    let alias: string | null = null;
    if (scanner.take(':')) {
      alias = first;
      name = scanner.name();
    }
    const argText = scanner.look() === '(' ? scanner.balanced('(', ')') : '';
    let children: Selection[] = [];
    if (scanner.look() === '{') children = parseSelectionSet(scanner.balanced('{', '}'));
    out.push({ name, alias, args: readArguments(argText), children, argText });
  }
  return out;
}

/** Parse `key: value` pairs, keeping an inline object as its raw text under __raw. */
function readArguments(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let at = 0;
  while (at < text.length) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(text.slice(at));
    if (!match) {
      at += 1;
      continue;
    }
    const key = match[1];
    at += match[0].length;
    const value = readValue(text, at);
    out[key] = value.value;
    at = value.next;
  }
  return out;
}

/** Read one argument value starting at `at`, returning it plus the cursor past it. */
function readValue(text: string, at: number): { value: unknown; next: number } {
  while (at < text.length && /\s/.test(text[at])) at += 1;
  const ch = text[at];
  if (ch === '{') {
    const end = matchPair(text, at, '{', '}');
    return { value: { __raw: text.slice(at + 1, end) }, next: end + 1 };
  }
  if (ch === '[') {
    const end = matchPair(text, at, '[', ']');
    return { value: readList(text.slice(at + 1, end)), next: end + 1 };
  }
  if (ch === '"') {
    let cursor = at + 1;
    while (cursor < text.length && (text[cursor] !== '"' || text[cursor - 1] === '\\')) cursor += 1;
    let value = text.slice(at + 1, cursor);
    try {
      value = JSON.parse(text.slice(at, cursor + 1));
    } catch {
      // A literal the document mangled: keep what was between the quotes.
    }
    return { value, next: cursor + 1 };
  }
  const scalar = /^[^,\s)}\]]+/.exec(text.slice(at));
  if (!scalar) return { value: null, next: at + 1 };
  return { value: literalValue(scalar[0]), next: at + scalar[0].length };
}

/** A list argument's items. */
function readList(text: string): unknown[] {
  const out: unknown[] = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && /[\s,]/.test(text[at])) at += 1;
    if (at >= text.length) break;
    const read = readValue(text, at);
    out.push(read.value);
    at = read.next;
  }
  return out;
}

/** The index of the closer matching the opener at `start`. */
function matchPair(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  for (let at = start; at < text.length; at += 1) {
    const ch = text[at];
    if (inString) {
      if (ch === '\\') at += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return text.length;
}

/** A scalar literal's JS value. */
function literalValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('$')) return raw;
  return raw;
}

/* ------------------------------------------------------------------ ids and variables */

/** A global id: what node(id:) and every mutation input carry. */
function toGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** A global id back to its kind and key, or null when it is not one. */
function fromGlobalId(id: string): { kind: string; key: string } | null {
  if (id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
}

/**
 * Split `<owner>/<repo>#<number>`.
 *
 * The number is peeled off the last '#' first: splitting on '/' first would leave "#4" attached to
 * the repository name and every lookup past that point would miss.
 */
function splitIssueKey(key: string): { owner: string; repo: string; number: number } | null {
  const hash = key.lastIndexOf('#');
  if (hash < 0) return null;
  const path = key.slice(0, hash);
  const number = Number(key.slice(hash + 1));
  const slash = path.indexOf('/');
  if (slash <= 0) return null;
  return { owner: path.slice(0, slash), repo: path.slice(slash + 1), number };
}

/** Replace every `$name` reference in a selection tree with its variable's value. */
function bindVariables(selections: Selection[], variables: Record<string, unknown>): Selection[] {
  return selections.map((selection) => {
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(selection.args)) {
      args[key] = Array.isArray(value)
        ? value.map((item) => deref(item, variables))
        : deref(value, variables);
    }
    let argText = selection.argText;
    // `input: $input` is the one argument whose value has to be re-rendered: every mutation reads
    // its fields out of the raw text, and a bare reference would read none of them.
    const referenced = /\binput\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)/.exec(argText);
    if (referenced) {
      const bound = variables[referenced[1]];
      if (bound !== undefined) {
        args.input = bound;
        argText = argText.replace(referenced[0], `input: ${renderInput(bound)}`);
      }
    }
    return {
      name: selection.name,
      alias: selection.alias,
      args,
      children: bindVariables(selection.children, variables),
      argText,
    };
  });
}

/** A single value through the variable table. */
function deref(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) return variables[value.slice(1)];
  return value;
}

/** Render a JS value as GraphQL input syntax. */
function renderInput(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(renderInput).join(', ')}]`;
  if (typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${renderInput(item)}`);
    return `{${pairs.join(', ')}}`;
  }
  return 'null';
}

/* ------------------------------------------------------------------ the request */

/** What graphql needs from the caller. */
export interface GraphqlRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  login: string | null;
  store: Store;
  body: unknown;
}

/** Answer one operation, or a batch of them. */
export async function handleGraphql(input: GraphqlRequest): Promise<void> {
  const { res, method, login, store, body } = input;

  if (method !== 'POST') {
    answer(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  if (login === null) {
    answer(res, 200, {
      data: null,
      errors: [{ message: 'Requires authentication', type: 'UNAUTHENTICATED' }],
    });
    return;
  }

  // A batch arrives as a JSON array; each operation gets its own envelope, in order.
  if (Array.isArray(body)) {
    answer(res, 200, body.map((operation) => execute(store, login, operation)));
    return;
  }

  answer(res, 200, execute(store, login, body));
}

/** Emit a reply. GraphQL always answers 200 unless the transport itself failed. */
function answer(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': createHash('sha256').update(text).digest('hex').slice(0, 16),
  });
  res.end(text);
}

/** Run one operation and return its {data, errors} envelope. */
function execute(store: Store, login: string, raw: unknown): Record<string, unknown> {
  const payload = (raw ?? {}) as { query?: unknown; variables?: unknown };
  if (typeof payload.query !== 'string' || payload.query.trim() === '') {
    return { data: null, errors: [{ message: 'Problems parsing JSON: a query is required', type: 'BAD_REQUEST' }] };
  }
  const document = parseDocument(payload.query);
  const supplied = (payload.variables ?? {}) as Record<string, unknown>;
  const variables: Record<string, unknown> = { ...document.variableDefaults, ...supplied };
  const roots = bindVariables(document.roots, variables);

  if (roots.length === 0) {
    return { data: null, errors: [{ message: 'Problems parsing JSON: the query names no field', type: 'BAD_REQUEST' }] };
  }

  const errors: GqlError[] = [];
  const data: Record<string, unknown> = {};
  for (const selection of roots) {
    const key = selection.alias ?? selection.name;
    try {
      data[key] = resolveRoot(store, login, selection, variables, errors, document.kind);
    } catch (thrown) {
      errors.push({ message: thrown instanceof Error ? thrown.message : String(thrown), type: 'INTERNAL', path: [key] });
      data[key] = null;
    }
  }

  const envelope: Record<string, unknown> = { data: Object.keys(data).length === 0 ? null : data };
  if (errors.length > 0) envelope.errors = errors;
  return envelope;
}

/* ------------------------------------------------------------------ root fields */

/** The User object the viewer field answers with. */
function viewerObject(login: string): Record<string, unknown> {
  return {
    login,
    id: toGlobalId('User', login),
    name: login,
    email: `${login}@forge.local`,
    avatarUrl: `http://forge.local/${login}.png`,
    resourcePath: `/${login}`,
    url: `http://forge.local/${login}`,
  };
}

/** Resolve one root field. */
function resolveRoot(
  store: Store,
  login: string,
  selection: Selection,
  variables: Record<string, unknown>,
  errors: GqlError[],
  kind: string,
): unknown {
  switch (selection.name) {
    case 'viewer':
      return projectWithErrors(viewerObject(login), selection, errors, 'User', ['viewer']);
    case 'repository':
      return resolveRepository(store, login, selection, errors);
    case 'node':
      return resolveNode(store, login, selection, errors);
    case 'rateLimit':
      return { limit: 5000, remaining: 4999, used: 1, resetAt: isoOf(FIXED_EPOCH_SEC) };
    case '__typename':
      return kind === 'mutation' ? 'Mutation' : 'Query';
    case '__schema':
    case '__type':
      return resolveIntrospection(selection);
    default:
      break;
  }
  if (kind === 'mutation') return resolveMutation(store, login, selection, errors);
  errors.push({ message: `Field '${selection.name}' doesn't exist on type 'Query'`, type: 'INVALID_FIELD', path: [selection.name] });
  return null;
}

/** repository(owner:, name:) — null for a repository the token does not own. */
function resolveRepository(store: Store, login: string, selection: Selection, errors: GqlError[]): unknown {
  const owner = String(selection.args.owner ?? '');
  const name = String(selection.args.name ?? '');
  const repo = store.repo(owner, name);
  if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
  return projectRepository(store, repo, selection.children, errors);
}

/** node(id:) — a global id back to its object. */
function resolveNode(store: Store, login: string, selection: Selection, errors: GqlError[]): unknown {
  const decoded = fromGlobalId(String(selection.args.id ?? ''));
  if (decoded === null) return null;

  // node(id:) returns an interface, so its selection set is written against the concrete type in
  // an inline fragment: `node(id:) { id ... on Repository { name } }`. The fragment's fields are
  // the concrete projection, and any fields beside it are read off the same object.
  const concrete = selection.children.find((child) => child.name === 'Repository')
    ?? selection.children.find((child) => child.name === 'Issue')
    ?? selection.children.find((child) => child.name === 'PullRequest');
  const concreteName = concrete?.name ?? decoded.kind;
  const fields: Selection[] = [
    ...selection.children.filter((child) => child !== concrete && !isTypeCondition(child.name)),
    ...(concrete?.children ?? []),
  ];

  if (concreteName === 'Repository') {
    const slash = decoded.key.indexOf('/');
    if (slash <= 0) return null;
    const repo = store.repo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
    if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
    return projectRepository(store, repo, fields, errors);
  }

  const split = splitIssueKey(decoded.key);
  if (split === null) return null;
  const repo = store.repo(split.owner, split.repo);
  if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
  if (concreteName === 'Issue') {
    const issue = repo.issues.get(split.number);
    return issue ? projectIssue(store, repo, issue, fields) : null;
  }
  if (concreteName === 'PullRequest') {
    const pull = repo.pulls.get(split.number);
    return pull ? projectPull(store, repo, pull, fields) : null;
  }
  return null;
}

/** Whether a parsed child is a type condition of an inline fragment rather than a field. */
function isTypeCondition(name: string): boolean {
  return name === 'Repository' || name === 'Issue' || name === 'PullRequest' || name === 'Node';
}

/* ------------------------------------------------------------------ projections */

/** Project an object against a selection set, recording an error for an unknown field. */
function projectWithErrors(
  source: Record<string, unknown>,
  selection: Selection,
  errors: GqlError[],
  typeName: string,
  path: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of selection.children) {
    const key = child.alias ?? child.name;
    if (child.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!(child.name in source)) {
      errors.push({ message: `Field '${child.name}' doesn't exist on type '${typeName}'`, type: 'INVALID_FIELD', path: [...path, child.name] });
      out[key] = null;
      continue;
    }
    out[key] = project(source[child.name], child.children);
  }
  return out;
}

/** Project a value against a selection set: a plain recursive field lookup. */
function project(value: unknown, children: Selection[]): unknown {
  if (children.length === 0) return value === undefined ? null : value;
  if (Array.isArray(value)) return value.map((item) => project(item, children));
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const child of children) {
    const key = child.alias ?? child.name;
    if (child.name === '__typename') {
      out[key] = typeof source.__typename === 'string' ? source.__typename : 'Object';
      continue;
    }
    out[key] = project(source[child.name], child.children);
  }
  return out;
}

/** A Relay connection: nodes, edges, totalCount and a pageInfo measured from the page's start. */
function connection<T>(items: T[], selection: Selection, projectNode: (item: T) => unknown): Record<string, unknown> {
  const first = Number(selection.args.first ?? items.length);
  const last = Number(selection.args.last ?? 0);
  let start = 0;
  const after = selection.args.after;
  if (typeof after === 'string' && after !== '') {
    const decoded = Number(Buffer.from(after, 'base64').toString('utf8').replace('cursor:', ''));
    if (Number.isFinite(decoded)) start = decoded + 1;
  }
  const rest = items.slice(start);
  let page = rest;
  if (last > 0) page = rest.slice(-last);
  else if (Number.isFinite(first) && first > 0) page = rest.slice(0, first);
  const end = start + page.length;

  const out: Record<string, unknown> = { totalCount: items.length };
  for (const child of selection.children) {
    const key = child.alias ?? child.name;
    if (child.name === 'nodes') {
      const nodeSelections = child.children.length > 0 ? child.children : selection.children;
      out[key] = page.map((item) => projectNode(item));
      void nodeSelections;
    } else if (child.name === 'edges') {
      out[key] = page.map((item, index) => ({
        cursor: Buffer.from(`cursor:${start + index}`, 'utf8').toString('base64'),
        node: projectNode(item),
      }));
    } else if (child.name === 'pageInfo') {
      out[key] = {
        hasNextPage: end < items.length,
        hasPreviousPage: start > 0,
        startCursor: page.length > 0 ? Buffer.from(`cursor:${start}`, 'utf8').toString('base64') : null,
        endCursor: page.length > 0 ? Buffer.from(`cursor:${end - 1}`, 'utf8').toString('base64') : null,
      };
    } else if (child.name === '__typename') {
      out[key] = 'IssueConnection';
    }
  }
  return out;
}

/** The children a connection's `nodes` sub-selection asked for. */
function nodeSelections(selection: Selection): Selection[] {
  const nodes = selection.children.find((child) => child.name === 'nodes');
  return nodes !== undefined && nodes.children.length > 0 ? nodes.children : selection.children;
}

/** The label object a projection reads. */
function labelObject(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name) ?? { name, color: 'ededed', description: '' };
  return {
    __typename: 'Label',
    id: toGlobalId('Label', label.name),
    name: label.name,
    color: label.color,
    description: label.description,
  };
}

/** Project a repository: the scalar block first, then the connections and singletons it holds. */
function projectRepository(store: Store, repo: Repo, children: Selection[], errors: GqlError[]): Record<string, unknown> {
  const branchSha = store.refOf(repo, `refs/heads/${repo.default_branch}`) ?? '';
  const scalars: Record<string, unknown> = {
    __typename: 'Repository',
    id: toGlobalId('Repository', `${repo.owner}/${repo.name}`),
    databaseId: repoNumericId(repo),
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    isFork: repo.fork,
    isEmpty: false,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    url: `http://forge.local/${repo.owner}/${repo.name}`,
    visibility: repo.private ? 'PRIVATE' : 'PUBLIC',
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasWikiEnabled: true,
    stargazerCount: 0,
    forkCount: 0,
    diskUsage: 0,
    defaultBranchRef: {
      __typename: 'Ref',
      name: repo.default_branch,
      target: { __typename: 'Commit', oid: branchSha, abbreviatedOid: branchSha.slice(0, 7) },
    },
    owner: {
      __typename: 'User',
      id: toGlobalId('User', repo.owner),
      login: repo.owner,
      avatarUrl: `http://forge.local/${repo.owner}.png`,
      resourcePath: `/${repo.owner}`,
      url: `http://forge.local/${repo.owner}`,
    },
  };

  const out: Record<string, unknown> = {};
  for (const child of children) {
    const key = child.alias ?? child.name;
    switch (child.name) {
      case 'issues':
        out[key] = connection(selectIssues(repo, child), child, (issue) => projectIssue(store, repo, issue, nodeSelections(child)));
        break;
      case 'pullRequests':
        out[key] = connection(
          [...repo.pulls.values()].sort((a, b) => b.number - a.number),
          child,
          (pull) => projectPull(store, repo, pull, nodeSelections(child)),
        );
        break;
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(child.args.number ?? 0));
        out[key] = pull ? projectPull(store, repo, pull, child.children) : null;
        break;
      }
      case 'issue': {
        const issue = repo.issues.get(Number(child.args.number ?? 0));
        out[key] = issue ? projectIssue(store, repo, issue, child.children) : null;
        break;
      }
      case 'labels':
        out[key] = connection(
          [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
          child,
          (label) => project(labelObject(repo, label.name), nodeSelections(child)),
        );
        break;
      case 'label': {
        const name = String(child.args.name ?? '');
        out[key] = repo.labels.has(name) ? project(labelObject(repo, name), child.children) : null;
        break;
      }
      case 'ref': {
        const sha = store.refOf(repo, String(child.args.qualifiedName ?? ''));
        out[key] = sha === null
          ? null
          : project({ __typename: 'Ref', name: String(child.args.qualifiedName ?? '').replace(/^refs\//, ''), target: { oid: sha } }, child.children);
        break;
      }
      case 'object': {
        const sha = store.commitOf(repo, String(child.args.oid ?? child.args.expression ?? ''));
        out[key] = sha === null ? null : project({ __typename: 'Commit', oid: sha, abbreviatedOid: sha.slice(0, 7) }, child.children);
        break;
      }
      default: {
        if (!(child.name in scalars)) {
          errors.push({
            message: `Field '${child.name}' doesn't exist on type 'Repository'`,
            type: 'INVALID_FIELD',
            path: ['repository', child.name],
          });
          out[key] = null;
          break;
        }
        out[key] = project(scalars[child.name], child.children);
        break;
      }
    }
  }
  return out;
}

/** The issue list a Repository.issues selection asks for: filtered by states, ordered by orderBy. */
function selectIssues(repo: Repo, selection: Selection): Issue[] {
  const raw = selection.args.states;
  const states = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((state) => String(state).toUpperCase());
  let items = [...repo.issues.values()];
  if (states.length > 0) {
    items = items.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }

  // `orderBy: {field: CREATED_AT, direction: ASC}` arrives as raw text; the field and direction
  // are the only two things it says.
  const order = selection.children.find((child) => child.name === 'issues')?.args.orderBy;
  const orderText = order !== null && typeof order === 'object' && typeof (order as { __raw?: unknown }).__raw === 'string'
    ? (order as { __raw: string }).__raw
    : '';
  const ascending = /direction\s*:\s*ASC/i.test(orderText);
  const byUpdated = /field\s*:\s*UPDATED_AT/i.test(orderText);
  items.sort((a, b) => {
    if (/field\s*:\s*(CREATED_AT|UPDATED_AT)/i.test(orderText)) {
      const left = byUpdated ? a.updated_at : a.created_at;
      const right = byUpdated ? b.updated_at : b.created_at;
      if (left !== right) return left < right ? (ascending ? -1 : 1) : ascending ? 1 : -1;
    }
    return ascending ? a.number - b.number : b.number - a.number;
  });
  return items;
}

/** A repository's numeric id, the same derivation the REST payload uses for `id`. */
function repoNumericId(repo: Repo): number {
  const digest = createHash('sha256').update(`repo:${repo.owner}/${repo.name}`).digest();
  return (digest.readUInt32BE(0) % 1_000_000) + 1;
}

/** Project an issue. */
function projectIssue(store: Store, repo: Repo, issue: Issue, children: Selection[]): Record<string, unknown> {
  const scalars: Record<string, unknown> = {
    __typename: 'Issue',
    id: toGlobalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    stateReason: issue.state === 'open' ? null : 'COMPLETED',
    closed: issue.state === 'closed',
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    author: { __typename: 'User', login: issue.user, id: toGlobalId('User', issue.user) },
    url: `http://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository: { __typename: 'Repository', name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
  };
  void store;

  const out: Record<string, unknown> = {};
  for (const child of children) {
    const key = child.alias ?? child.name;
    if (child.name === 'labels') {
      out[key] = connection(
        issue.labels.map((name) => labelObject(repo, name)),
        child,
        (label) => project(label, nodeSelections(child)),
      );
      continue;
    }
    if (child.name === 'comments') {
      out[key] = connection(
        issue.comments.map((comment) => ({
          __typename: 'IssueComment',
          id: toGlobalId('Comment', String(comment.id)),
          body: comment.body,
          author: { __typename: 'User', login: comment.user },
          createdAt: comment.created_at,
        })),
        child,
        (comment) => project(comment, nodeSelections(child)),
      );
      continue;
    }
    out[key] = project(scalars[child.name], child.children);
  }
  return out;
}

/** Project a pull request. */
function projectPull(store: Store, repo: Repo, pull: Pull, children: Selection[]): Record<string, unknown> {
  void store;
  const scalars: Record<string, unknown> = {
    __typename: 'PullRequest',
    id: toGlobalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    mergedAt: pull.merged_at,
    closedAt: pull.closed_at,
    url: `http://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    headRefOid: pull.head.sha,
    baseRefOid: pull.base.sha,
    author: { __typename: 'User', login: pull.user },
    repository: { __typename: 'Repository', name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
  };

  const out: Record<string, unknown> = {};
  for (const child of children) {
    const key = child.alias ?? child.name;
    if (child.name === 'files') {
      out[key] = connection(
        pull.files.map((file) => ({
          __typename: 'PullRequestChangedFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        })),
        child,
        (file) => project(file, nodeSelections(child)),
      );
      continue;
    }
    out[key] = project(scalars[child.name], child.children);
  }
  return out;
}

/* ------------------------------------------------------------------ introspection */

/** The fields each named type reports. gh feature-detects on these names before it plans a call. */
const TYPE_FIELDS: Record<string, string[]> = {
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'isPrivate', 'isFork', 'isEmpty',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'ref', 'object', 'label', 'labels',
    'createdAt', 'updatedAt', 'url', 'visibility', 'stargazerCount', 'forkCount', 'diskUsage',
  ],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'stateReason', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'url', 'repository', 'labels', 'comments', 'closed',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'mergedAt', 'createdAt',
    'updatedAt', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'author', 'files',
    'commits', 'url',
  ],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'resourcePath', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  String: [],
  Int: [],
  Boolean: [],
  ID: [],
};

/** The enum values a SearchType probe reads. */
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

/** __schema and __type(name:). */
function resolveIntrospection(selection: Selection): unknown {
  if (selection.name === '__schema') {
    return {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      types: Object.keys(TYPE_FIELDS).map((name) => ({ name, kind: 'OBJECT' })),
    };
  }
  const wanted = String(selection.args.name ?? '');
  const fields = TYPE_FIELDS[wanted];
  const values = TYPE_ENUMS[wanted];
  if (fields === undefined && values === undefined) return null;

  const out: Record<string, unknown> = { name: wanted, kind: values !== undefined ? 'ENUM' : 'OBJECT' };
  for (const child of selection.children) {
    const key = child.alias ?? child.name;
    if (child.name === 'fields') {
      out[key] = (fields ?? []).map((name) => ({
        name,
        type: { name: name === 'id' ? 'ID' : 'String', kind: 'SCALAR' },
        args: [],
        isDeprecated: false,
        deprecationReason: null,
      }));
    } else if (child.name === 'enumValues') {
      out[key] = (values ?? []).map((name) => ({ name, isDeprecated: false, deprecationReason: null }));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ mutations */

/** Read a mutation's inline input object out of the raw argument text. */
function readInput(argText: string): Record<string, unknown> {
  const start = argText.indexOf('{');
  if (start < 0) return {};
  const end = matchPair(argText, start, '{', '}');
  return readInputFields(argText.slice(start + 1, end));
}

/** Flatten an input object's fields; a nested object keeps its own keys. */
function readInputFields(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let at = 0;
  while (at < text.length) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(text.slice(at));
    if (!match) {
      at += 1;
      continue;
    }
    at += match[0].length;
    const value = readValue(text, at);
    out[match[1]] = value.value;
    at = value.next;
  }
  return out;
}

/** The repository a mutation input names: repositoryId, or owner + repo. */
function inputRepo(store: Store, login: string, input: Record<string, unknown>): Repo | null {
  if (typeof input.repositoryId === 'string') {
    const decoded = fromGlobalId(input.repositoryId);
    if (decoded === null || decoded.kind !== 'Repository') return null;
    const slash = decoded.key.indexOf('/');
    if (slash <= 0) return null;
    const repo = store.repo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
    return repo !== undefined && repo.owner.toLowerCase() === login.toLowerCase() ? repo : null;
  }
  const repo = store.repo(String(input.owner ?? ''), String(input.repo ?? input.repositoryName ?? ''));
  return repo !== undefined && repo.owner.toLowerCase() === login.toLowerCase() ? repo : null;
}

/** The issue a mutation input names: issueId, subjectId, or owner + repo + issueNumber. */
function inputIssue(store: Store, login: string, input: Record<string, unknown>): { repo: Repo; issue: Issue } | null {
  // addComment names its subject `subjectId`; the issue mutations name it `issueId`.
  const rawId = input.issueId ?? input.subjectId;
  if (typeof rawId === 'string') {
    const decoded = fromGlobalId(rawId);
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const split = splitIssueKey(decoded.key);
    if (split === null) return null;
    const repo = store.repo(split.owner, split.repo);
    if (repo === undefined || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
    const issue = repo.issues.get(split.number);
    return issue === undefined ? null : { repo, issue };
  }
  const repo = store.repo(String(input.owner ?? ''), String(input.repo ?? ''));
  if (repo === undefined || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
  const issue = repo.issues.get(Number(input.issueNumber ?? input.number ?? 0));
  return issue === undefined ? null : { repo, issue };
}

/** The pull request a mutation input names. */
function inputPull(store: Store, login: string, input: Record<string, unknown>): { repo: Repo; pull: Pull } | null {
  if (typeof input.pullRequestId === 'string') {
    const decoded = fromGlobalId(input.pullRequestId);
    if (decoded === null || decoded.kind !== 'PullRequest') return null;
    const split = splitIssueKey(decoded.key);
    if (split === null) return null;
    const repo = store.repo(split.owner, split.repo);
    if (repo === undefined || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
    const pull = repo.pulls.get(split.number);
    return pull === undefined ? null : { repo, pull };
  }
  const repo = store.repo(String(input.owner ?? ''), String(input.repo ?? ''));
  if (repo === undefined || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
  const pull = repo.pulls.get(Number(input.pullRequestNumber ?? input.number ?? 0));
  return pull === undefined ? null : { repo, pull };
}

/** The payload selection a mutation asked for under `key`. */
function payloadChildren(selection: Selection, key: string): Selection[] {
  const found = selection.children.find((child) => child.name === key);
  return found === undefined ? [] : found.children;
}

/** Resolve one mutation. */
function resolveMutation(store: Store, login: string, selection: Selection, errors: GqlError[]): unknown {
  const input = readInput(selection.argText);
  const clientMutationId = input.clientMutationId ?? null;
  const name = selection.name;

  switch (name) {
    case '__typename':
      return 'Mutation';

    case 'createIssue': {
      const repo = inputRepo(store, login, input);
      if (repo === null) {
        errors.push({ message: 'Could not resolve to a Repository', type: 'NOT_FOUND', path: ['createIssue'] });
        return null;
      }
      const now = isoOf(FIXED_EPOCH_SEC);
      const issue: Issue = {
        number: repo.nextIssue,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        user: login,
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      repo.nextIssue += 1;
      repo.issues.set(issue.number, issue);
      return { issue: projectIssue(store, repo, issue, payloadChildren(selection, 'issue')), clientMutationId };
    }

    case 'closeIssue':
    case 'reopenIssue': {
      const resolved = inputIssue(store, login, input);
      if (resolved === null) {
        errors.push({ message: 'Could not resolve to an Issue', type: 'NOT_FOUND', path: [name] });
        return null;
      }
      const closing = name === 'closeIssue';
      resolved.issue.state = closing ? 'closed' : 'open';
      resolved.issue.closed_at = closing ? isoOf(FIXED_EPOCH_SEC) : null;
      resolved.issue.updated_at = isoOf(FIXED_EPOCH_SEC);
      return { issue: projectIssue(store, resolved.repo, resolved.issue, payloadChildren(selection, 'issue')), clientMutationId };
    }

    case 'addComment': {
      const resolved = inputIssue(store, login, input);
      if (resolved === null) {
        errors.push({ message: 'Could not resolve to an Issue', type: 'NOT_FOUND', path: ['addComment'] });
        return null;
      }
      const body = String(input.body ?? '');
      const id = resolved.repo.nextComment;
      resolved.repo.nextComment += 1;
      const at = isoOf(FIXED_EPOCH_SEC);
      resolved.issue.comments.push({ id, body, user: login, created_at: at });
      return {
        commentEdge: {
          node: { __typename: 'IssueComment', id: toGlobalId('Comment', String(id)), body, author: { login }, createdAt: at },
        },
        clientMutationId,
      };
    }

    case 'createPullRequest': {
      const repo = inputRepo(store, login, input);
      if (repo === null) {
        errors.push({ message: 'Could not resolve to a Repository', type: 'NOT_FOUND', path: ['createPullRequest'] });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? repo.default_branch);
      const headSha = store.refOf(repo, `refs/heads/${headRef}`);
      const baseSha = store.refOf(repo, `refs/heads/${baseRef}`);
      if (headSha === null || baseSha === null) {
        errors.push({ message: 'No commits between the branches', type: 'UNPROCESSABLE', path: ['createPullRequest'] });
        return null;
      }
      const now = isoOf(FIXED_EPOCH_SEC);
      const pull: Pull = {
        number: repo.nextPull,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      return { pullRequest: projectPull(store, repo, pull, payloadChildren(selection, 'pullRequest')), clientMutationId };
    }

    case 'mergePullRequest': {
      const resolved = inputPull(store, login, input);
      if (resolved === null) {
        errors.push({ message: 'Could not resolve to a PullRequest', type: 'NOT_FOUND', path: ['mergePullRequest'] });
        return null;
      }
      resolved.pull.merged = true;
      resolved.pull.state = 'closed';
      resolved.pull.merged_at = isoOf(FIXED_EPOCH_SEC);
      resolved.pull.closed_at = resolved.pull.merged_at;
      return { pullRequest: projectPull(store, resolved.repo, resolved.pull, payloadChildren(selection, 'pullRequest')), clientMutationId };
    }

    default:
      errors.push({ message: `Field '${name}' doesn't exist on type 'Mutation'`, type: 'INVALID_FIELD', path: [name] });
      return null;
  }
}

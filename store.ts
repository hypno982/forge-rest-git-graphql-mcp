// store.ts: the forge's own data model — repositories, git objects and the issue/pull tables.
//
// Determinism is a hard requirement, not a nicety: the scorer runs the suite twice and compares the
// exported state byte for byte. So nothing in here reads the clock, Math.random or the process.
// Every id is a counter, every object name is derived from content, and every timestamp is the
// scenario's fixed epoch unless a caller passes its own.

import { createHash } from 'node:crypto';

/** The scenario's fixed epoch in seconds: created objects date from 2025-01-01T00:00:00Z. */
export const FIXED_EPOCH_SEC = 1735689600;

/** git's empty tree. The one object whose name is a constant rather than a hash of its contents. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The four object kinds git stores. */
export type ObjKind = 'blob' | 'tree' | 'commit' | 'tag';

/** One stored object: its kind and its raw bytes (a name is sha1 over a framed header + bytes). */
export interface GitObject {
  kind: ObjKind;
  body: Buffer;
}

/** One entry of a tree object. Modes are git's: 100644, 100755, 40000, 120000. */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** A parsed commit. `time`/`tz` come out of the author line; both are fixed in this forge. */
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  time: number;
  tz: string;
}

/** A ref and, for a symbolic one, what it points at. */
export interface RefInfo {
  sha: string;
  symref: string | null;
}

/** One file inside a commit's tree, flattened to its full path. */
export interface FileEntry {
  path: string;
  sha: string;
  mode: string;
}

/** One comment on an issue. */
export interface IssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
}

/** One issue. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
}

/** One label. */
export interface Label {
  name: string;
  color: string;
  description: string;
}

/** One file a pull request changes. */
export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  previous_filename?: string;
}

/** One pull request. */
export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  user: string;
  created_at: string;
  updated_at: string;
  merged: boolean;
  mergeable: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  closed_at: string | null;
  files: PullFile[];
}

/** One repository: its refs, the commits they reach, and its issue/pull tables. */
export interface Repo {
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  /** Refs by full name ('refs/heads/main', plus the symbolic 'HEAD'). */
  refs: Map<string, RefInfo>;
  /** Commits reachable from this repository, by sha; blobs and trees live in the shared store. */
  commits: Map<string, CommitInfo>;
  issues: Map<number, Issue>;
  labels: Map<string, Label>;
  pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  fork: boolean;
}

/* ------------------------------------------------------------------ time */

/**
 * Seconds since the epoch -> the exact ISO string every API field uses.
 *
 * `new Date(...).toISOString()` gives milliseconds, and GitHub's fields do not carry them, so the
 * millisecond part is dropped rather than rounded.
 */
export function isoOf(sec: number): string {
  const whole = Math.trunc(sec);
  return new Date(whole * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* ------------------------------------------------------------------ object encoding */

const utf8 = new TextEncoder();

/** git's object name: sha1("<kind> <byteLength>\0" + body). */
export function objectSha(kind: ObjKind, body: Buffer): string {
  const hash = createHash('sha1');
  hash.update(utf8.encode(`${kind} ${body.length}\u0000`));
  hash.update(body);
  return hash.digest('hex');
}

/** Serialize a tree. Entries are sorted by name, each as "<mode> <name>\0" + 20 raw sha bytes. */
export function treeBody(entries: readonly TreeEntry[]): Buffer {
  const ordered = [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of ordered) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Serialize a commit: tree, parents, author, committer, blank line, message. */
export function commitBody(info: CommitInfo): Buffer {
  const header: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) header.push(`parent ${parent}`);
  header.push(`author ${info.author} ${info.time} ${info.tz}`);
  header.push(`committer ${info.committer} ${info.time} ${info.tz}`);
  header.push('');
  header.push(info.message);
  return Buffer.from(`${header.join('\n')}\n`, 'utf8');
}

/** Serialize an annotated tag. */
export function tagBody(
  object: string,
  kind: string,
  name: string,
  tagger: string,
  time: number,
  tz: string,
  message: string,
): Buffer {
  const lines = [`object ${object}`, `type ${kind}`, `tag ${name}`, `tagger ${tagger} ${time} ${tz}`, '', message];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/**
 * Parse a tree body back into entries.
 *
 * A tree is not line-oriented: each entry is "<mode> <name>\0" followed by exactly 20 raw bytes.
 * The walk therefore advances by the NUL position plus those 20 bytes, never by scanning for a
 * newline.
 */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < body.length) {
    const nul = body.indexOf(0, at);
    if (nul < 0) break;
    const head = body.subarray(at, nul).toString('utf8');
    const space = head.indexOf(' ');
    if (space < 0) break;
    entries.push({
      mode: head.slice(0, space),
      name: head.slice(space + 1),
      sha: body.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

/** Parse a commit body. The author's trailing "<seconds> <+zzzz>" is split off into time/tz. */
export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const info: CommitInfo = {
    tree: '',
    parents: [],
    author: '',
    committer: '',
    message: split < 0 ? '' : text.slice(split + 2).replace(/\n$/, ''),
    time: FIXED_EPOCH_SEC,
    tz: '+0000',
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) {
      info.tree = line.slice(5);
      continue;
    }
    if (line.startsWith('parent ')) {
      info.parents.push(line.slice(7));
      continue;
    }
    if (line.startsWith('author ')) {
      const stamp = /^(.*) (\d+) ([+-]\d{4})$/.exec(line.slice(7));
      if (stamp) {
        info.author = stamp[1];
        info.time = Number(stamp[2]);
        info.tz = stamp[3];
      } else {
        info.author = line.slice(7);
      }
      continue;
    }
    if (line.startsWith('committer ')) {
      const stamp = /^(.*) (\d+) ([+-]\d{4})$/.exec(line.slice(10));
      info.committer = stamp ? stamp[1] : line.slice(10);
    }
  }
  return info;
}

/* ------------------------------------------------------------------ the store */

/**
 * The whole forge: one account's repositories over a single shared object store.
 *
 * Objects are shared on purpose — a blob pushed to two repositories is one object, exactly as git
 * would have it — while refs, commits and the issue tables stay per repository.
 */
export class Store {
  readonly repos = new Map<string, Repo>();
  readonly objects = new Map<string, GitObject>();
  /** The login the harness's bearer token names; everything created through the API is theirs. */
  readonly viewer: string;
  /** A second seeded login with no rights on the viewer's repositories. */
  readonly stranger: string;

  constructor(viewer: string, stranger: string) {
    this.viewer = viewer;
    this.stranger = stranger;
  }

  /** Store one object under its content-derived name and hand the name back. */
  put(kind: ObjKind, body: Buffer): string {
    const sha = objectSha(kind, body);
    if (!this.objects.has(sha)) this.objects.set(sha, { kind, body });
    return sha;
  }

  /** One object by name, or undefined. */
  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  /** Store a blob. */
  putBlob(bytes: Buffer | string): string {
    return this.put('blob', Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
  }

  /** Store a tree from entries. No entries is git's empty tree, whose name is a constant. */
  putTree(entries: readonly TreeEntry[]): string {
    if (entries.length === 0) {
      if (!this.objects.has(EMPTY_TREE_SHA)) {
        this.objects.set(EMPTY_TREE_SHA, { kind: 'tree', body: Buffer.alloc(0) });
      }
      return EMPTY_TREE_SHA;
    }
    return this.put('tree', treeBody(entries));
  }

  /** Store a commit. */
  putCommit(info: CommitInfo): string {
    return this.put('commit', commitBody(info));
  }

  /** The map key for a repository: owner and name are case-insensitive, as GitHub treats them. */
  static key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /** One repository by owner and name, or undefined. */
  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  /** Create a repository record. The caller decides whether the name was already taken. */
  createRepo(
    owner: string,
    name: string,
    opts: { description?: string | null; private?: boolean; defaultBranch?: string } = {},
  ): Repo {
    const at = isoOf(FIXED_EPOCH_SEC);
    const repo: Repo = {
      name,
      owner,
      description: opts.description ?? null,
      private: opts.private === true,
      default_branch: opts.defaultBranch ?? 'main',
      created_at: at,
      updated_at: at,
      refs: new Map(),
      commits: new Map(),
      issues: new Map(),
      labels: new Map(),
      pulls: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      fork: false,
    };
    this.repos.set(Store.key(owner, name), repo);
    return repo;
  }

  /** Every repository an account holds, in name order (which is also creation order here). */
  reposOf(owner: string): Repo[] {
    const mine: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === owner.toLowerCase()) mine.push(repo);
    }
    return mine.sort((left, right) => {
      const a = left.name.toLowerCase();
      const b = right.name.toLowerCase();
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  /**
   * Resolve a ref to a commit name.
   *
   * HEAD follows its symref when it has one. A short name is tried against the three namespaces git
   * itself tries, in the same order.
   */
  refOf(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') {
      const head = repo.refs.get('HEAD');
      if (head === undefined) return null;
      if (head.symref !== null) return repo.refs.get(head.symref)?.sha ?? null;
      return head.sha;
    }
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return direct.sha;
    for (const prefix of ['refs/heads/', 'refs/tags/', 'refs/']) {
      const found = repo.refs.get(prefix + ref);
      if (found !== undefined) return found.sha;
    }
    return null;
  }

  /** Resolve a commit-ish (ref, full sha, or a tag that peels) to a commit this repo holds. */
  commitOf(repo: Repo, ref: string): string | null {
    const sha = this.refOf(repo, ref) ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : null);
    if (sha === null) return null;
    const object = this.objects.get(sha);
    if (object !== undefined && object.kind === 'tag') {
      // A tag names its target on an `object <sha>` line; that target may itself be a tag, which
      // the caller peels again by recursing through commitOf.
      const peeled = /^object ([0-9a-f]{40})$/m.exec(object.body.toString('utf8'));
      if (peeled === null) return null;
      return repo.commits.has(peeled[1]) ? peeled[1] : null;
    }
    return repo.commits.has(sha) ? sha : null;
  }

  /** Walk back from a commit through its parents, nearest first, each commit once. */
  *ancestry(repo: Repo, sha: string): Generator<string> {
    const seen = new Set<string>();
    const queue: string[] = [sha];
    while (queue.length > 0) {
      const at = queue.shift() as string;
      if (seen.has(at)) continue;
      seen.add(at);
      yield at;
      for (const parent of repo.commits.get(at)?.parents ?? []) {
        if (!seen.has(parent)) queue.push(parent);
      }
    }
  }

  /** Every file in a tree, depth first, as full paths. `seen` guards against a malformed cycle. */
  flatTree(treeSha: string, prefix = '', seen = new Set<string>()): FileEntry[] {
    const object = this.objects.get(treeSha);
    if (object === undefined || object.kind !== 'tree') return [];
    if (seen.has(treeSha)) return [];
    seen.add(treeSha);

    const files: FileEntry[] = [];
    for (const entry of parseTree(object.body)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') files.push(...this.flatTree(entry.sha, path, seen));
      else files.push({ path, sha: entry.sha, mode: entry.mode });
    }
    return files;
  }

  /** The files a commit holds, as a path -> entry map. */
  filesOfCommit(repo: Repo, sha: string): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    const info = repo.commits.get(sha);
    if (info === undefined) return out;
    for (const entry of this.flatTree(info.tree)) out.set(entry.path, entry);
    return out;
  }

  /**
   * Build a tree from a path -> {sha, mode} map, nesting directories the way git stores them: every
   * path segment below the top level becomes its own tree object.
   */
  buildTree(files: Map<string, { sha: string; mode: string }>): string {
    const here: TreeEntry[] = [];
    const nested = new Map<string, Map<string, { sha: string; mode: string }>>();

    for (const [path, value] of files) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        here.push({ mode: value.mode, name: path, sha: value.sha });
        continue;
      }
      const dir = path.slice(0, slash);
      let bucket = nested.get(dir);
      if (bucket === undefined) {
        bucket = new Map();
        nested.set(dir, bucket);
      }
      bucket.set(path.slice(slash + 1), value);
    }

    for (const [dir, bucket] of nested) {
      here.push({ mode: '40000', name: dir, sha: this.buildTree(bucket) });
    }
    return this.putTree(here);
  }

  /** The bytes at a path in a commit, or null. */
  blobAt(repo: Repo, commitSha: string, path: string): Buffer | null {
    const entry = this.filesOfCommit(repo, commitSha).get(path);
    if (entry === undefined) return null;
    return this.objects.get(entry.sha)?.body ?? null;
  }

  /**
   * Commit `files` on top of `parentSha` and move `refName` to the result. One write path, shared by
   * the contents API and receive-pack, so both produce byte-identical commits for equal input.
   */
  commitFiles(
    repo: Repo,
    refName: string,
    parentSha: string | null,
    files: Map<string, { sha: string; mode: string }>,
    message: string,
    author: string,
  ): string {
    const info: CommitInfo = {
      tree: this.buildTree(files),
      parents: parentSha === null ? [] : [parentSha],
      author,
      committer: author,
      message,
      time: FIXED_EPOCH_SEC,
      tz: '+0000',
    };
    const sha = this.putCommit(info);
    repo.commits.set(sha, info);
    repo.refs.set(refName, { sha, symref: null });

    // The first branch created in a repository also becomes HEAD's target.
    if (refName.startsWith('refs/heads/') && !repo.refs.has('HEAD')) {
      repo.refs.set('HEAD', { sha, symref: refName });
    }
    repo.updated_at = isoOf(FIXED_EPOCH_SEC);
    return sha;
  }

  /** The files at a ref's commit; an unborn branch has none. */
  filesOfRef(repo: Repo, refName: string): Map<string, { sha: string; mode: string }> {
    const sha = this.refOf(repo, refName);
    if (sha === null) return new Map();
    const out = new Map<string, { sha: string; mode: string }>();
    for (const [path, entry] of this.filesOfCommit(repo, sha)) {
      out.set(path, { sha: entry.sha, mode: entry.mode });
    }
    return out;
  }
}

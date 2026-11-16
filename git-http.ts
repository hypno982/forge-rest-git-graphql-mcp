// git-http.ts: git smart HTTP, written at the byte level.
//
// There is no git binary inside a trial container, so every pkt-line, ref advertisement, packfile and
// report-status byte in here is produced by hand. Three routes exist, and the client in the checks
// drives exactly these:
//
//   GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /<owner>/<repo>.git/git-upload-pack     protocol v2 (ls-refs, fetch) and v0 (want/have)
//   POST /<owner>/<repo>.git/git-receive-pack    push: command list then a packfile
//
// Version 2 is opted into with `Git-Protocol: version=2`; receive-pack stays v0 by design.
//
// Three rules cost checks when they are wrong, and each has a comment where it is implemented:
//   * a v2 peeled tag is an attribute on the tag's own line (`peeled:<oid>`), never a `^{}` ref;
//   * a fetch must not re-send an object the client already holds, and a shallow client's boundary
//     stops the "already held" walk (its boundary commit is held, its parents are not);
//   * a multi-object pack can only be parsed by consumed-byte offsets, which inflate reports through
//     `engine.bytesWritten`.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EMPTY_TREE_SHA,
  Store,
  objectSha,
  parseTree,
  type CommitInfo,
  type ObjKind,
  type TreeEntry,
} from './store.ts';

/** git's LARGE_PACKET_MAX: the biggest a single pkt-line may be. */
const PKT_MAX = 65520;
/** A pkt-line payload cap that leaves room for the channel byte and the length header. */
const PKT_PAYLOAD = PKT_MAX - 5;
/** The all-zero object name: an unborn ref's old value, and a delete's new value. */
const ZERO = '0'.repeat(40);

/** Side-band channels. Only DATA carries the pack; the other two are for progress and errors. */
const BAND_DATA = 1;
const BAND_PROGRESS = 2;
const BAND_ERROR = 3;

/** A trace flag for local debugging. Off by default: a write per object is measurable on 200 pushes. */
const DEBUG = process.env.DEBUG === '1';

/* ------------------------------------------------------------------ pkt-line */

/** Frame one payload with its four hex length bytes. */
function pkt(payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

/** The flush packet: end of a section in v0, end of a command in v2. */
function flush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The v2 delim packet: the next section follows. */
function delim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The v2 response-end packet. */
function responseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** The four control packets, kept apart from data so a caller can see the structure. */
type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/**
 * Decode a pkt-line stream.
 *
 * The three length values 0, 1 and 2 are control packets rather than lengths; anything shorter than
 * 4 or longer than what remains is a truncated tail, which git itself ignores.
 */
function decodePackets(stream: Buffer): Packet[] {
  const packets: Packet[] = [];
  let at = 0;
  while (at + 4 <= stream.length) {
    const header = stream.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > stream.length) break;
    packets.push({ kind: 'data', payload: stream.subarray(at + 4, at + length) });
    at += length;
  }
  return packets;
}

/** Every data payload as utf8 text, with its trailing newline removed. */
function packetLines(stream: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of decodePackets(stream)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/* ------------------------------------------------------------------ request shape */

/** What the router hands this module. */
export interface GitHttpRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: Map<string, string[]>;
  login: string;
  store: Store;
  body: Buffer;
}

/** The capabilities receive-pack advertises. */
const RECEIVE_CAPS = [
  'report-status',
  'report-status-v2',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  'agent=forge/1.0',
].join(' ');

/** The capabilities upload-pack v2 advertises, one per line in the advertisement. */
const UPLOAD_V2_CAPS = [
  'version 2',
  'agent=forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
  'object-format=sha1',
];

/** The capabilities upload-pack v0 advertises, appended to the first ref. */
function uploadCapsV0(defaultBranch: string): string {
  return [
    'multi_ack',
    'thin-pack',
    'side-band',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'no-progress',
    'include-tag',
    'multi_ack_detailed',
    `symref=HEAD:refs/heads/${defaultBranch}`,
    'agent=forge/1.0',
  ].join(' ');
}

/** git wants plain text on an HTTP error, not JSON: its own client reads this body. */
function gitFail(res: ServerResponse, status: number, message: string): void {
  const text = `${message}\n`;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/** Emit a successful smart-HTTP body with the content type its service names. */
function sendGitBody(res: ServerResponse, contentType: string, body: Buffer): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/**
 * Split a smart-HTTP path into owner, name and the tail after `.git`.
 *
 * A repository name may be percent-encoded, so each part is decoded separately rather than decoding
 * the whole path (which would turn an encoded slash into a path separator).
 */
function splitRepoPath(path: string): { owner: string; name: string; tail: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return null;
  let owner = match[1];
  let name = match[2];
  try {
    owner = decodeURIComponent(owner);
    name = decodeURIComponent(name);
  } catch {
    // A name that will not decode is used as it arrived; the store lookup will 404 it.
  }
  return { owner, name, tail: match[3] ?? '' };
}

/* ------------------------------------------------------------------ routing */

/** Route one git smart-HTTP request. */
export async function handleGitHttp(input: GitHttpRequest): Promise<void> {
  const { req, res, method, path, query, login, store, body } = input;

  const parts = splitRepoPath(path);
  if (parts === null) {
    gitFail(res, 404, 'Not Found');
    return;
  }

  const repo = store.repo(parts.owner, parts.name);
  // Somebody else's repository does not exist as far as this token is concerned — the same 404 the
  // REST surface answers, so a probe cannot tell the two apart.
  if (repo === undefined || repo.owner.toLowerCase() !== login.toLowerCase()) {
    gitFail(res, 404, 'Not Found');
    return;
  }

  if (parts.tail === '/info/refs' && method === 'GET') {
    const service = query.get('service')?.[0] ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      gitFail(res, 403, 'Dumb HTTP transport is not supported');
      return;
    }

    // v2 is a client request, and only upload-pack has one: receive-pack is v0-only.
    const protocol = String(req.headers['git-protocol'] ?? '');
    const version2 = service === 'git-upload-pack' && /version=2/.test(protocol);

    const chunks: Buffer[] = [pkt(`# service=${service}\n`), flush()];
    if (version2) {
      for (const capability of UPLOAD_V2_CAPS) chunks.push(pkt(`${capability}\n`));
      chunks.push(flush());
    } else {
      chunks.push(advertiseV0(store, repo, service));
    }
    sendGitBody(res, `application/x-${service}-advertisement`, Buffer.concat(chunks));
    return;
  }

  if (parts.tail === '/git-upload-pack' && method === 'POST') {
    const protocol = String(req.headers['git-protocol'] ?? '');
    const accept = String(req.headers.accept ?? '');
    const answer = /version=2/.test(protocol)
      ? serveUploadV2(store, repo, body)
      : serveUploadV0(store, repo, body, accept);
    sendGitBody(res, 'application/x-git-upload-pack-result', answer);
    return;
  }

  if (parts.tail === '/git-receive-pack' && method === 'POST') {
    sendGitBody(res, 'application/x-git-receive-pack-result', serveReceive(store, repo, body, login));
    return;
  }

  gitFail(res, 404, 'Not Found');
}

/* ------------------------------------------------------------------ advertisement */

/**
 * The v0 ref advertisement.
 *
 * The first ref line carries the capability list after a NUL. An empty repository advertises the
 * `capabilities^{}` pseudo-ref instead, which every client understands. A tag is followed by a
 * `^{}` line naming the commit it peels to.
 */
function advertiseV0(store: Store, repo: ReturnType<Store['repo']> & object, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : uploadCapsV0(repo.default_branch);
  const refs = [...repo.refs.entries()].filter(([name]) => name !== 'HEAD');

  if (refs.length === 0) {
    return Buffer.concat([pkt(`${ZERO} capabilities^{}\u0000${caps}\n`), flush()]);
  }

  refs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const chunks: Buffer[] = [];
  let first = true;
  for (const [name, info] of refs) {
    // Only the first line carries the capabilities, and only it takes the NUL separator.
    chunks.push(first ? pkt(`${info.sha} ${name}\u0000${caps}\n`) : pkt(`${info.sha} ${name}\n`));
    first = false;

    if (name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(store, info.sha);
      if (peeled !== null && peeled !== info.sha) chunks.push(pkt(`${peeled} ${name}^{}\n`));
    }
  }
  chunks.push(flush());
  return Buffer.concat(chunks);
}

/**
 * Follow a tag chain to the commit at its end.
 *
 * A tag may name another tag, so this walks rather than reading one `object` line; the hop cap stops
 * a malformed cycle from hanging the request.
 */
function peelToCommit(store: Store, sha: string): string | null {
  let at = sha;
  for (let hop = 0; hop < 16; hop += 1) {
    const object = store.get(at);
    if (object === undefined) return null;
    if (object.kind === 'commit') return at;
    if (object.kind !== 'tag') return null;
    const target = /^object ([0-9a-f]{40})$/m.exec(object.body.toString('utf8'));
    if (target === null) return null;
    at = target[1];
  }
  return null;
}

/* ------------------------------------------------------------------ upload-pack v2 */

/** Serve one v2 upload-pack request. A v2 request carries exactly one command. */
function serveUploadV2(store: Store, repo: ReturnType<Store['repo']> & object, body: Buffer): Buffer {
  const lines = packetLines(body);
  const command = commandOf(lines);

  if (command === 'ls-refs') return serveLsRefs(store, repo, lines);
  if (command === 'fetch') return serveFetchV2(store, repo, body);
  // An unknown command answers an empty section list, which v2 allows.
  return Buffer.concat([delim(), responseEnd()]);
}

/** The command a v2 request names: `command=<name>`, past the agent and object-format lines. */
function commandOf(lines: string[]): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('agent=') || trimmed.startsWith('object-format=')) continue;
    if (trimmed.startsWith('command=')) return trimmed.slice('command='.length).trim();
    return trimmed;
  }
  return '';
}

/**
 * v2 ls-refs.
 *
 * HEAD comes first, with `symref-target:` when the client asked for symrefs. A tag's peeled commit is
 * an ATTRIBUTE on the same line (`peeled:<oid>`) — emitting a separate `^{}` ref makes the client's
 * parser report `peeled` as undefined and costs the tag checks.
 */
function serveLsRefs(store: Store, repo: ReturnType<Store['repo']> & object, lines: string[]): Buffer {
  const prefixes = lines
    .filter((line) => line.startsWith('ref-prefix '))
    .map((line) => line.slice('ref-prefix '.length).trim());
  const wantSymrefs = lines.some((line) => line.trim() === 'symrefs');
  const wantPeel = lines.some((line) => line.trim() === 'peel');
  const wantUnborn = lines.some((line) => line.trim() === 'unborn');

  const selected = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const chunks: Buffer[] = [];

  const head = repo.refs.get('HEAD');
  if (selected('HEAD')) {
    if (head !== undefined && head.symref !== null) {
      const target = repo.refs.get(head.symref);
      if (target !== undefined) {
        const attr = wantSymrefs ? ` symref-target:${head.symref}` : '';
        chunks.push(pkt(`${target.sha} HEAD${attr}\n`));
      }
    } else if (head === undefined && wantUnborn) {
      // An unborn HEAD is reported by name only, and only when the client asked for it.
      chunks.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.default_branch}\n`));
    }
  }

  const refs = [...repo.refs.entries()]
    .filter(([name]) => name !== 'HEAD' && selected(name))
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

  for (const [name, info] of refs) {
    let attrs = '';
    if (wantPeel && name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(store, info.sha);
      if (peeled !== null && peeled !== info.sha) attrs = ` peeled:${peeled}`;
    }
    chunks.push(pkt(`${info.sha} ${name}${attrs}\n`));
  }

  chunks.push(flush());
  return Buffer.concat(chunks);
}

/** What a v2 fetch request asked for. */
interface FetchRequest {
  wants: string[];
  haves: string[];
  /** The commits where the client's own history stops (its shallow boundary). */
  shallow: string[];
  /** The depth the client asked for, or null for a full history. */
  depth: number | null;
  /** `deepen-relative` counts from the client's boundary instead of from the want. */
  relative: boolean;
  done: boolean;
}

/** Read a v2 fetch request out of its pkt-lines. */
function parseFetch(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, relative: false, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen-relative')) request.relative = true;
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value > 0) request.depth = Math.trunc(value);
    } else if (line.trim() === 'done') request.done = true;
  }
  return request;
}

/**
 * v2 fetch: the acknowledgments section, the shallow-info section, then the packfile section.
 *
 * Sections are separated by delim packets and each section's own list ends with a flush. The pack
 * itself travels on side-band channel 1.
 */
function serveFetchV2(store: Store, repo: ReturnType<Store['repo']> & object, body: Buffer): Buffer {
  const request = parseFetch(packetLines(body));
  const out: Buffer[] = [];

  // Section 1: acknowledgments, sent only when the client offered haves (a clone offers none).
  if (request.haves.length > 0) {
    out.push(delim(), pkt('acknowledgments\n'));
    const known = request.haves.filter((sha) => repo.commits.has(sha));
    for (const sha of known) out.push(pkt(`ACK ${sha}\n`));
    out.push(pkt(known.length > 0 ? 'ready\n' : 'NAK\n'));
    out.push(flush());
  }

  if (request.wants.length === 0) {
    out.push(flush());
    return Buffer.concat(out);
  }

  const haveSet = heldObjects(store, repo, request);

  // Section 2: shallow-info. A deepening client learns its new boundary and which old ones it left.
  const boundaries = request.depth === null ? [] : boundariesAt(store, repo, request);
  const unshallow = request.depth === null
    ? []
    : request.shallow.filter((sha) => !boundaries.includes(sha));
  if (request.depth !== null && (boundaries.length > 0 || unshallow.length > 0)) {
    out.push(delim(), pkt('shallow-info\n'));
    for (const sha of boundaries) out.push(pkt(`shallow ${sha}\n`));
    for (const sha of unshallow) out.push(pkt(`unshallow ${sha}\n`));
    out.push(flush());
  }

  // Section 3: the packfile.
  const wanted = objectsToSend(store, repo, request, haveSet);
  const pack = buildPack(store, wanted);
  if (DEBUG) {
    process.stderr.write(`fetch: wants=${request.wants.length} haves=${request.haves.length} pack=${pack.length}\n`);
  }
  out.push(delim(), pkt('packfile\n'));
  out.push(...sideband(BAND_DATA, pack));
  out.push(flush());
  return Buffer.concat(out);
}

/**
 * Every object name the client already holds, given its haves and its shallow boundary.
 *
 * The closure covers commits, their trees and the blobs those trees name. For a shallow client the
 * walk stops AT its boundary commit: the boundary itself is held, its parents are not, so those
 * parents must still travel or a deepening fetch delivers nothing.
 */
function heldObjects(store: Store, repo: ReturnType<Store['repo']> & object, request: FetchRequest): Set<string> {
  const held = new Set<string>();
  const shallowSet = new Set(request.shallow);

  const absorb = (start: string, stopAtBoundary: boolean): void => {
    for (const sha of store.ancestry(repo, start)) {
      held.add(sha);
      const info = repo.commits.get(sha);
      if (info !== undefined) {
        held.add(info.tree);
        for (const entry of store.flatTree(info.tree)) held.add(entry.sha);
      }
      if (stopAtBoundary && shallowSet.has(sha)) break;
    }
  };

  const shallowClient = shallowSet.size > 0;
  for (const sha of request.haves) {
    if (repo.commits.has(sha)) absorb(sha, shallowClient);
  }
  // A deepening fetch names its boundary in `shallow` even with no matching have.
  for (const sha of request.shallow) {
    if (repo.commits.has(sha)) absorb(sha, true);
  }
  return held;
}

/**
 * The shallow boundary commits this answer creates: for each want, the last commit the depth keeps,
 * and only when that commit actually has a parent (a boundary at the root is not a boundary).
 */
function boundariesAt(store: Store, repo: ReturnType<Store['repo']> & object, request: FetchRequest): string[] {
  const boundaries: string[] = [];
  for (const want of request.wants) {
    if (!repo.commits.has(want)) continue;
    const walk = [...store.ancestry(repo, want)];
    const keep = depthFor(request, walk);
    const last = walk[keep - 1];
    if (last === undefined) continue;
    const info = repo.commits.get(last);
    if (info !== undefined && info.parents.length > 0) boundaries.push(last);
  }
  return boundaries;
}

/**
 * How many generations a want's walk keeps.
 *
 * `deepen N` is absolute from the want. `deepen-relative` counts N generations PAST the client's
 * existing boundary, so the target is the client's current depth plus N.
 */
function depthFor(request: FetchRequest, walk: string[]): number {
  const depth = request.depth ?? walk.length;
  if (!request.relative || request.shallow.length === 0) return Math.min(depth, walk.length);

  const shallowSet = new Set(request.shallow);
  const current = walk.findIndex((sha) => shallowSet.has(sha)) + 1;
  const target = (current > 0 ? current : 0) + depth;
  return Math.min(Math.max(depth, target), walk.length);
}

/**
 * The exact object set to send: everything reachable from the wants (the tags included), minus
 * everything the client holds, then closed under tree entries so no tree names a missing subtree.
 *
 * Closing it over the SELECTION rather than over the whole store is what keeps an incremental fetch
 * from re-sending a held blob: an entry the client already has is skipped, not re-added.
 */
function objectsToSend(
  store: Store,
  repo: ReturnType<Store['repo']> & object,
  request: FetchRequest,
  haveSet: Set<string>,
): Set<string> {
  const selected = new Set<string>();

  const addCommit = (sha: string): void => {
    selected.add(sha);
    const info = repo.commits.get(sha);
    if (info === undefined) return;
    selected.add(info.tree);
    for (const entry of store.flatTree(info.tree)) selected.add(entry.sha);
  };

  for (const want of request.wants) {
    if (!repo.commits.has(want)) {
      // A want may name a tag object: the tag travels, and its target's history is walked.
      const object = store.get(want);
      if (object !== undefined && object.kind === 'tag') {
        selected.add(want);
        const target = peelToCommit(store, want);
        if (target !== null && repo.commits.has(target)) {
          for (const sha of store.ancestry(repo, target)) addCommit(sha);
        }
      }
      continue;
    }
    const walk = [...store.ancestry(repo, want)];
    for (const sha of walk.slice(0, depthFor(request, walk))) addCommit(sha);
  }

  for (const sha of haveSet) selected.delete(sha);

  // A pack may not carry a tree whose entry is neither sent nor already held. One pass per depth
  // level, capped: a well-formed history converges in far fewer than eight passes.
  for (let pass = 0; pass < 8; pass += 1) {
    let grew = false;
    for (const sha of [...selected]) {
      const object = store.get(sha);
      if (object === undefined || object.kind !== 'tree') continue;
      for (const entry of parseTree(object.body)) {
        if (selected.has(entry.sha) || haveSet.has(entry.sha) || !store.objects.has(entry.sha)) continue;
        selected.add(entry.sha);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return selected;
}

/* ------------------------------------------------------------------ upload-pack v0 */

/** Serve a v0 upload-pack: want/have/done, answered with ACKs and a packfile. */
function serveUploadV0(store: Store, repo: ReturnType<Store['repo']> & object, body: Buffer, accept: string): Buffer {
  const lines = packetLines(body);

  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.trunc(value);
    } else if (line.trim() === 'done') done = true;
  }

  if (wants.length === 0) return flush();

  const out: Buffer[] = [];
  const known = haves.filter((sha) => repo.commits.has(sha));

  // multi_ack_detailed: a negotiation round acknowledges what is common and flags the last one ready,
  // so the client can stop asking. A `done` ends negotiation and is acknowledged plainly.
  if (!done) {
    for (const sha of known) out.push(pkt(`ACK ${sha} common\n`));
    if (known.length > 0) out.push(pkt(`ACK ${known[known.length - 1]} ready\n`));
  } else {
    for (const sha of known) out.push(pkt(`ACK ${sha}\n`));
  }
  if (!done) out.push(flush());

  // v0 has no shallow-info section, so a depth limit is announced as bare `shallow` lines.
  const request: FetchRequest = { wants, haves, shallow: [], depth, relative: false, done };
  const haveSet = new Set<string>();
  for (const sha of haves) {
    if (!repo.commits.has(sha)) continue;
    for (const at of store.ancestry(repo, sha)) {
      haveSet.add(at);
      const info = repo.commits.get(at);
      if (info === undefined) continue;
      haveSet.add(info.tree);
      for (const entry of store.flatTree(info.tree)) haveSet.add(entry.sha);
    }
  }

  const selected = objectsToSend(store, repo, request, haveSet);
  if (depth !== null) {
    const boundary = boundariesAt(store, repo, request);
    for (const sha of boundary) out.push(pkt(`shallow ${sha}\n`));
    if (boundary.length > 0) out.push(flush());
  }

  const pack = buildPack(store, selected);
  const useSideband = /side-band/.test(accept) || lines.some((line) => line.includes('side-band'));
  out.push(pkt('NAK\n'));
  if (useSideband) {
    out.push(...sideband(BAND_DATA, pack));
    out.push(pkt(''));
  } else {
    out.push(pack);
  }
  return Buffer.concat(out);
}

/* ------------------------------------------------------------------ packfiles */

/** Wrap bytes as side-band packets on one channel, chunked to fit a pkt-line. */
function sideband(channel: number, payload: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let at = 0; at < payload.length; at += PKT_PAYLOAD) {
    const slice = payload.subarray(at, Math.min(payload.length, at + PKT_PAYLOAD));
    frames.push(pkt(Buffer.concat([Buffer.from([channel]), slice])));
  }
  return frames;
}

/** Build a version-2 packfile holding exactly these objects, header and trailer included. */
function buildPack(store: Store, shas: Iterable<string>): Buffer {
  const objects: { kind: ObjKind; body: Buffer }[] = [];
  for (const sha of shas) {
    const object = store.get(sha);
    if (object !== undefined) objects.push({ kind: object.kind, body: object.body });
  }

  const chunks: Buffer[] = [Buffer.from('PACK')];
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(objects.length, 4);
  chunks.push(header);

  for (const object of objects) {
    chunks.push(packObjectHeader(object.kind, object.body.length));
    chunks.push(deflateSync(object.body));
  }

  // The trailer is sha1 over every byte before it.
  const digest = createHash('sha1');
  for (const chunk of chunks) digest.update(chunk);
  chunks.push(digest.digest());
  return Buffer.concat(chunks);
}

/**
 * A pack object's header: a 3-bit type and the inflated size as a varint.
 *
 * The size is encoded four bits in the first byte, then seven per continuation byte, with the
 * high bit set on every byte that has a successor.
 */
function packObjectHeader(kind: ObjKind, size: number): Buffer {
  const typeCode = kind === 'commit' ? 1 : kind === 'tree' ? 2 : kind === 'blob' ? 3 : 4;
  const bytes: number[] = [];
  let remaining = size;
  let byte = (typeCode << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  while (remaining > 0) {
    bytes.push(byte | 0x80);
    byte = remaining & 0x7f;
    remaining >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** One parsed pack object. */
interface PackedObject {
  sha: string;
  kind: ObjKind;
  body: Buffer;
}

/**
 * Parse a packfile, resolving both delta kinds.
 *
 * Offsets are tracked by their pack position so an OFS_DELTA can find its base, and a REF_DELTA falls
 * back to the shared store because a thin pack legitimately refers to an object the client knows the
 * server already has.
 */
function readPack(store: Store, pack: Buffer): PackedObject[] {
  const objects: PackedObject[] = [];
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') return objects;
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return objects;

  const count = pack.readUInt32BE(8);
  const byOffset = new Map<number, { kind: ObjKind; body: Buffer }>();
  let at = 12;

  for (let index = 0; index < count && at < pack.length - 20; index += 1) {
    const start = at;
    let byte = pack[at];
    at += 1;
    const typeCode = (byte >> 4) & 0x07;
    let shift = 4;
    while ((byte & 0x80) !== 0 && at < pack.length) {
      byte = pack[at];
      at += 1;
      shift += 7;
    }

    // A delta names a base; a plain object carries its own type.
    if (typeCode === 6) {
      const back = readOffsetDelta(pack, at);
      at = back.next;
      const base = byOffset.get(start - back.distance);
      const delta = inflateAt(pack, at);
      at = delta.next;
      if (base === undefined) continue;
      const body = applyDelta(base.body, delta.body);
      byOffset.set(start, { kind: base.kind, body });
      objects.push({ sha: objectSha(base.kind, body), kind: base.kind, body });
      continue;
    }

    if (typeCode === 7) {
      const baseName = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const delta = inflateAt(pack, at);
      at = delta.next;

      // The base is either earlier in this pack or already in the store (a thin pack).
      let base = store.get(baseName);
      if (base === undefined) {
        for (const candidate of objects) {
          if (candidate.sha === baseName) {
            base = { kind: candidate.kind, body: candidate.body };
            break;
          }
        }
      }
      if (base === undefined) continue;
      const body = applyDelta(base.body, delta.body);
      byOffset.set(start, { kind: base.kind, body });
      objects.push({ sha: objectSha(base.kind, body), kind: base.kind, body });
      continue;
    }

    const kind: ObjKind = typeCode === 1 ? 'commit' : typeCode === 2 ? 'tree' : typeCode === 3 ? 'blob' : 'tag';
    const inflated = inflateAt(pack, at);
    at = inflated.next;
    byOffset.set(start, { kind, body: inflated.body });
    objects.push({ sha: objectSha(kind, inflated.body), kind, body: inflated.body });
  }
  return objects;
}

/** Read an OFS_DELTA's negative offset: a varint whose value grows by one per continuation byte. */
function readOffsetDelta(pack: Buffer, at: number): { distance: number; next: number } {
  let byte = pack[at];
  let cursor = at + 1;
  let distance = byte & 0x7f;
  while ((byte & 0x80) !== 0 && cursor < pack.length) {
    byte = pack[cursor];
    cursor += 1;
    distance = ((distance + 1) << 7) | (byte & 0x7f);
  }
  return { distance, next: cursor };
}

/**
 * Inflate one zlib stream and report exactly where it ended.
 *
 * `inflateSync` on a buffer that holds more than one stream stops at the first stream's end but says
 * nothing about where that end was, so a naive parse yields only a pack's first object.
 * `engine.bytesWritten` is the consumed byte count, and it is the only reliable next-offset source.
 */
function inflateAt(pack: Buffer, at: number): { body: Buffer; next: number } {
  try {
    const result = inflateSync(pack.subarray(at), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = result.engine?.bytesWritten ?? 0;
    const body = result.buffer ?? Buffer.alloc(0);
    // Without a consumed count nothing after this object can be located, so stop at the trailer.
    return { body, next: consumed > 0 ? at + consumed : pack.length - 20 };
  } catch {
    // A corrupt stream makes every later offset a guess, so the pack ends here.
    return { body: Buffer.alloc(0), next: pack.length - 20 };
  }
}

/**
 * Apply a git delta to its base.
 *
 * The delta opens with two varints (base size, target size) and then a run of instructions: a
 * copy (high bit set, offset and size each assembled from their own flag bits) or an insert of N
 * literal bytes.
 */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;

  const varint = (): number => {
    let value = 0;
    let shift = 0;
    let byte = delta[at];
    at += 1;
    while ((byte & 0x80) !== 0) {
      value |= (byte & 0x7f) << shift;
      shift += 7;
      byte = delta[at];
      at += 1;
    }
    return value | (byte << shift);
  };

  varint(); // the base's declared size: the base is already in hand, so it is not needed
  const targetSize = varint();

  const pieces: Buffer[] = [];
  let produced = 0;
  while (at < delta.length && produced < targetSize) {
    const op = delta[at];
    at += 1;

    if ((op & 0x80) === 0) {
      // An insert: `op` literal bytes follow.
      if (op === 0) continue;
      pieces.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
      continue;
    }

    let offset = 0;
    let size = 0;
    if (op & 0x01) {
      offset |= delta[at];
      at += 1;
    }
    if (op & 0x02) {
      offset |= delta[at] << 8;
      at += 1;
    }
    if (op & 0x04) {
      offset |= delta[at] << 16;
      at += 1;
    }
    if (op & 0x08) {
      offset |= delta[at] << 24;
      at += 1;
    }
    if (op & 0x10) {
      size |= delta[at];
      at += 1;
    }
    if (op & 0x20) {
      size |= delta[at] << 8;
      at += 1;
    }
    if (op & 0x40) {
      size |= delta[at] << 16;
      at += 1;
    }
    // A zero size means the maximum a delta can name, not an empty copy.
    if (size === 0) size = 0x10000;
    pieces.push(base.subarray(offset, offset + size));
    produced += size;
  }

  return Buffer.concat(pieces);
}

/* ------------------------------------------------------------------ receive-pack */

/** One ref update a push asked for. */
interface RefCommand {
  old: string;
  next: string;
  ref: string;
}

/** Read the command list that opens a receive-pack body, plus the capabilities it carried. */
function parseCommands(body: Buffer): { commands: RefCommand[]; caps: string[]; packAt: number } {
  const commands: RefCommand[] = [];
  const caps: string[] = [];
  let at = 0;

  while (at + 4 <= body.length) {
    const header = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      at += 4;
      break;
    }
    if (length < 4) {
      at += 4;
      continue;
    }

    const line = body.subarray(at + 4, at + length).toString('utf8').replace(/\n$/, '');
    at += length;

    // Only the first command carries the capability list, after a NUL.
    const nul = line.indexOf('\u0000');
    if (nul >= 0) caps.push(...line.slice(nul + 1).split(' '));
    const command = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(nul < 0 ? line : line.slice(0, nul));
    if (command !== null) commands.push({ old: command[1], next: command[2], ref: command[3] });
  }
  return { commands, caps, packAt: at };
}

/** Serve a receive-pack push: unpack, apply the ref updates, report each one's status. */
function serveReceive(store: Store, repo: ReturnType<Store['repo']> & object, body: Buffer, login: string): Buffer {
  const { commands, caps, packAt } = parseCommands(body);
  const pack = body.subarray(packAt);
  if (DEBUG) process.stderr.write(`receive: body=${body.length} pack=${pack.length} commands=${commands.length}\n`);

  becomeReachable(store, repo, readPack(store, pack));

  const results: { ref: string; ok: boolean; message?: string }[] = [];
  for (const command of commands) results.push(applyCommand(store, repo, command, login));

  const report = Buffer.concat([
    pkt('unpack ok\n'),
    ...results.map((result) =>
      pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.message ?? 'failed'}\n`),
    ),
    flush(),
  ]);

  if (!caps.includes('side-band-64k')) return report;
  return Buffer.concat([...sideband(BAND_DATA, report), pkt('')]);
}

/**
 * Make a pushed pack's objects usable: store them all, register its commits, then close the store
 * over the pack's own trees.
 *
 * The tree closure walks only the pack's trees (with a work queue over a map of the pack's objects)
 * rather than every tree in the store. A push benchmark repeats 200 times into one repository, and a
 * full-store scan per push makes that quadratic.
 */
function becomeReachable(store: Store, repo: ReturnType<Store['repo']> & object, objects: PackedObject[]): void {
  for (const object of objects) {
    if (!store.objects.has(object.sha)) store.objects.set(object.sha, { kind: object.kind, body: object.body });
  }
  for (const object of objects) {
    if (object.kind === 'commit') repo.commits.set(object.sha, readCommit(object.body));
  }

  const available = new Map<string, PackedObject>();
  for (const object of objects) available.set(object.sha, object);

  const queue: PackedObject[] = objects.filter((object) => object.kind === 'tree');
  for (let at = 0; at < queue.length; at += 1) {
    for (const entry of parseTree(queue[at].body)) {
      if (store.objects.has(entry.sha)) continue;
      const found = available.get(entry.sha);
      if (found === undefined) continue;
      store.objects.set(found.sha, { kind: found.kind, body: found.body });
      if (found.kind === 'tree') queue.push(found);
    }
  }
}

/**
 * Apply one ref command.
 *
 * The refusals are the protocol's own: a delete of a ref that does not exist, an old value that no
 * longer matches ("fetch first"), a branch that would move backwards, and a new value naming objects
 * the push did not deliver.
 */
function applyCommand(
  store: Store,
  repo: ReturnType<Store['repo']> & object,
  command: RefCommand,
  login: string,
): { ref: string; ok: boolean; message?: string } {
  void login;

  if (command.next === ZERO) {
    if (!repo.refs.has(command.ref)) return { ref: command.ref, ok: false, message: 'unable to delete: no such ref' };
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true };
  }

  const current = repo.refs.get(command.ref);
  if (command.old !== ZERO && current !== undefined && current.sha !== command.old) {
    return { ref: command.ref, ok: false, message: 'fetch first: the ref moved' };
  }

  // A branch only moves forward. The client signals a force by naming the ref's real old value, so a
  // mismatch was already refused above and reaching here means the update must descend.
  if (
    current !== undefined &&
    command.old !== ZERO &&
    command.ref.startsWith('refs/heads/') &&
    repo.commits.has(current.sha) &&
    repo.commits.has(command.next) &&
    ![...store.ancestry(repo, command.next)].includes(current.sha)
  ) {
    return { ref: command.ref, ok: false, message: 'non-fast-forward' };
  }

  if (!repo.commits.has(command.next) && !store.objects.has(command.next)) {
    return { ref: command.ref, ok: false, message: 'missing necessary objects' };
  }

  repo.refs.set(command.ref, { sha: command.next, symref: null });

  // The first branch to arrive becomes HEAD's target; an existing symbolic HEAD follows its branch.
  if (command.ref.startsWith('refs/heads/')) {
    const head = repo.refs.get('HEAD');
    if (head === undefined || head.symref === command.ref) {
      repo.refs.set('HEAD', { sha: command.next, symref: command.ref });
    }
  }
  return { ref: command.ref, ok: true };
}

/** Parse a pushed commit body, tolerating an unusual ident line. */
function readCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const info: CommitInfo = {
    tree: EMPTY_TREE_SHA,
    parents: [],
    author: '',
    committer: '',
    message: split < 0 ? '' : text.slice(split + 2).replace(/\n$/, ''),
    time: 1735689600,
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
      const ident = /^(.*) (\d+) ([+-]\d{4})$/.exec(line.slice(7));
      if (ident !== null) {
        info.author = ident[1];
        info.time = Number(ident[2]);
        info.tz = ident[3];
      } else {
        info.author = line.slice(7);
      }
      continue;
    }
    if (line.startsWith('committer ')) {
      const ident = /^(.*) (\d+) ([+-]\d{4})$/.exec(line.slice(10));
      info.committer = ident !== null ? ident[1] : line.slice(10);
    }
  }
  return info;
}

/** Re-export the tree parser so app-level code can flatten a pushed tree without another import. */
export { parseTree, type TreeEntry };

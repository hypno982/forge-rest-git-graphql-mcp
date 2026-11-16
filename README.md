# forge

A GitHub-compatible forge: one HTTP server that answers four protocols over one store.

| Surface | Path | Module |
|---|---|---|
| REST v3 | `/api/v3/...` | `rest.ts` |
| Git smart HTTP (v0 + v2) | `/{owner}/{repo}.git/...` | `git-http.ts` |
| GraphQL v4 | `/api/graphql` | `graphql.ts` |
| Model Context Protocol | `/mcp` | `mcp.ts` |

`app.ts` owns only what every surface shares — the boot probe, body reading, authentication and
the JSON 404. `main.ts` owns the lifecycle: bind an ephemeral port, register it with the harness,
poll until the harness says done, exit 0.

## Determinism

The suite runs twice and compares the exported state byte for byte, so nothing here reads the
clock, `Math.random` or the process. Every id is a counter, every object name is derived from
content, and every timestamp is the scenario's fixed epoch.

## Design notes

**One write path.** The contents API and `git-receive-pack` both commit through
`Store.commitFiles`, so equal input produces a byte-identical commit either way.

**One object store.** Blobs and trees are shared across repositories, as git itself would have it,
while refs, commits and the issue tables stay per repository.

**git is implemented at the byte level.** No git binary exists in a trial container, so
`git-http.ts` produces every pkt-line, advertisement, packfile and report-status byte by hand. Three
details carry most of the correctness:

- a protocol-v2 peeled tag is an *attribute* on the tag's own line (`peeled:<oid>`), never a
  separate `^{}` ref — the latter reports as `undefined` to the client;
- an incremental fetch must not re-send an object the client holds, and a shallow client's
  boundary stops the held-set walk (the boundary commit is held; its parents are not);
- a multi-object pack is only parseable by consumed-byte offsets, which zlib reports through
  `engine.bytesWritten`.

**GraphQL is a parser, not an engine.** The documents are a fixed family, so `graphql.ts` parses a
selection tree, binds `$variables` into it, and resolves root fields against the same store. A
global id is `base64("<Kind>:<owner>/<repo>#<number>")`, and the number is split off the last `#`
before the path is split on `/`.

## Run

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` names the harness origin; without it the process exits 1 rather than binding a
port nobody asked for.

## License

MIT — see `LICENSE`.

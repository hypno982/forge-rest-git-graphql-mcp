// main.ts: the lifecycle the harness owns. app.ts builds the server; this file carries it from
// "not listening" to "the env said stop".
//
// The contract, in order:
//   1. MAKEFUN_ENV_URL names the env's origin. Unset means there is nothing to register with, and
//      the process exits 1 without binding a port.
//   2. createApp(), then listen(0). The kernel picks a free port; 8080 belongs to the env.
//   3. POST $ENV/register {"port": N}. The env pins the caller's address plus N as this entry's
//      base URL. 200 is the normal answer; 409 means a peer registered first, which is fine, so
//      this process keeps polling like everyone else.
//   4. GET $ENV/done until {"done": true}. A live env answers immediately with done:false while
//      the suite runs, so this is a poll loop and never a long hold.
//   5. Close the server and exit 0. The harness then exports the state the scorer reads.
//
// Only our own module is imported: no package, no built-in, no model call.

import { createApp } from './app.ts';

/** The env origin with no trailing slash, or '' when the variable is unset. */
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');

if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is unset: no env to register with\n');
  process.exit(1);
}

/** Per-request ceiling for register and done. A slower answer is dropped and retried. */
const TIMEOUT_MS = 30_000;
/** The retry ladder: first wait, doubling cap, and the exponent ceiling. */
const WAIT_START_MS = 250;
const WAIT_CEIL_MS = 2_000;
const WAIT_STEPS = 8;

/** Sleep helper. */
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Wait after the n-th failure of a request. */
function backoff(n: number): number {
  return Math.min(WAIT_CEIL_MS, WAIT_START_MS * 2 ** Math.min(n, WAIT_STEPS));
}

/** A rejection that retrying cannot fix: the request itself is malformed. */
class ContractViolation extends Error {}

/**
 * POST the bound port until the env accepts it.
 *
 * 200 and 409 both end the loop. 400 and 405 mean the request we send can never be accepted, so
 * the process stops. Everything else (a network error, a 5xx while the env boots) is transient.
 */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let transient = false;
    try {
      const answer = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new ContractViolation(`register answered ${answer.status}: ${await answer.text()}`);
      }
      transient = true;
    } catch (error) {
      if (error instanceof ContractViolation) throw error;
      transient = true;
    }
    // A 5xx or a dropped connection: the env may still be booting.
    if (transient) await pause(backoff(attempt));
  }
}

/** Poll GET /done until it reports {"done": true}. Returns only after that. */
async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Silent on purpose: an unanswered poll is simply not done yet.
    }
    await pause(backoff(attempt));
  }
}

/** Bind the server and hand back the port the kernel chose. */
async function bind(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(0, () => ok());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  return { server, port: address.port };
}

/** The whole life of this process. */
async function run(): Promise<void> {
  const { server, port } = await bind();
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await announce(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

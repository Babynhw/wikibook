import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';

/**
 * The static origin the web-source steps fetch from, started inside the spec so
 * the walk has no network dependency (design "§21 End-to-end").
 *
 * One catch, and it is the backend's, not this file's: the ingestion worker's
 * SSRF guard (`backend/src/ingest/url-guard.ts`) refuses loopback, RFC 1918,
 * link-local, and unique-local destinations. A server on `127.0.0.1` or on a
 * `192.168.x.x` LAN address is therefore *permanently* rejected — the source
 * lands `failed` with "points to a private network". The worker can only reach
 * this server through an address the guard accepts, which on a typical dev
 * machine means one of:
 *
 *   - `E2E_FIXTURE_HOST` — a hostname or IP that resolves to this machine *and*
 *     is public (a DNS name on a routable address, or a tunnel that forwards to
 *     `E2E_FIXTURE_PORT`), or
 *   - a global IPv6 address on this machine, which `pickReachableHost()` finds
 *     on its own when there is one.
 *
 * With neither, `publicHost` is `null` and the spec skips the two web-source
 * steps with that reason rather than reporting a green run it did not earn.
 *
 * The flip side: when a global address exists the server is, for the length of
 * the run, reachable from outside this machine. It serves one static fixture
 * page and nothing else, binds an ephemeral port, and closes in `afterAll` —
 * acceptable for a dev-only walk, but do not point it at anything private.
 */
export interface FixtureServer {
  /** Serve the article normally. */
  succeed(): void;
  /** Answer every request with 500 — the worker treats 5xx as transient and exhausts its attempts. */
  fail(): void;
  /** Absolute URL of the article as the worker must fetch it, or null when no guard-safe host exists. */
  articleUrl: string | null;
  /** Why `articleUrl` is null, for the skip message. */
  unreachableReason: string | null;
  close(): Promise<void>;
}

// `__dirname`, not `import.meta.url`: the root workspace is CommonJS, so Playwright
// transpiles these files to CJS where `import.meta` is not available.
const ARTICLE_HTML = readFileSync(join(__dirname, 'article.html'), 'utf8');

export async function startFixtureServer(): Promise<FixtureServer> {
  let mode: 'ok' | 'error' = 'ok';

  const server: Server = createServer((request, response) => {
    if (mode === 'error') {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('fixture server is deliberately failing');
      return;
    }
    if (request.url === '/article' || request.url === '/article.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(ARTICLE_HTML);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  const requestedPort = Number(process.env.E2E_FIXTURE_PORT ?? 0);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Dual-stack: a global IPv6 address is the most likely guard-safe route in.
    server.listen(requestedPort, '::', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;

  const host = process.env.E2E_FIXTURE_HOST ?? pickReachableHost();
  const hostForUrl = host && isIP(host) === 6 ? `[${host}]` : host;

  return {
    succeed: () => {
      mode = 'ok';
    },
    fail: () => {
      mode = 'error';
    },
    articleUrl: hostForUrl ? `http://${hostForUrl}:${port}/article` : null,
    unreachableReason: hostForUrl
      ? null
      : 'no address of this machine passes the worker SSRF guard (url-guard.ts rejects loopback/private/ULA); set E2E_FIXTURE_HOST to a public hostname that resolves here',
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The first address of this machine the worker's guard would accept: a global
 * unicast IPv6 (2000::/3, excluding 2001:db8::/32) or a non-private IPv4. The
 * classification mirrors `url-guard.ts` closely enough for a dev machine; the
 * guard itself is the authority, and a wrong guess here surfaces as the web
 * source failing with the guard's own message.
 */
export function pickReachableHost(): string | null {
  const candidates = Object.values(networkInterfaces())
    .flat()
    .filter((iface): iface is NonNullable<typeof iface> => Boolean(iface) && !iface!.internal);

  for (const iface of candidates) {
    if (iface.family === 'IPv6' && isGlobalIpv6(iface.address)) return iface.address;
  }
  for (const iface of candidates) {
    if (iface.family === 'IPv4' && isPublicIpv4(iface.address)) return iface.address;
  }
  return null;
}

function isGlobalIpv6(address: string): boolean {
  const bare = address.split('%')[0]!.toLowerCase();
  if (address.includes('%')) return false; // zone id — link-local
  const first = Number.parseInt(bare.split(':')[0] || '0', 16);
  if ((first & 0xe000) !== 0x2000) return false; // outside 2000::/3
  if (first === 0x2001 && bare.split(':')[1] === 'db8') return false; // documentation
  if (first === 0x2002) return false; // 6to4 embeds an IPv4 the guard vets separately
  return true;
}

function isPublicIpv4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0 || b === 2 || b === 88)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

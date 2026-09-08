import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { UnretryableIngestError } from './errors.js';

/**
 * SSRF guard for web extraction (wiki-docs/plan/phase-2-ingestion/design.md
 * "Web extraction"): a URL is attacker-controlled input that aims the worker's
 * fetch at an address of their choosing, so loopback, private, link-local, and
 * unique-local destinations are rejected before every request and after every
 * redirect. Non-http(s) schemes are rejected outright.
 */
export async function assertSafeUrl(raw: string): Promise<void> {
  const url = parseHttpUrl(raw);
  // `URL.hostname` keeps the brackets on an IPv6 literal, but `net.isIP`
  // expects the bare address.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  const literalFamily = isIP(hostname);
  if (literalFamily === 4) {
    if (isUnsafeIpv4(hostname)) throw privateNetwork(raw);
    return;
  }
  if (literalFamily === 6) {
    if (isUnsafeIpv6(hostname)) throw privateNetwork(raw);
    return;
  }

  // A hostname resolves to potentially several addresses; the payload is safe
  // only if every one is. The lookup failing cleanly is treated as permanent —
  // the address has to be usable now for the fetch to have any point.
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new UnretryableIngestError('That web address could not be resolved.');
  }
  for (const { address } of addresses) {
    const family = isIP(address);
    const unsafe =
      (family === 4 && isUnsafeIpv4(address)) || (family === 6 && isUnsafeIpv6(address));
    if (unsafe) throw privateNetwork(raw);
  }
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnretryableIngestError('That web address is not valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnretryableIngestError('Only http:// and https:// web addresses can be added.');
  }
  if (url.username || url.password) {
    throw new UnretryableIngestError('That web address includes credentials, which are not allowed.');
  }
  return url;
}

const privateNetwork = (raw: string) =>
  new UnretryableIngestError('That web address points to a private network, which cannot be fetched.');

/** Parse strict dotted-quad into its four octets, or null. */
function ipv4Octets(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isUnsafeIpv4(hostname: string): boolean {
  const octets = ipv4Octets(hostname);
  if (!octets) return false;
  const a = octets[0]!;
  const b = octets[1]!;
  const c = octets[2]!;
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGN
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192) {
    // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1), 192.88.99.0/24 (6to4 relay)
    if (b === 0 || b === 2 || b === 88) return true;
  }
  if (a === 198) {
    // 198.18.0.0/15 benchmark, 198.51.100.0/24 TEST-NET-2
    if (b === 18 || b === 19 || b === 51) return true;
  }
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * Expand an IPv6 address to its eight 16-bit groups, or null if it is not one.
 *
 * Every check below works on the expanded form rather than the text, because
 * the text is not stable: `URL` canonicalises `::ffff:127.0.0.1` to the hex
 * form `::ffff:7f00:1` and `0:0:0:0:0:0:0:1` to `::1`, so a prefix or dotted-quad
 * match against `url.hostname` tests a spelling the parser may never produce.
 */
function ipv6Groups(hostname: string): number[] | null {
  const lower = hostname.toLowerCase();
  if (lower.includes('%')) return null; // a zone id is not an address we can vet
  const halves = lower.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    const parts = part.split(':');
    for (let index = 0; index < parts.length; index++) {
      const piece = parts[index]!;
      // A trailing dotted quad (`::ffff:127.0.0.1`) occupies the last two groups.
      if (piece.includes('.')) {
        if (index !== parts.length - 1) return null;
        const octets = ipv4Octets(piece);
        if (!octets) return null;
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

const dotted = (high: number, low: number) =>
  `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

function isUnsafeIpv6(hostname: string): boolean {
  const groups = ipv6Groups(hostname);
  if (!groups) return true; // an address we cannot parse is not one we can clear
  const [a, b, c, d, e, f, g, h] = groups as [
    number, number, number, number, number, number, number, number,
  ];

  if (groups.every((group) => group === 0)) return true; // ::  unspecified
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) {
    return true; // ::1 loopback
  }

  // An IPv4 address wearing an IPv6 costume routes to the v4 destination, so it
  // is vetted by the v4 rules: ::ffff:0:0/96 (mapped), ::/96 (compatible),
  // 64:ff9b::/96 (NAT64), and 2002::/16 (6to4, which embeds v4 in b:c).
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) {
    return isUnsafeIpv4(dotted(g, h));
  }
  if (a === 0x64 && b === 0xff9b) return isUnsafeIpv4(dotted(g, h));
  if (a === 0x2002) return isUnsafeIpv4(dotted(b, c));

  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}
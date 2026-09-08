import { describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn() };
});

import { lookup as lookupMock } from 'node:dns/promises';
import { assertSafeUrl } from '../src/ingest/url-guard.js';
import { UnretryableIngestError } from '../src/ingest/errors.js';

const resolvesTo = (addresses: string[]) => {
  (lookupMock as unknown as Mock).mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );
};

describe('assertSafeUrl (SSRF guard)', () => {
  it('accepts a public https address', async () => {
    resolvesTo(['93.184.216.34']);
    await expect(assertSafeUrl('https://example.com/article')).resolves.toBeUndefined();
  });

  it('rejects loopback, private, link-local, and multicast destinations', async () => {
    const unsafe = [
      'http://127.0.0.1/x',
      'https://0.0.0.0/x',
      'http://10.0.0.5/x',
      'https://172.16.0.1/x',
      'https://172.31.255.255/x',
      'https://192.168.1.1/x',
      'http://169.254.169.254/metadata', // the classic SSRF target
      'http://100.64.1.1/x', // CGNAT
      'http://224.0.0.1/x',
      'http://[::1]/x',
      'http://[fc00::1]/x',
      'http://[fe80::1]/x',
      'http://[2001:db8::1]/x',
    ];
    for (const url of unsafe) {
      const error = await assertSafeUrl(url).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(UnretryableIngestError);
      expect((error as UnretryableIngestError).userMessage).toMatch(/private network/);
    }
  });

  /**
   * `URL` canonicalises an IPv6 literal before the guard ever sees it —
   * `::ffff:127.0.0.1` becomes the hex form `::ffff:7f00:1`, and
   * `0:0:0:0:0:0:0:1` becomes `::1`. A guard that pattern-matches the text it
   * was handed therefore tests a spelling the parser may never produce; these
   * are the encodings that reach a v4 destination while looking like v6.
   */
  it('rejects an IPv4 destination wearing an IPv6 encoding', async () => {
    const unsafe = [
      'http://[::ffff:127.0.0.1]/x', // v4-mapped loopback, normalised to ::ffff:7f00:1
      'http://[::ffff:169.254.169.254]/metadata', // v4-mapped, the classic target
      'http://[::ffff:10.0.0.5]/x',
      'http://[64:ff9b::127.0.0.1]/x', // NAT64
      'http://[2002:7f00:1::]/x', // 6to4 embedding 127.0.0.1
      'http://[0:0:0:0:0:0:0:1]/x', // uncompressed loopback
      'http://[::]/x',
      'http://[febf::1]/x', // the top of fe80::/10
      'http://[ff02::1]/x',
    ];
    for (const url of unsafe) {
      const error = await assertSafeUrl(url).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error, url).toBeInstanceOf(UnretryableIngestError);
      expect((error as UnretryableIngestError).userMessage).toMatch(/private network/);
    }
  });

  it('accepts public IPv6 destinations, including a v4-mapped public address', async () => {
    for (const url of [
      'https://[2606:4700:4700::1111]/x',
      'https://[2a00:1450:4001:800::200e]/x',
      'https://[::ffff:93.184.216.34]/x',
      'https://[2002:5db8:d822::]/x', // 6to4 over a public v4
    ]) {
      await expect(assertSafeUrl(url), url).resolves.toBeUndefined();
    }
  });

  it('rejects a hostname that resolves to any unsafe address', async () => {
    resolvesTo(['198.51.100.1', '127.0.0.1']); // one safe, one loopback
    const error = await assertSafeUrl('https://mixed.example/x').then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnretryableIngestError);
  });

  it('rejects non-http(s) schemes outright', async () => {
    for (const url of ['ftp://example.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://x']) {
      const error = await assertSafeUrl(url).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(UnretryableIngestError);
    }
  });

  it('rejects a malformed address', async () => {
    await expect(assertSafeUrl('not a url')).rejects.toBeInstanceOf(UnretryableIngestError);
  });

  it('rejects a redirect target landing on a private range (re-checked after every hop)', async () => {
    // The guard is re-applied to the new location URL by extract-web's manual
    // redirect loop; this asserts the guard itself rejects the landing URL.
    resolvesTo(['10.1.1.1']);
    const error = await assertSafeUrl('https://redirect.example/landing').then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(UnretryableIngestError);
  });
});
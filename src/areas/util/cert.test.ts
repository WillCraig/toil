import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import { INTERMEDIATE_NAME, LEAF_NAME, makeCert, makeChain, ROOT_NAME, testKey } from '../../../test/harness/x509.js';
import type { Warning } from '../../core/envelope.js';
import { execute } from '../../core/run.js';
import { certCommand, EXAMPLE_PEM } from './cert.js';
import { decodeBundle, splitSans, type CertData } from './cert/decode.js';
import { certificateAt, DerError, integerHex, readTlv } from './cert/der.js';
import { Verifier } from './kit/verify.js';

/**
 * `util cert` against certificates made here (test/harness/x509.ts) and two
 * real public chains: a cross-signed CA and the root that signed it, as
 * published. Every check the command makes has a deliberately broken input
 * beside it, because a check nobody has seen fail is a check on paper only.
 */

const DAY = 86_400_000;
const chain = makeChain();
const fixtures = join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'certs');
const publicRsa = readFileSync(join(fixtures, 'public-rsa-chain.pem'), 'utf8');
const publicEcc = readFileSync(join(fixtures, 'public-ecc-chain.pem'), 'utf8');

/** Decodes `content` as if read at `now`, with the warnings it gave. */
const decode = (content: string | Uint8Array, options: { host?: string; now?: number } = {}) => {
  const warnings: Warning[] = [];
  const warn = (w: Warning) => warnings.push(w);
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const data = decodeBundle(bytes, 'the text', new Verifier(warn), { host: options.host, now: options.now ?? Date.now(), warn });
  return { data, warnings, codes: warnings.map((w) => w.code) };
};
const check = (data: CertData, name: string) => data.verified.checks.find((c) => c.check === name);
const colonHex = (hex: string) => hex.toUpperCase().match(/../g)!.join(':');

describe('util cert: decoding', () => {
  it('decodes a generated leaf, issuing CA and root, every field, and checks the chain end to end', () => {
    const { data, warnings } = decode(chain.pem);
    expect(warnings).toEqual([]);
    expect(data.format).toBe('pem');
    expect(data.certificates).toHaveLength(3);
    const [leaf, intermediate, root] = data.certificates;
    expect(leaf).toMatchObject({
      position: 1,
      line: 1,
      offset: null,
      subject: 'CN=api.imagile.dev',
      issuer: 'C=US, O=Imagile Test, CN=Imagile Test Issuing CA',
      sans: ['DNS:api.imagile.dev', 'DNS:*.imagile.dev'],
      serial: new X509Certificate(chain.leaf.der).serialNumber,
      key: { type: 'ec', bits: 256, curve: 'prime256v1' },
      signatureAlgorithm: { name: 'ecdsa-with-SHA256', oid: '1.2.840.10045.4.3.2' },
      selfSigned: false,
      basicConstraints: { ca: false, pathLength: null },
      keyUsage: ['digitalSignature'],
      extendedKeyUsage: ['serverAuth', 'clientAuth'],
      fingerprints: { sha256: colonHex(chain.leaf.sha256), sha1: colonHex(createHash('sha1').update(chain.leaf.der).digest('hex')) },
    });
    expect(leaf!.validity).toMatchObject({ status: 'valid', daysLeft: 89 });
    expect(intermediate).toMatchObject({ subject: 'C=US, O=Imagile Test, CN=Imagile Test Issuing CA', basicConstraints: { ca: true, pathLength: 0 }, keyUsage: ['digitalSignature', 'keyCertSign', 'cRLSign'], extendedKeyUsage: null, sans: [] });
    expect(root).toMatchObject({ selfSigned: true, key: { type: 'rsa', bits: 2048, curve: null }, signatureAlgorithm: { name: 'sha256WithRSAEncryption', oid: '1.2.840.113549.1.1.11' } });
    expect(data.chain).toEqual({
      inOrder: true,
      root: 'included',
      suggestedOrder: null,
      links: [
        { from: 1, to: 2, issuerMatches: true, signatureValid: true },
        { from: 2, to: 3, issuerMatches: true, signatureValid: true },
      ],
    });
    expect(data.verified.passed).toBe(true);
    expect(check(data, 'chain.order')).toMatchObject({ status: 'passed', checked: 2 });
    // Two links plus the root's own signature.
    expect(check(data, 'chain.signature')).toMatchObject({ status: 'passed', checked: 3 });
    expect(check(data, 'decode.matchesNode')).toMatchObject({ status: 'passed', checked: 3 });
    expect(check(data, 'validity.notExpired')).toMatchObject({ status: 'passed', checked: 3 });
  });

  it.each([
    ['RSA', publicRsa, 'CN=Microsoft TLS RSA Root G2', 'CN=DigiCert Global Root G2', { type: 'rsa', bits: 4096, curve: null }, 'sha384WithRSAEncryption'],
    ['ECC', publicEcc, 'CN=Microsoft TLS ECC Root G2', 'CN=DigiCert Global Root G3', { type: 'ec', bits: 384, curve: 'secp384r1' }, 'ecdsa-with-SHA384'],
  ])('decodes a real public %s chain, a cross-signed CA and its root, and verifies both signatures', (_kind, pem, subject, issuer, key, algorithm) => {
    const { data, warnings } = decode(pem, { now: Date.parse('2027-01-01T00:00:00Z') });
    expect(warnings).toEqual([]);
    const [ca, root] = data.certificates;
    expect(ca!.subject).toBe(`C=US, O=Microsoft Corporation, ${subject}`);
    expect(ca!.issuer.endsWith(issuer)).toBe(true);
    expect(ca!.key).toEqual(key);
    expect(ca!.signatureAlgorithm.name).toBe(algorithm);
    expect(ca!.basicConstraints?.ca).toBe(true);
    expect(ca!.keyUsage).toEqual(expect.arrayContaining(['keyCertSign', 'cRLSign']));
    expect(ca!.validity).toMatchObject({ notAfter: '2029-06-19T23:59:59.000Z', status: 'valid' });
    expect(root!).toMatchObject({ selfSigned: true, subject: expect.stringContaining(issuer) });
    expect(data.chain).toMatchObject({ inOrder: true, root: 'included', links: [{ issuerMatches: true, signatureValid: true }] });
    expect(data.verified.passed).toBe(true);
  });

  it("decodes a real public self-signed root from Node's own bundle", () => {
    const isrg = rootCertificates.find((p) => new X509Certificate(p).subject.endsWith('CN=ISRG Root X1'))!;
    const { data } = decode(isrg, { now: Date.parse('2027-01-01T00:00:00Z') });
    expect(data.certificates[0]).toMatchObject({
      subject: 'C=US, O=Internet Security Research Group, CN=ISRG Root X1',
      selfSigned: true,
      serial: '8210CFB0D240E3594463E0BB63828B00',
      key: { type: 'rsa', bits: 4096 },
      basicConstraints: { ca: true, pathLength: null },
      keyUsage: ['keyCertSign', 'cRLSign'],
    });
    expect(data.chain).toEqual({ inOrder: true, links: [], root: 'included', suggestedOrder: null });
  });

  it('reads DER, one certificate or several one after another', () => {
    const one = decode(chain.leaf.der);
    expect([one.data.format, one.data.certificates[0]!.subject, one.data.certificates[0]!.offset]).toEqual(['der', 'CN=api.imagile.dev', 0]);
    const bundle = decode(Buffer.concat([chain.leaf.der, chain.intermediate.der, chain.root.der]));
    expect(bundle.data.certificates.map((c) => [c.position, c.offset])).toEqual([
      [1, 0],
      [2, chain.leaf.der.length],
      [3, chain.leaf.der.length + chain.intermediate.der.length],
    ]);
    expect(bundle.data.chain.inOrder).toBe(true);
  });

  it('reads an Ed25519 certificate, with CRLF line endings and text around the blocks', () => {
    const { data } = decode(`subject=CN=example.imagile.dev\r\n${EXAMPLE_PEM.replace(/\n/g, '\r\n')}`);
    expect(data.certificates[0]).toMatchObject({ line: 2, key: { type: 'ed25519', bits: 256, curve: null }, signatureAlgorithm: { name: 'ED25519' }, selfSigned: true });
    expect(data.certificates[0]!.validity.notAfter).toBe('9999-12-31T23:59:59.000Z');
  });

  it('splits Node’s SAN list, unquoting the values it quotes', () => {
    expect(splitSans('DNS:a.imagile.dev, IP Address:10.0.0.1, email:you@example.com')).toEqual(['DNS:a.imagile.dev', 'IP Address:10.0.0.1', 'email:you@example.com']);
    expect(splitSans('DNS:"a,b.imagile.dev", DNS:c.imagile.dev')).toEqual(['DNS:a,b.imagile.dev', 'DNS:c.imagile.dev']);
    expect(splitSans(undefined)).toEqual([]);
  });
});

describe('util cert: the self-check catches a broken chain', () => {
  it('flags a reordered chain and gives the order that makes it one', () => {
    const { data, warnings } = decode(chain.root.pem + chain.leaf.pem + chain.intermediate.pem);
    expect(data.chain.inOrder).toBe(false);
    // Root to leaf is wrong; leaf to issuing CA happens to be right.
    expect(data.chain.links.map((l) => l.issuerMatches)).toEqual([false, true]);
    expect(data.chain.suggestedOrder).toEqual([2, 3, 1]);
    expect(data.verified.passed).toBe(false);
    expect(check(data, 'chain.order')).toMatchObject({ status: 'failed', checked: 2, failed: 1 });
    expect(warnings.find((w) => w.code === 'CERT_CHAIN_ORDER')?.message).toMatch(/^chain\.order at #1 \(line 1\) to #2 \(line \d+\): expected "C=US, O=Imagile Test, CN=Imagile Test Root CA", found "CN=api\.imagile\.dev"\. \(1 of 2 checks failed\)$/);
    expect(warnings.find((w) => w.code === 'CERT_CHAIN_REORDER')?.message).toBe('The certificates form one chain in a different order: #2, #3, #1, leaf first. Put them in that order.');
  });

  it('a bundle of unrelated certificates is flagged and gets no suggested order', () => {
    const other = makeChain();
    const { data, codes } = decode(chain.leaf.pem + other.leaf.pem);
    expect([data.chain.inOrder, data.chain.suggestedOrder]).toEqual([false, null]);
    expect(codes).toContain('CERT_CHAIN_ORDER');
    expect(codes).not.toContain('CERT_CHAIN_REORDER');
  });

  it('catches a mismatched issuer: the right name, signed by a different key', () => {
    const impostor = makeCert({ subject: LEAF_NAME, issuer: INTERMEDIATE_NAME, key: testKey(), signer: testKey(), sans: ['DNS:api.imagile.dev'] });
    const { data, warnings } = decode(impostor.pem + chain.intermediate.pem + chain.root.pem);
    expect(data.chain.links[0]).toEqual({ from: 1, to: 2, issuerMatches: true, signatureValid: false });
    expect(data.chain.inOrder).toBe(false);
    expect(check(data, 'chain.signature')).toMatchObject({ status: 'failed', checked: 3, failed: 1 });
    expect(warnings.find((w) => w.code === 'CERT_SIGNATURE_MISMATCH')?.message).toContain('at #1 (line 1) to #2');
  });

  it('catches a self-issued root whose signature is not its own', () => {
    const forged = makeCert({ subject: ROOT_NAME, key: testKey(), signer: testKey() });
    const { data, codes } = decode(forged.pem);
    expect(data.certificates[0]!.selfSigned).toBe(false);
    expect(data.chain.root).toBe('not-included');
    expect(check(data, 'chain.signature')).toMatchObject({ status: 'failed' });
    expect(codes).toContain('CERT_SIGNATURE_MISMATCH');
  });

  it('says when the root is not in the bundle, rather than calling the chain verified to it', () => {
    const { data, warnings } = decode(chain.leaf.pem + chain.intermediate.pem);
    expect(data.chain).toMatchObject({ inOrder: true, root: 'not-included' });
    expect(check(data, 'chain.root')).toMatchObject({ status: 'unchecked' });
    expect(warnings).toEqual([{ code: 'UNVERIFIED', message: "chain.root was not checked: the last certificate's issuer (C=US, O=Imagile Test, CN=Imagile Test Root CA) doesn't follow it in the bundle, so its signature wasn't checked." }]);
    expect(data.verified.passed).toBe(true);
  });

  it('flags an expired certificate and one not yet valid', () => {
    const now = Date.now();
    const expired = makeChain({ notBefore: new Date(now - 400 * DAY), notAfter: new Date(now - 10 * DAY - 1000) });
    const one = decode(expired.pem, { now });
    expect(one.data.certificates[0]!.validity).toMatchObject({ status: 'expired', daysLeft: -11 });
    expect(one.data.verified.passed).toBe(false);
    expect(one.warnings.find((w) => w.code === 'CERT_EXPIRED')?.message).toMatch(/^Certificate #1 \(line 1\) CN=api\.imagile\.dev expired on /);

    const early = makeChain({ notBefore: new Date(now + 5 * DAY), notAfter: new Date(now + 95 * DAY) });
    const two = decode(early.pem, { now });
    expect(two.data.certificates[0]!.validity.status).toBe('not-yet-valid');
    expect(two.codes).toContain('CERT_NOT_YET_VALID');
  });
});

describe('util cert: --host', () => {
  it('says which SAN covers the host, a wildcard included', () => {
    expect(decode(chain.pem, { host: 'api.imagile.dev' }).data.host).toEqual({ name: 'api.imagile.dev', certificate: 1, covered: true, matchedBy: 'DNS:api.imagile.dev', explanation: 'api.imagile.dev is covered by the SAN DNS:api.imagile.dev of certificate #1.' });
    expect(decode(chain.pem, { host: 'www.imagile.dev' }).data.host).toMatchObject({ covered: true, matchedBy: 'DNS:*.imagile.dev' });
  });

  it('explains why a host is not covered, and fails the check', () => {
    const { data, warnings } = decode(chain.pem, { host: 'a.b.imagile.dev' });
    expect(data.host).toMatchObject({ covered: false, matchedBy: null });
    expect(data.host!.explanation).toBe(
      "None of the SANs of certificate #1 (DNS:api.imagile.dev, DNS:*.imagile.dev) covers a.b.imagile.dev. A wildcard covers exactly one label, so *.imagile.dev doesn't cover a.b.imagile.dev.",
    );
    expect(data.verified.passed).toBe(false);
    expect(warnings).toContainEqual({ code: 'CERT_HOST_MISMATCH', message: data.host!.explanation });
  });

  it('does not treat a partial wildcard as one, as browsers do not', () => {
    const partial = makeCert({ subject: { CN: 'f.imagile.dev' }, key: testKey(), sans: ['DNS:f*.imagile.dev'] });
    expect(decode(partial.pem, { host: 'foo.imagile.dev' }).data.host).toMatchObject({ covered: false });
  });

  it('matches an IP address against IP SANs, and never a host against the CN', () => {
    const key = testKey();
    const withIp = makeCert({ subject: { CN: 'db.imagile.dev' }, key, sans: ['IP:10.0.0.5'] });
    expect(decode(withIp.pem, { host: '10.0.0.5' }).data.host).toMatchObject({ covered: true, matchedBy: 'IP Address:10.0.0.5' });
    const cnOnly = makeCert({ subject: { CN: 'db.imagile.dev' }, key });
    expect(decode(cnOnly.pem, { host: 'db.imagile.dev' }).data.host).toMatchObject({
      covered: false,
      explanation: "Certificate #1 has no DNS or IP subject alternative names, so it covers no host; its subject CN is db.imagile.dev, and clients don't match a host against the CN.",
    });
  });
});

describe('util cert: what it could not read, by position', () => {
  it('reports a damaged block by position and line, and still decodes the rest', () => {
    const damaged = chain.intermediate.pem.replace(/\n[A-Za-z0-9+/]{10}/, '\n!!!!!!!!!!');
    const { data, warnings } = decode(chain.leaf.pem + damaged + chain.root.pem);
    const line = chain.leaf.pem.split('\n').length;
    expect(data.skipped).toEqual([{ position: 2, line, offset: null, reason: 'its base64 is damaged' }]);
    expect(data.certificates.map((c) => c.position)).toEqual([1, 3]);
    expect(check(data, 'bundle.readable')).toMatchObject({ status: 'failed', checked: 3, failed: 1 });
    expect(warnings.find((w) => w.code === 'CERT_UNREADABLE')?.message).toBe(`bundle.readable at #2 (line ${line}): expected "a certificate", found "its base64 is damaged". (1 of 3 checks failed)`);
    // The leaf's issuer is now missing from the bundle, which the chain check says.
    expect(data.chain.links[0]).toMatchObject({ from: 1, to: 3, issuerMatches: false });
  });

  it('reports a block with no END line, and base64 that is not a certificate', () => {
    const notACert = `-----BEGIN CERTIFICATE-----\n${Buffer.from('not a certificate').toString('base64')}\n-----END CERTIFICATE-----\n`;
    const { data } = decode(`${chain.leaf.pem}${notACert}-----BEGIN CERTIFICATE-----\nMIIB\n`);
    expect(data.skipped.map((s) => [s.position, s.reason.split(' (')[0]])).toEqual([
      [2, 'it is not a certificate node:crypto can read'],
      [3, 'its CERTIFICATE block has no "-----END CERTIFICATE-----" line'],
    ]);
  });

  it('skips a private key without reading it, and says so', () => {
    const key = testKey().privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const { data, warnings } = decode(chain.leaf.pem + key);
    expect(data.skipped).toEqual([{ position: 2, line: chain.leaf.pem.split('\n').length, offset: null, reason: 'it is a PRIVATE KEY block, not a certificate; it was not read, and nothing from it is in the output' }]);
    // Not a damaged certificate, so the bundle still reads; the warnings say what was left out.
    expect(check(data, 'bundle.readable')).toMatchObject({ status: 'passed' });
    expect(warnings.map((w) => w.code)).toEqual(['CERT_PRIVATE_KEY_IN_INPUT', 'CERT_BLOCK_SKIPPED', 'UNVERIFIED']);
    const body = key.split('\n')[1]!;
    expect(JSON.stringify({ data, warnings })).not.toContain(body);
  });

  it('names a block whose label has a hyphen, rather than dropping it', () => {
    const crl = '-----BEGIN X509-CRL-----\nMIIB\n-----END X509-CRL-----\n';
    const { data, warnings } = decode(chain.leaf.pem + crl);
    expect(data.skipped).toEqual([{ position: 2, line: chain.leaf.pem.split('\n').length, offset: null, reason: 'it is a X509-CRL block, not a certificate' }]);
    expect(warnings.find((w) => w.code === 'CERT_BLOCK_SKIPPED')?.message).toContain('#2');
  });

  it('still recognises a private key cut short, and does not call it a damaged certificate', () => {
    const key = testKey().privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const cut = key.slice(0, key.indexOf('-----END'));
    const { data, codes } = decode(chain.leaf.pem + cut);
    expect(data.skipped[0]).toMatchObject({ position: 2, reason: expect.stringContaining('PRIVATE KEY block, not a certificate') });
    expect(codes).toContain('CERT_PRIVATE_KEY_IN_INPUT');
    expect(codes).not.toContain('CERT_UNREADABLE');
    expect(check(data, 'bundle.readable')).toMatchObject({ status: 'passed' });
  });

  it('reports a DER certificate cut short at its byte offset', () => {
    const cut = Buffer.concat([chain.leaf.der, chain.intermediate.der.subarray(0, 40)]);
    const { data } = decode(cut);
    expect(data.certificates).toHaveLength(1);
    expect(data.skipped).toEqual([{ position: 2, line: null, offset: chain.leaf.der.length, reason: expect.stringMatching(/says it is \d+ bytes long, but only 36 follow; the rest of the input was not read$/) }]);
  });

  it('catches the DER reader and node:crypto disagreeing: bytes after a certificate in its block', () => {
    const padded = Buffer.concat([chain.leaf.der, Buffer.from([0x05, 0x00])]);
    const pem = `-----BEGIN CERTIFICATE-----\n${padded.toString('base64')}\n-----END CERTIFICATE-----\n`;
    const { data, codes } = decode(pem);
    // node:crypto reads the certificate and ignores what follows; the outline sees it.
    expect(data.certificates).toHaveLength(1);
    expect(check(data, 'decode.matchesNode')).toMatchObject({ status: 'failed', failures: [{ at: '#1 (line 1)', actual: '2 bytes follow the certificate' }] });
    expect(codes).toContain('CERT_DECODE_MISMATCH');
  });

  it('refuses input with no readable certificate, naming each block', () => {
    const key = testKey().privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => decode(key)).toThrow(/^No certificate could be read from the text: #1 \(line 1\): it is a PRIVATE KEY block/);
    expect(() => decode('hello')).toThrow('The text is neither PEM (no "-----BEGIN" line) nor DER');
  });
});

describe('util cert: the DER reader', () => {
  it('reads serials as OpenSSL prints them, sign byte dropped and negatives marked', () => {
    const int = (...bytes: number[]) => {
      const buf = Uint8Array.from([0x02, bytes.length, ...bytes]);
      return integerHex(buf, readTlv(buf, 0));
    };
    expect([int(0x00, 0x82, 0x10), int(0x01, 0x23), int(0x00), int(0xff), int(0x80, 0x00)]).toEqual(['8210', '0123', '00', '-01', '-8000']);
  });

  it('refuses indefinite lengths and lengths past the end', () => {
    expect(() => readTlv(Uint8Array.from([0x30, 0x80, 0, 0]), 0)).toThrow(DerError);
    expect(() => readTlv(Uint8Array.from([0x30, 0x05, 0]), 0)).toThrow('says it is 5 bytes long, but only 1 follow');
    expect(() => certificateAt(Uint8Array.from([0x02, 0x01, 0x00]))).toThrow("doesn't start a certificate");
  });
});

describe('util cert: the command', () => {
  const files = { 'certs/chain.pem': chain.pem, 'certs/leaf.der': chain.leaf.der, 'certs/notes.txt': 'nothing here' };

  it('reads a file and checks it read all of it', async () => {
    const envelope = await execute(certCommand, { inputFile: 'certs/chain.pem', host: 'api.imagile.dev' }, testContext({ files }).context);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as CertData;
    expect([data.certificates.length, data.host?.covered, data.verified.passed]).toEqual([3, true, true]);
    expect(check(data, 'input.complete')).toMatchObject({ status: 'passed' });
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('reads DER from a file without a UTF-8 warning', async () => {
    const envelope = await execute(certCommand, { inputFile: 'certs/leaf.der' }, testContext({ files }).context);
    expect((envelope.data as CertData).format).toBe('der');
    expect(envelope.meta.warnings?.map((w) => w.code)).toEqual(['UNVERIFIED']);
  });

  it('reads PEM from stdin on the CLI, and says stdin has no size to check against', async () => {
    const run = await runCli(['util', 'cert', '--input-file', '-', '--host', 'nope.example.imagile.dev'], { commands: [certCommand], context: testContext({ stdin: chain.pem }).context });
    expect(run.envelope?.ok).toBe(true);
    const data = run.envelope?.data as CertData;
    expect(data.host?.covered).toBe(false);
    expect(check(data, 'input.complete')).toMatchObject({ status: 'unchecked' });
    expect(run.envelope?.meta.warnings?.map((w) => w.code)).toEqual(['UNVERIFIED', 'CERT_HOST_MISMATCH']);
  });

  it('refuses a file that is not a certificate, and an empty --host', async () => {
    const run = await runCli(['util', 'cert', 'certs/notes.txt'], { commands: [certCommand], context: testContext({ files }).context });
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The file "certs/notes.txt" is neither PEM (no "-----BEGIN" line) nor DER (it doesn\'t start with a DER sequence).' });
    expect(run.exitCode).toBe(1);
    const empty = await execute(certCommand, { inputFile: 'certs/chain.pem', host: '' }, testContext({ files }).context);
    expect(empty.error?.code).toBe('INVALID_INPUT');
  });
});

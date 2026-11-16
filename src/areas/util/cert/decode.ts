import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import type { Warning } from '../../../core/envelope.js';
import { ToilError } from '../../../core/errors.js';
import type { UtilInput } from '../kit/input.js';
import { Verifier, type Verified } from '../kit/verify.js';
import { certificateAt, DerError, readTlv, type DerCertificate } from './der.js';

/**
 * `util cert`'s work: split a PEM or DER bundle into certificates, decode
 * each with `node:crypto`'s X509Certificate (plus the DER reader for the
 * two fields it doesn't expose), and check the bundle as a chain: each
 * certificate's issuer is the next one's subject, and its signature verifies
 * against the next one's key. Nothing is fetched. A certificate whose issuer
 * isn't in the bundle stays unverified and says so, which is more than most
 * expired certificates managed before the outage review.
 */

const DAY = 86_400_000;

export interface CertificateSummary {
  /** 1-based, among every block or element in the bundle. */
  position: number;
  /** The line its PEM block starts on, for PEM input. */
  line: number | null;
  /** The byte its DER element starts at, for DER input. */
  offset: number | null;
  subject: string;
  issuer: string;
  /** Subject alternative names as `TYPE:value`: `DNS:api.imagile.dev`, `IP Address:10.0.0.1`. */
  sans: string[];
  serial: string;
  validity: { notBefore: string; notAfter: string; daysLeft: number; status: 'valid' | 'expired' | 'not-yet-valid' };
  key: { type: string | null; bits: number | null; curve: string | null };
  signatureAlgorithm: { name: string | null; oid: string | null };
  /** Its issuer is its own subject and its signature verifies with its own key. */
  selfSigned: boolean;
  basicConstraints: { ca: boolean; pathLength: number | null } | null;
  keyUsage: string[] | null;
  extendedKeyUsage: string[] | null;
  fingerprints: { sha1: string; sha256: string };
}

export interface SkippedBlock {
  position: number;
  line: number | null;
  offset: number | null;
  reason: string;
}

export interface ChainLink {
  /** The certificate's position. */
  from: number;
  /** The next certificate's position, which should have issued it. */
  to: number;
  issuerMatches: boolean;
  /** Null when the names don't match, so there was no issuer to verify against. */
  signatureValid: boolean | null;
}

export interface CertData {
  format: 'pem' | 'der';
  certificates: CertificateSummary[];
  skipped: SkippedBlock[];
  chain: {
    /** Every link's names match and every signature checked verifies. */
    inOrder: boolean;
    links: ChainLink[];
    /** Whether the last certificate is self-signed, so the bundle ends at its root. */
    root: 'included' | 'not-included';
    /** When the bundle isn't in order but is one chain in another order: the positions, leaf first. */
    suggestedOrder: number[] | null;
  };
  host: { name: string; certificate: number; covered: boolean; matchedBy: string | null; explanation: string } | null;
  verified: Verified;
}

interface Block {
  position: number;
  line: number | null;
  offset: number | null;
  der?: Uint8Array;
  /** Set for a block that isn't read: what it is, and whether it was meant to be a certificate. */
  skip?: { reason: string; damaged: boolean; privateKey?: true };
}

const CERT_LABELS = new Set(['CERTIFICATE', 'X509 CERTIFICATE']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Every `-----BEGIN …-----` block, certificate or not, in order. */
function pemBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const begins = [...text.matchAll(/-----BEGIN ([^\r\n]*?)-----/g)];
  // Lines are counted as the blocks go, once over the text, however many blocks it holds.
  let line = 1;
  let counted = 0;
  begins.forEach((begin, i) => {
    const label = begin[1]!;
    const position = i + 1;
    for (let nl = text.indexOf('\n', counted); nl !== -1 && nl < begin.index; nl = text.indexOf('\n', nl + 1)) line++;
    counted = begin.index;
    const bodyStart = begin.index + begin[0].length;
    const limit = begins[i + 1]?.index ?? text.length;
    // What a block is comes from its label, before anything else: a private key cut short is still a private key.
    if (!CERT_LABELS.has(label)) {
      const privateKey = /PRIVATE KEY/.test(label);
      blocks.push({
        position,
        line,
        offset: null,
        skip: { reason: `it is a ${label} block, not a certificate${privateKey ? '; it was not read, and nothing from it is in the output' : ''}`, damaged: false, ...(privateKey ? { privateKey: true as const } : {}) },
      });
      return;
    }
    const endMarker = `-----END ${label}-----`;
    const endAt = text.indexOf(endMarker, bodyStart);
    if (endAt === -1 || endAt > limit) {
      blocks.push({ position, line, offset: null, skip: { reason: `its ${label} block has no "${endMarker}" line`, damaged: true } });
      return;
    }
    const body = text.slice(bodyStart, endAt).replace(/\s+/g, '');
    if (!BASE64.test(body) || body.length % 4 !== 0) {
      blocks.push({ position, line, offset: null, skip: { reason: 'its base64 is damaged', damaged: true } });
      return;
    }
    blocks.push({ position, line, offset: null, der: Buffer.from(body, 'base64') });
  });
  return blocks;
}

/** DER certificates one after another. A damaged one ends the reading, since nothing says where the next starts. */
function derBlocks(bytes: Uint8Array): Block[] {
  const blocks: Block[] = [];
  for (let offset = 0, position = 1; offset < bytes.length; position++) {
    try {
      const tlv = readTlv(bytes, offset);
      if (tlv.tag !== 0x30) throw new DerError(`byte ${offset} doesn't start a certificate (a DER sequence)`);
      blocks.push({ position, line: null, offset, der: bytes.subarray(offset, tlv.end) });
      offset = tlv.end;
    } catch (err) {
      blocks.push({ position, line: null, offset, skip: { reason: `${(err as Error).message}; the rest of the input was not read`, damaged: true } });
      break;
    }
  }
  return blocks;
}

const where = (b: { position: number; line: number | null; offset: number | null }) =>
  `#${b.position}${b.line !== null ? ` (line ${b.line})` : b.offset !== null && b.offset > 0 ? ` (byte ${b.offset})` : ''}`;

const CURVE_BITS: Record<string, number> = { prime256v1: 256, secp256k1: 256, secp384r1: 384, secp521r1: 521, 'P-256': 256, 'P-384': 384, 'P-521': 521 };
const EDWARDS_BITS: Record<string, number> = { ed25519: 256, ed448: 448 };

const EKU_NAMES: Record<string, string> = {
  '1.3.6.1.5.5.7.3.1': 'serverAuth',
  '1.3.6.1.5.5.7.3.2': 'clientAuth',
  '1.3.6.1.5.5.7.3.3': 'codeSigning',
  '1.3.6.1.5.5.7.3.4': 'emailProtection',
  '1.3.6.1.5.5.7.3.8': 'timeStamping',
  '1.3.6.1.5.5.7.3.9': 'OCSPSigning',
  '2.5.29.37.0': 'anyExtendedKeyUsage',
};

function keyOf(cert: X509Certificate): CertificateSummary['key'] {
  try {
    const key = cert.publicKey;
    const type = key.asymmetricKeyType ?? null;
    const details = key.asymmetricKeyDetails ?? {};
    const curve = details.namedCurve ?? null;
    const bits = details.modulusLength ?? (curve ? CURVE_BITS[curve] : undefined) ?? (type ? EDWARDS_BITS[type] : undefined) ?? null;
    return { type, bits, curve };
  } catch {
    return { type: null, bits: null, curve: null };
  }
}

/** Node's `DNS:a, IP Address:b` list, with its JSON-quoted values unquoted. */
export function splitSans(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const entry = /([^:,]+):("(?:[^"\\]|\\.)*"|[^,]*)(?:, |$)/y;
  for (let m = entry.exec(text); m && m[0] !== ''; m = entry.exec(text)) {
    const value = m[2]!.startsWith('"') ? (JSON.parse(m[2]!) as string) : m[2]!;
    out.push(`${m[1]!.trim()}:${value}`);
  }
  return out;
}

const oneLine = (name: string) => name.split('\n').join(', ');

function verifies(cert: X509Certificate, issuer: X509Certificate): boolean | null {
  try {
    return cert.verify(issuer.publicKey);
  } catch {
    return null;
  }
}

interface Decoded {
  block: Block;
  x509: X509Certificate;
  outline: DerCertificate | null;
  summary: CertificateSummary;
}

function summarise(block: Block, x509: X509Certificate, outline: DerCertificate | null, now: number): CertificateSummary {
  const notBefore = x509.validFromDate;
  const notAfter = x509.validToDate;
  const status = now < notBefore.getTime() ? 'not-yet-valid' : now > notAfter.getTime() ? 'expired' : 'valid';
  const eku = x509.keyUsage;
  return {
    position: block.position,
    line: block.line,
    offset: block.offset,
    subject: oneLine(x509.subject),
    issuer: oneLine(x509.issuer),
    sans: splitSans(x509.subjectAltName),
    serial: x509.serialNumber,
    validity: { notBefore: notBefore.toISOString(), notAfter: notAfter.toISOString(), daysLeft: Math.floor((notAfter.getTime() - now) / DAY), status },
    key: keyOf(x509),
    signatureAlgorithm: { name: x509.signatureAlgorithm ?? null, oid: x509.signatureAlgorithmOid ?? null },
    selfSigned: x509.subject === x509.issuer && verifies(x509, x509) === true,
    basicConstraints: outline?.basicConstraints ?? null,
    keyUsage: outline?.keyUsage ?? null,
    extendedKeyUsage: eku ? eku.map((oid) => EKU_NAMES[oid] ?? oid) : null,
    fingerprints: { sha1: x509.fingerprint, sha256: x509.fingerprint256 },
  };
}

/**
 * Where each certificate's issuer is in the bundle (its subject and a
 * signature that verifies), and from there the one order that makes it a
 * chain, leaf first. Null when it isn't one chain in any order.
 */
export function chainOrder(certs: Array<Pick<Decoded, 'x509' | 'summary'>>): number[] | null {
  const issuerOf = certs.map((c, i) => certs.findIndex((other, j) => j !== i && other.x509.subject === c.x509.issuer && verifies(c.x509, other.x509) === true));
  const leaves = certs.map((_, i) => i).filter((i) => !issuerOf.includes(i));
  if (leaves.length !== 1) return null;
  const order: number[] = [];
  for (let at = leaves[0]!; at !== -1 && !order.includes(at); at = issuerOf[at]!) order.push(at);
  return order.length === certs.length ? order.map((i) => certs[i]!.summary.position) : null;
}

function hostCheck(v: Verifier, leaf: Decoded, host: string): NonNullable<CertData['host']> {
  const ip = isIP(host) !== 0;
  const matched = ip ? leaf.x509.checkIP(host) : leaf.x509.checkHost(host, { subject: 'never', wildcards: true, partialWildcards: false, multiLabelWildcards: false });
  const sans = leaf.summary.sans;
  const hostSans = sans.filter((s) => s.startsWith('DNS:') || s.startsWith('IP Address:'));
  let matchedBy: string | null = null;
  let explanation: string;
  if (matched !== undefined) {
    matchedBy = ip ? (sans.find((s) => s.startsWith('IP Address:') && s.slice(11) === matched) ?? `IP Address:${matched}`) : `DNS:${matched}`;
    explanation = `${host} is covered by the SAN ${matchedBy} of certificate #${leaf.summary.position}.`;
  } else if (hostSans.length === 0) {
    const cn = /(?:^|\n)CN=([^\n]*)/.exec(leaf.x509.subject)?.[1];
    explanation = `Certificate #${leaf.summary.position} has no DNS or IP subject alternative names, so it covers no host${cn ? `; its subject CN is ${cn}, and clients don't match a host against the CN` : ''}.`;
  } else {
    explanation = `None of the SANs of certificate #${leaf.summary.position} (${hostSans.join(', ')}) covers ${host}.`;
    const wildcard = ip ? undefined : hostSans.find((s) => s.startsWith('DNS:*.') && host.endsWith(s.slice(5)));
    if (wildcard) explanation += ` A wildcard covers exactly one label, so ${wildcard.slice(4)} doesn't cover ${host}.`;
  }
  v.expect('host.covered', matched !== undefined, { at: where(leaf.summary), expected: host, actual: hostSans }, { code: 'CERT_HOST_MISMATCH', message: explanation });
  return { name: host, certificate: leaf.summary.position, covered: matched !== undefined, matchedBy, explanation };
}

export interface DecodeOptions {
  host?: string | undefined;
  /** The time validity is judged at, in ms. */
  now: number;
  warn: (warning: Warning) => void;
}

/** Decodes and checks a bundle, read whole from `input`. */
export async function decodeCertInput(input: UtilInput, options: DecodeOptions): Promise<CertData> {
  const bytes = await input.bytes();
  const v = new Verifier(options.warn);
  v.inputComplete(input);
  return decodeBundle(bytes, input.label, v, options);
}

export function decodeBundle(bytes: Uint8Array, label: string, v: Verifier, options: DecodeOptions): CertData {
  const text = new TextDecoder('utf-8').decode(bytes);
  const format = text.includes('-----BEGIN ') ? 'pem' : 'der';
  if (format === 'der' && bytes[0] !== 0x30) {
    throw new ToilError('INVALID_INPUT', `${label[0]!.toUpperCase()}${label.slice(1)} is neither PEM (no "-----BEGIN" line) nor DER (it doesn't start with a DER sequence).`, {
      fix: 'Pass a certificate in PEM (-----BEGIN CERTIFICATE-----) or DER. Over MCP, pass a DER file as inputFile, since text is read as UTF-8.',
    });
  }
  const blocks = format === 'pem' ? pemBlocks(text) : derBlocks(bytes);

  const skipped: SkippedBlock[] = [];
  const decoded: Decoded[] = [];
  const notCertificates: SkippedBlock[] = [];
  const skip = (block: Block, reason: string, damaged: boolean) => {
    const entry = { position: block.position, line: block.line, offset: block.offset, reason };
    skipped.push(entry);
    if (!damaged) notCertificates.push(entry);
    v.expect('bundle.readable', !damaged, { at: where(block), expected: 'a certificate', actual: reason }, { code: 'CERT_UNREADABLE' });
  };
  for (const block of blocks) {
    if (block.skip) {
      skip(block, block.skip.reason, block.skip.damaged);
      if (block.skip.privateKey) {
        options.warn({ code: 'CERT_PRIVATE_KEY_IN_INPUT', message: `Block ${where(block)} of the input is a private key. It wasn't read; keep private keys out of files you share or paste.` });
      }
      continue;
    }
    let x509: X509Certificate;
    try {
      x509 = new X509Certificate(block.der!);
    } catch (err) {
      skip(block, `it is not a certificate node:crypto can read (${(err as Error).message})`, true);
      continue;
    }
    let outline: DerCertificate | null = null;
    try {
      outline = certificateAt(block.der!);
      if (outline.end !== block.der!.length) throw new DerError(`${block.der!.length - outline.end} bytes follow the certificate`);
    } catch (err) {
      v.fail('decode.matchesNode', { at: where(block), expected: 'a DER outline toil can read', actual: (err as Error).message }, { code: 'CERT_DECODE_MISMATCH' });
    }
    if (outline) {
      // The DER reader and OpenSSL must agree on what both read, or one of them misread the certificate.
      v.equal('decode.matchesNode', { serial: x509.serialNumber, ca: x509.ca }, { serial: outline.serial, ca: outline.basicConstraints?.ca ?? false }, { at: where(block), code: 'CERT_DECODE_MISMATCH' });
    }
    v.pass('bundle.readable');
    decoded.push({ block, x509, outline, summary: summarise(block, x509, outline, options.now) });
  }
  if (notCertificates.length > 0) {
    const one = notCertificates.length === 1;
    options.warn({
      code: 'CERT_BLOCK_SKIPPED',
      message: `${notCertificates.length} block${one ? '' : 's'} of the input ${one ? 'is not a certificate and was' : 'are not certificates and were'} skipped: ${notCertificates.map((s) => `${where(s)}, ${s.reason}`).join('; ')}.`,
    });
  }

  if (decoded.length === 0) {
    const why = skipped.length ? `: ${skipped.map((s) => `${where(s)}: ${s.reason}`).join('; ')}` : '';
    throw new ToilError('INVALID_INPUT', `No certificate could be read from ${label}${why}.`, {
      fix: 'Pass a certificate or chain in PEM (-----BEGIN CERTIFICATE-----) or DER. Over MCP, pass a DER file as inputFile, since text is read as UTF-8.',
    });
  }

  for (const { summary } of decoded) {
    const name = `${where(summary)} ${summary.subject}`;
    v.expect('validity.notExpired', summary.validity.status !== 'expired', { at: name, expected: `valid until ${summary.validity.notAfter}`, actual: 'expired' }, { code: 'CERT_EXPIRED', message: `Certificate ${name} expired on ${summary.validity.notAfter}.` });
    v.expect('validity.started', summary.validity.status !== 'not-yet-valid', { at: name, expected: `valid from ${summary.validity.notBefore}`, actual: 'not yet valid' }, { code: 'CERT_NOT_YET_VALID', message: `Certificate ${name} is not valid until ${summary.validity.notBefore}.` });
  }

  const links: ChainLink[] = [];
  for (let i = 0; i + 1 < decoded.length; i++) {
    const cert = decoded[i]!;
    const next = decoded[i + 1]!;
    const issuerMatches = cert.x509.issuer === next.x509.subject;
    const at = `${where(cert.summary)} to ${where(next.summary)}`;
    v.expect('chain.order', issuerMatches, { at, expected: cert.summary.issuer, actual: next.summary.subject }, { code: 'CERT_CHAIN_ORDER' });
    let signatureValid: boolean | null = null;
    if (issuerMatches) {
      signatureValid = verifies(cert.x509, next.x509);
      if (signatureValid === null) v.unchecked('chain.signature', `node:crypto could not verify the signature of ${where(cert.summary)} with the key of ${where(next.summary)}`);
      else v.expect('chain.signature', signatureValid, { at, expected: `signed by the key of ${where(next.summary)}`, actual: 'signature does not verify' }, { code: 'CERT_SIGNATURE_MISMATCH' });
    }
    links.push({ from: cert.summary.position, to: next.summary.position, issuerMatches, signatureValid });
  }
  const last = decoded[decoded.length - 1]!;
  const selfIssued = last.x509.subject === last.x509.issuer;
  if (selfIssued) {
    const own = verifies(last.x509, last.x509);
    if (own === null) v.unchecked('chain.signature', `node:crypto could not verify the signature of ${where(last.summary)} with its own key`);
    else v.expect('chain.signature', own, { at: `${where(last.summary)} (self-issued)`, expected: 'signed by its own key', actual: 'signature does not verify' }, { code: 'CERT_SIGNATURE_MISMATCH' });
  } else {
    v.unchecked('chain.root', `the last certificate's issuer (${last.summary.issuer}) doesn't follow it in the bundle, so its signature wasn't checked`);
  }

  const inOrder = links.every((l) => l.issuerMatches && l.signatureValid !== false);
  let suggestedOrder: number[] | null = null;
  if (!inOrder) {
    suggestedOrder = chainOrder(decoded);
    if (suggestedOrder) {
      options.warn({ code: 'CERT_CHAIN_REORDER', message: `The certificates form one chain in a different order: ${suggestedOrder.map((p) => `#${p}`).join(', ')}, leaf first. Put them in that order.` });
    }
  }

  const host = options.host === undefined ? null : hostCheck(v, decoded[0]!, options.host);
  return {
    format,
    certificates: decoded.map((d) => d.summary),
    skipped,
    chain: { inOrder, links, root: selfIssued && last.summary.selfSigned ? 'included' : 'not-included', suggestedOrder },
    host,
    verified: v.done(),
  };
}

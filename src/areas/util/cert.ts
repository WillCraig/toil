import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import { fileArgument, inputFields, openInput, inputFileOption, textOption } from './kit/input.js';

/**
 * `util cert`: decodes a certificate or a chain bundle, PEM or DER, and checks
 * it as a chain, so an agent can explain a TLS failure from the files alone.
 * It never connects to the host the certificate is for; fetching one would
 * make it a different command, with a network, and a change request. The
 * definition stays small for startup; the work loads when the command runs.
 */

/** A placeholder chain for the examples, in the util fixture. */
export const EXAMPLE_CHAIN = 'certs/chain.pem';

/**
 * A self-signed Ed25519 certificate for example.imagile.dev, valid until
 * 9999-12-31 (RFC 5280's "no expiry"), so the example never expires. Its
 * private key was thrown away when it was made; it exists only to be decoded.
 */
export const EXAMPLE_PEM = `-----BEGIN CERTIFICATE-----
MIIBLDCB36ADAgECAgEBMAUGAytlcDAeMRwwGgYDVQQDDBNleGFtcGxlLmltYWdp
bGUuZGV2MCAXDTI2MDEwMTAwMDAwMFoYDzk5OTkxMjMxMjM1OTU5WjAeMRwwGgYD
VQQDDBNleGFtcGxlLmltYWdpbGUuZGV2MCowBQYDK2VwAyEA2s40URL4VTaKOOP7
FUgO/ZY2e0jHLvuRLo3t1HeZuuKjQDA+MB4GA1UdEQQXMBWCE2V4YW1wbGUuaW1h
Z2lsZS5kZXYwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwBQYDK2VwA0EA
bhxmq3p0vik7KuQhOYS+R72eE0TSgwqJ857nr4ttFpGz7KCz4Aw7bmQA699Ugsrd
Yyz/n40UHvlELQoYlp/BDQ==
-----END CERTIFICATE-----
`;

export const certCommand = defineCommand({
  path: ['util', 'cert'],
  description: 'Decode certificates (PEM or DER, one or a chain) and check the chain order, signatures, validity and an optional host (local only, no network)',
  toolDescription:
    "Decodes X.509 certificates from a PEM or DER file, or PEM text: a single certificate or a chain bundle. Never connects to a host. For each certificate returns subject, issuer, sans, serial, validity { notBefore, notAfter, daysLeft, status }, key { type, bits, curve }, signatureAlgorithm, selfSigned, basicConstraints, keyUsage, extendedKeyUsage and fingerprints { sha1, sha256 }. It checks the bundle as a chain in the order given (each certificate's issuer must be the next one's subject, and its signature must verify against the next one's key), flags expired and not-yet-valid certificates, and suggests the right order when the bundle is one chain out of order. With host, it says whether the first certificate's SANs cover that host name or IP, and why not. A block it couldn't read, or one that isn't a certificate (a private key, say), is reported by its position. data.verified lists what was checked; meta.warnings says what failed or couldn't be checked. Over MCP a DER file must be passed as file.",
  input: z.object({
    ...inputFields,
    host: z.string().min(1).optional().describe('A host name or IP address: does the first certificate cover it?'),
  }),
  writes: false,
  args: [fileArgument],
  options: [inputFileOption, textOption, { flags: '--host <host>', field: 'host', description: 'A host name or IP address: does the first certificate cover it?' }],
  examples: [{ inputFile: EXAMPLE_CHAIN }, { inputFile: EXAMPLE_CHAIN, host: 'api.imagile.dev' }, { inputFile: 'certs/leaf.der', host: 'imagile.dev' }, { text: EXAMPLE_PEM, host: 'example.imagile.dev' }],
  run: async (input, ctx) => {
    const { decodeCertInput } = await import('./cert/decode.js');
    const opened = await openInput(ctx, input, { binary: 'allow', utf8: 'skip' });
    return decodeCertInput(opened, { host: input.host, now: Date.now(), warn: ctx.warn });
  },
});

export const certCommands = [certCommand];

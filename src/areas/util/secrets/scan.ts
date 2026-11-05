import { createHash, scryptSync } from 'node:crypto';
import type { CommandContext } from '../../../core/context.js';
import { ToilError } from '../../../core/errors.js';
import { LIST_FOLDER_IGNORED } from '../../../core/gitignore.js';
import { findSecrets, TOKEN_SHAPES, type SecretMatch } from '../../../core/secret-shapes.js';
import { execOutput, requireRepo, runGit } from '../../git/runner.js';
import { DEFAULT_MAX_BYTES, openInput, type InputLine } from '../kit/input.js';
import { Verifier, type Verified } from '../kit/verify.js';

/**
 * `util secrets scan`: credential-shaped strings in a file, a folder, stdin,
 * text, or the repository's staged or working-tree diff, found with the same
 * rules the audit log redacts with (`findSecrets`), plus an entropy rule of
 * this command's own for random-looking runs those rules don't reach.
 *
 * The one promise that matters: no output carries a whole secret. A finding
 * holds where it is, which rule found it, a masked preview (checked, and fully
 * masked if the check fails) and a fingerprint, a slow salted hash, so a
 * short password can't be read back from it by guessing at speed. The secret
 * itself is held only while its line is scanned, and never passed to the
 * Verifier, a warning or an error. Every finding is then re-read at its
 * reported position, from the file, the index or the working tree, so the
 * line, column and rule in the output are ones the source still bears out.
 *
 * Ruling on receipt of a credential: it is to be logged as received, filed
 * under its fingerprint, and never, under any circumstances, photocopied.
 */

type Ctx = CommandContext<unknown, Record<string, string | undefined>>;

export type Confidence = 'high' | 'medium' | 'low';
export type DiffKind = 'staged' | 'working';

export interface Finding {
  /** Relative to the workspace, forward slashes; null for stdin and text. */
  file: string | null;
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units, as most editors count them. */
  column: number;
  /** For a private key spanning lines: the line it ends on. */
  endLine?: number;
  /** The secret's length in characters. */
  length: number;
  rule: string;
  confidence: Confidence;
  /** Shannon entropy of the secret, in bits per character, to two places. */
  entropy: number;
  /** The secret with its middle masked: at most 4 characters at each end, none below 16 characters. */
  preview: string;
  /** What the allow file names: a salted scrypt of the secret, 32 hex digits in four groups of 8. */
  fingerprint: string;
}

export type UnreadableReason = 'binary' | 'too-large' | 'unreadable' | 'line-too-long' | 'nested-repository';

export interface Unreadable {
  file: string | null;
  /** For `line-too-long`: the line that was cut. */
  line?: number;
  reason: UnreadableReason;
  message: string;
}

export interface ScanOptions {
  file?: string | undefined;
  text?: string | undefined;
  diff?: DiffKind | undefined;
  allowFile?: string | undefined;
  /** Tests only: a masker to prove the preview check catches a broken one. */
  mask?: (secret: string) => string;
}

export interface ScanData {
  source: { kind: 'file' | 'folder' | 'stdin' | 'text' | DiffKind; path: string | null };
  findings: Finding[];
  /** Findings the allow file names by fingerprint: reported, and not counted towards the exit code. */
  allowed: Finding[];
  unreadable: Unreadable[];
  allowList: { file: string; entries: number; invalid: number; unused: number } | null;
  summary: { files: number; lines: number; findings: number; allowed: number; unreadable: number; checksums: number; placeholders: number; byRule: Record<string, number> };
  verified: Verified;
}

/** Where the allow file is read from when none is named: beside the toil projects, at the workspace's top. */
export const DEFAULT_ALLOW_FILE = '.toil/secrets-allow';
/** A line this long is cut and reported; minified bundles fit, generated blobs may not. */
const MAX_LINE = 4 * 1024 * 1024;
/** Keeps a pathological private key from holding the whole input in memory for its fingerprint. */
const MAX_KEY_TEXT = 1024 * 1024;
const MASK = '…';

const SHAPE_RULES = new Set(TOKEN_SHAPES.map((s) => s.id));
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** A BEGIN line and nothing else: the only start a key spread over the lines below it has. */
const KEY_HEADER = /^-----BEGIN [A-Z ]*PRIVATE KEY-----$/;
/** What a key's body is made of: base64 lines (`=` only as padding at the end), blank lines, and an encrypted PEM key's two headers. */
const KEY_BODY = /^(?:[A-Za-z0-9+/]+={0,2}|\s*|Proc-Type:.*|DEK-Info:.*)$/;
/** Subresource Integrity digests (`sha512-…` in lockfiles): random by design, and public. */
const SRI = /\bsha(?:1|256|384|512)-[A-Za-z0-9+/]{16,}={0,2}/g;
/** Candidates for the entropy rule: base64 and base64url runs, which `/`, `-` and `+` don't break. */
const ENTROPY_RUN = /[A-Za-z0-9+/_=-]{20,}/g;
const FINGERPRINT = /^[0-9a-f]{8}(?:-[0-9a-f]{8}){3}$/;

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...value].length;
  let h = 0;
  for (const c of counts.values()) h -= (c / n) * Math.log2(c / n);
  return h;
}

/** `${VAR}`, `$(cmd)`, `%VAR%`, `{{ x }}`, `<your-token>`, `***`, `xxx`: a reference to a secret, or a blank for one, not one itself. */
const PLACEHOLDER = /^(?:\$\{|\$\(|\$[A-Za-z_]|%[A-Za-z_]+%|\{\{|<[^>]*>$|\*{3,}$|x{3,}$|\[redacted)/i;

/** The rules that read a value from the name or scheme in front of it, where a placeholder can stand in for the secret. */
const CONTEXT_RULES = new Set(['name-value', 'user-flag', 'authorization-value', 'url-credentials']);

/**
 * How sure a finding is. A token shape is a vendor's own format: high. A value
 * a name or scheme marks as secret is high unless it is too short and plain
 * to be a real one. A long random run is graded by its entropy alone.
 */
export function confidenceOf(rule: string, value: string, h = entropy(value)): Confidence {
  if (SHAPE_RULES.has(rule)) return 'high';
  if (rule === 'high-entropy') return h >= 4.6 && value.length >= 32 ? 'high' : 'medium';
  if (rule === 'long-random') return h >= 4.5 ? 'high' : h >= 3.5 ? 'medium' : 'low';
  return value.length >= 8 && h >= 3 ? 'high' : 'medium';
}

/** How many characters a preview keeps at each end: none below 16, so a short password shows nothing. */
export const keepFor = (length: number): number => (length >= 24 ? 4 : length >= 16 ? 2 : 0);

export function maskSecret(secret: string): string {
  const keep = keepFor(secret.length);
  return keep === 0 ? MASK : `${secret.slice(0, keep)}${MASK}${secret.slice(-keep)}`;
}

/**
 * That a preview holds none of the secret's middle: what's left once the kept
 * ends are taken off shares no character with the middle, and the ends are
 * no longer than {@link keepFor} allows.
 */
export function previewIsMasked(preview: string, secret: string): boolean {
  const keep = keepFor(secret.length);
  const head = secret.slice(0, keep);
  const tail = keep === 0 ? '' : secret.slice(-keep);
  if (!preview.startsWith(head) || !preview.endsWith(tail) || preview.length < head.length + tail.length) return false;
  const rest = preview.slice(head.length, preview.length - tail.length);
  const middle = new Set(secret.slice(keep, secret.length - keep));
  return ![...rest].some((ch) => middle.has(ch));
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * A salted scrypt (N 2^14), so the allow file and the output can name a
 * value without anyone reading it back: a SHA-256 of `hunter2` is a lookup,
 * this is about 20 ms a guess. `memo`, one per scan, keeps a value found
 * twice from being hashed twice; it dies with the scan, so a long-running MCP
 * server holds nothing of an earlier call's secrets.
 */
export function fingerprintOf(secret: string, memo = new Map<string, string>()): string {
  const key = digest(secret);
  let found = memo.get(key);
  if (!found) {
    const hex = scryptSync(secret, 'toil util secrets scan, fingerprint v1', 16, { N: 16384, r: 8, p: 1 }).toString('hex');
    found = hex.match(/.{8}/g)!.join('-');
    memo.set(key, found);
  }
  return found;
}

interface LineMatch extends SecretMatch {
  confidence: Confidence;
  entropy: number;
}

/**
 * Every secret in one line, by position. Two kinds of match are set aside and
 * counted rather than reported: a long random run inside an SRI checksum, and
 * a value that a name marks as secret but which is a reference to one
 * (`token: ${{ secrets.X }}`, `password=$DB_PASSWORD`).
 */
export function detectLine(text: string): { matches: LineMatch[]; checksums: number; placeholders: number } {
  const sri: Array<[number, number]> = [];
  for (const m of text.matchAll(SRI)) sri.push([m.index, m.index + m[0].length]);
  const inSri = (m: SecretMatch) => sri.some(([s, e]) => m.index >= s && m.index + m.length <= e);
  let checksums = 0;
  let placeholders = 0;
  const kept: SecretMatch[] = [];
  for (const m of findSecrets(text)) {
    if (m.rule === 'long-random' && inSri(m)) checksums++;
    else if (CONTEXT_RULES.has(m.rule) && PLACEHOLDER.test(text.slice(m.index, m.index + m.length))) placeholders++;
    else kept.push(m);
  }
  const taken = (s: number, e: number) => kept.some((m) => s < m.index + m.length && m.index < e) || sri.some(([a, b]) => s < b && a < e);
  for (const m of text.matchAll(ENTROPY_RUN)) {
    const run = m[0];
    if (taken(m.index, m.index + run.length)) continue;
    if (!/[A-Za-z]/.test(run) || !/\d/.test(run) || /^[0-9a-f-]+$/i.test(run)) continue;
    const h = entropy(run);
    if (h >= 4.2) kept.push({ rule: 'high-entropy', index: m.index, length: run.length });
  }
  kept.sort((a, b) => a.index - b.index);
  return {
    matches: kept.map((m) => {
      const value = text.slice(m.index, m.index + m.length);
      const h = entropy(value);
      return { ...m, confidence: confidenceOf(m.rule, value, h), entropy: h };
    }),
    checksums,
    placeholders,
  };
}

/** A finding as it's held while the scan runs: the output's fields, plus what the re-read compares. */
interface Held extends Finding {
  /** SHA-256 of the secret's characters on its first line: what the re-read must find there. Never output. */
  check: string;
  firstLength: number;
}

interface OpenKey {
  finding: Held;
  /** The BEGIN line's match: the finding's secret if no END ever comes. */
  header: string;
  /** The header and every body line so far, for the fingerprint of a whole key. */
  text: string;
  lastLine: number;
  /** The body lines taken so far, scanned after all if no END comes. */
  held: Array<{ number: number; text: string }>;
}

/**
 * The scan over one file's lines, in order. A BEGIN line standing alone opens
 * a key, and the body lines below it are held. An END line closes it as one
 * finding, so the body isn't reported again line by line as random runs.
 * Anything else (a line that isn't body, a gap between hunks, the end of the
 * file) means it wasn't a key after all: the header is reported alone, and
 * each held line is scanned as if it had never been held, so a header in a
 * document can't hide the secrets after it.
 */
class FileScan {
  readonly found: Held[] = [];
  checksums = 0;
  placeholders = 0;
  lines = 0;
  private open: OpenKey | undefined;

  constructor(
    private readonly file: string | null,
    private readonly finish: (finding: Held, secret: string) => void,
  ) {}

  line(number: number, text: string): void {
    this.lines++;
    let from = 0;
    const open = this.open;
    if (open) {
      const next = number === open.lastLine + 1;
      const end = next ? KEY_END.exec(text) : null;
      if (end) {
        from = end.index + end[0].length;
        this.append(text.slice(0, from), number);
        this.closeKey();
      } else if (next && KEY_BODY.test(text.trim())) {
        this.append(text, number);
        open.held.push({ number, text });
        return;
      } else this.close();
    }
    this.scan(number, text, from);
  }

  /** The matches on one line from `from` on, each reported, or held open when it's a bare BEGIN line. */
  private scan(number: number, text: string, from: number): void {
    const { matches, checksums, placeholders } = detectLine(text);
    this.checksums += checksums;
    this.placeholders += placeholders;
    for (const m of matches) {
      if (m.index < from) continue;
      const secret = text.slice(m.index, m.index + m.length);
      const held: Held = {
        file: this.file,
        line: number,
        column: m.index + 1,
        length: m.length,
        rule: m.rule,
        confidence: m.confidence,
        entropy: Math.round(m.entropy * 100) / 100,
        preview: '',
        fingerprint: '',
        check: digest(secret),
        firstLength: m.length,
      };
      if (m.rule === 'private-key' && KEY_HEADER.test(secret.trim())) {
        this.open = { finding: held, header: secret, text: secret, lastLine: number, held: [] };
      } else {
        this.finish(held, secret);
        this.found.push(held);
      }
    }
  }

  private append(text: string, number: number) {
    const open = this.open!;
    if (open.text.length < MAX_KEY_TEXT) open.text += `\n${text}`.slice(0, MAX_KEY_TEXT - open.text.length);
    open.lastLine = number;
  }

  /** An END line arrived: the header, body and END are one finding. */
  private closeKey(): void {
    const open = this.open!;
    this.open = undefined;
    const { finding, text } = open;
    if (open.lastLine !== finding.line) finding.endLine = open.lastLine;
    finding.length = text.length;
    finding.entropy = Math.round(entropy(text) * 100) / 100;
    this.finish(finding, text);
    this.found.push(finding);
  }

  /** No END came: the header is reported on its own line, and every held line is scanned. */
  close(): void {
    const open = this.open;
    if (!open) return;
    this.open = undefined;
    this.finish(open.finding, open.header);
    this.found.push(open.finding);
    for (const { number, text } of open.held) this.scan(number, text, 0);
  }
}

/** Reads the lines a check names again, from wherever the scanned text came from. */
type Reread = (lines: number[]) => Promise<Map<number, string>>;

interface Scanned {
  file: string | null;
  found: Held[];
  reread: Reread;
}

/** Collects every file's findings, then re-reads and splits them by the allow list. */
class Scan {
  readonly v: Verifier;
  readonly unreadable: Unreadable[] = [];
  readonly scanned: Scanned[] = [];
  private readonly fingerprints = new Map<string, string>();
  files = 0;
  lines = 0;
  checksums = 0;
  placeholders = 0;

  constructor(
    readonly ctx: Ctx,
    private readonly mask: (secret: string) => string,
  ) {
    this.v = new Verifier(ctx.warn);
  }

  fileScan(file: string | null): FileScan {
    return new FileScan(file, (finding, secret) => {
      const at = where(finding);
      const preview = this.mask(secret);
      // A preview that fails is replaced, never shown: the check fails closed.
      finding.preview = this.v.expect('preview.masked', previewIsMasked(preview, secret), { at }, { code: 'SECRETS_PREVIEW_LEAK' }) ? preview : MASK;
      finding.fingerprint = fingerprintOf(secret, this.fingerprints);
    });
  }

  done(scan: FileScan, file: string | null, reread: Reread): void {
    scan.close();
    this.files++;
    this.lines += scan.lines;
    this.checksums += scan.checksums;
    this.placeholders += scan.placeholders;
    this.scanned.push({ file, found: scan.found, reread });
  }

  cantRead(entry: Unreadable): void {
    this.unreadable.push(entry);
  }

  /** Each finding, re-read: the same characters at the same place, and the same rule finding them there. */
  async verify(): Promise<Held[]> {
    const all: Held[] = [];
    for (const { found, reread } of this.scanned) {
      if (found.length === 0) continue;
      let lines: Map<number, string>;
      try {
        lines = await reread([...new Set(found.map((f) => f.line))]);
      } catch {
        lines = new Map();
      }
      for (const f of found) {
        const text = lines.get(f.line);
        const at = f.column - 1;
        const same = text !== undefined && digest(text.slice(at, at + f.firstLength)) === f.check;
        const rule = same && detectLine(text).matches.some((m) => m.index === at && m.rule === f.rule);
        this.v.expect(
          'finding.reread',
          rule,
          { at: where(f), expected: `${f.rule} at column ${f.column}`, actual: text === undefined ? 'no such line' : same ? 'the same characters, but no rule finds them there' : 'different characters' },
          { code: 'SECRETS_REREAD_MISMATCH' },
        );
        all.push(f);
      }
    }
    return all;
  }
}

const where = (f: { file: string | null; line: number; column: number }) => `${f.file ?? 'input'}:${f.line}:${f.column}`;

const isBinaryRefusal = (err: unknown) => err instanceof ToilError && /looks binary/.test(err.message);

/** One file, a pass over its lines, recorded; what can't be read is listed with why. */
async function scanFile(scan: Scan, path: string): Promise<void> {
  const { ctx } = scan;
  try {
    const stat = ctx.files.stat(path);
    if (stat.size > DEFAULT_MAX_BYTES) {
      scan.cantRead({ file: path, reason: 'too-large', message: `${path} is ${stat.size} bytes, more than the ${DEFAULT_MAX_BYTES} this command reads from one file.` });
      return;
    }
    const input = await openInput(ctx, { file: path }, { maxLineLength: MAX_LINE });
    const fileScan = scan.fileScan(path);
    for await (const line of input.lines()) scanLine(scan, fileScan, path, line);
    scan.v.inputComplete(input);
    scan.done(fileScan, path, (lines) => input.linesAt(lines));
  } catch (err) {
    if (err instanceof ToilError && (err.code === 'TIMEOUT' || err.code === 'CANCELLED')) throw err;
    if (ctx.signal.aborted) throw err;
    scan.cantRead({ file: path, reason: isBinaryRefusal(err) ? 'binary' : 'unreadable', message: (err as Error).message });
  }
}

function scanLine(scan: Scan, fileScan: FileScan, file: string | null, line: InputLine) {
  if (line.cut) scan.cantRead({ file, line: line.number, reason: 'line-too-long', message: `Line ${line.number} is longer than ${MAX_LINE} characters; only its start was scanned.` });
  fileScan.line(line.number, line.text);
}

/** stdin or text: one input, through the kit, re-read from what it holds. */
async function scanOne(scan: Scan, fields: { file?: string | undefined; text?: string | undefined }): Promise<void> {
  const input = await openInput(scan.ctx, fields, { maxLineLength: MAX_LINE });
  const fileScan = scan.fileScan(null);
  for await (const line of input.lines()) scanLine(scan, fileScan, null, line);
  scan.v.inputComplete(input);
  scan.done(fileScan, null, (lines) => input.linesAt(lines));
}

/** A folder, as `ctx.files.list` walks it: `.gitignore` respected, a nested repository listed and not entered. */
async function scanFolder(scan: Scan, dir: string): Promise<void> {
  const base = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = base === '' || base === '.' ? '' : `${base}/`;
  // A folder .gitignore excludes lists only what git tracks in it, often
  // nothing; a clean result over no files would read as a clean folder.
  let ignored: { code: string; message: string } | undefined;
  const entries = scan.ctx.files.list(dir, {
    warn: (w) => {
      if (w.code === LIST_FOLDER_IGNORED) ignored = w;
      else scan.ctx.warn(w);
    },
  });
  if (ignored && entries.length === 0) {
    scan.ctx.warn({ code: 'SECRETS_NOTHING_SCANNED', message: `0 files were scanned, because .gitignore excludes this folder: ${ignored.message}` });
  } else if (ignored) {
    scan.ctx.warn(ignored);
  }
  for (const entry of entries) {
    const path = `${prefix}${entry}`;
    if (entry.endsWith('/')) {
      scan.cantRead({ file: path, reason: 'nested-repository', message: `${path} is a repository of its own and wasn't walked into; scan it on its own.` });
      continue;
    }
    await scanFile(scan, path);
  }
}

export interface DiffFile {
  path: string;
  binary: boolean;
  added: Array<{ line: number; text: string }>;
}

/** A path as git prints it in a diff: C-quoted when it holds a special or non-ASCII character. */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, raw.endsWith('"') ? -1 : undefined);
  const named: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(named[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const stripPrefix = (path: string, prefix: string) => (path.startsWith(prefix) ? path.slice(prefix.length) : path);

/**
 * The added lines of a unified diff with no context (`--unified=0`), by file
 * and by their line numbers in the new version, read from each hunk header.
 * A deleted file adds nothing; a binary one is marked so it can be listed.
 */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let next = 0;
  let inHunk = false;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      current = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4);
      current = target === '/dev/null' ? undefined : { path: stripPrefix(unquoteGitPath(target), 'b/'), binary: false, added: [] };
      if (current) files.push(current);
      continue;
    }
    const binary = /^Binary files .* and ("?b\/.*"?) differ$/.exec(line);
    if (binary) {
      const path = stripPrefix(unquoteGitPath(binary[1]!), 'b/');
      files.push({ path, binary: true, added: [] });
      current = undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith('+')) current.added.push({ line: next++, text: line.slice(1) });
    else if (line.startsWith(' ')) next++;
  }
  return files;
}

const splitLines = (text: string) => new Map(text.split('\n').map((l, i) => [i + 1, l.endsWith('\r') ? l.slice(0, -1) : l] as const));

/**
 * The repository's staged changes (`git diff --staged`) or its working tree's
 * changes against the index (`git diff`), added lines only, with paths
 * relative to the workspace. Findings are re-read from the index (`git show
 * :./path`) or the file on disk, never from the diff they were found in.
 */
async function scanDiff(scan: Scan, kind: DiffKind): Promise<void> {
  const { ctx } = scan;
  await requireRepo(ctx);
  const options = [...(kind === 'staged' ? ['--staged'] : []), '--no-color', '--unified=0', '--relative', '--src-prefix=a/', '--dst-prefix=b/'];
  const label = `git diff${kind === 'staged' ? ' --staged' : ''}`;
  const text = execOutput(label, await runGit(ctx, { subcommand: 'diff', options }), DEFAULT_MAX_BYTES);
  for (const file of parseDiff(text)) {
    if (file.binary) {
      scan.cantRead({ file: file.path, reason: 'binary', message: `${file.path} is binary in the diff; its content wasn't scanned.` });
      continue;
    }
    const fileScan = scan.fileScan(file.path);
    for (const { line, text: added } of file.added) fileScan.line(line, added);
    const reread: Reread =
      kind === 'staged'
        ? async () => {
            const shown = await runGit(ctx, { subcommand: 'show', revisions: [`:./${file.path}`] });
            return shown.exitCode === 0 ? splitLines(shown.stdout) : new Map();
          }
        : async (lines) => (await openInput(ctx, { file: file.path }, { maxLineLength: MAX_LINE })).linesAt(lines);
    scan.done(fileScan, file.path, reread);
  }
  await warnPartialDiff(scan, kind);
  scan.v.unchecked('input.complete', "git's diff has no size to compare the bytes read with; each finding is re-read from its source instead");
  if (kind === 'working') {
    const untracked = await runGit(ctx, { subcommand: 'ls-files', options: ['--others', '--exclude-standard'] });
    const count = untracked.exitCode === 0 ? untracked.stdout.split('\n').filter(Boolean).length : 0;
    if (count > 0) {
      const one = count === 1;
      ctx.warn({
        code: 'SECRETS_UNTRACKED_NOT_SCANNED',
        message: `${count} untracked file${one ? " isn't" : "s aren't"} in the working-tree diff and ${one ? "wasn't" : "weren't"} scanned. Scan the folder to include ${one ? 'it' : 'them'}, or stage ${one ? 'it' : 'them'} and use --diff staged.`,
      });
    }
  }
}

/**
 * `--relative` keeps the diff to the workspace, which is what every path in
 * the output is relative to. When the workspace is a folder inside the
 * repository, the changes outside it aren't scanned; this says how many files
 * that left out, so a clean result is never mistaken for a clean commit.
 */
async function warnPartialDiff(scan: Scan, kind: DiffKind): Promise<void> {
  const { ctx } = scan;
  // git says where the workspace sits in the repository, as it resolves both: a workspace reached
  // through a symlink or a junction gets the same answer as the real folder, which a path comparison wouldn't.
  const shown = await runGit(ctx, { subcommand: 'rev-parse', options: ['--show-prefix'] });
  if (shown.exitCode !== 0) {
    scan.v.unchecked('diff.whole', "git couldn't say where the workspace sits in the repository");
    return;
  }
  const prefix = shown.stdout.trim();
  if (prefix === '') return;
  const inside = prefix.replace(/\/$/, '');
  const listed = await runGit(ctx, { subcommand: 'diff', options: [...(kind === 'staged' ? ['--staged'] : []), '--name-only', '--no-relative'] });
  if (listed.exitCode !== 0) {
    scan.v.unchecked('diff.whole', "git couldn't list the changes outside the workspace");
    return;
  }
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const outside = listed.stdout.split('\n').filter((p) => p !== '' && !fold(unquoteGitPath(p)).startsWith(fold(prefix))).length;
  if (outside > 0) {
    const what = kind === 'staged' ? 'staged' : 'changed';
    ctx.warn({
      code: 'SECRETS_DIFF_PARTIAL',
      message: `${outside} ${what} file${outside === 1 ? ' is' : 's are'} outside the workspace (${inside}) and ${outside === 1 ? "wasn't" : "weren't"} scanned. Run it with --workspace at the repository's top to scan the whole ${kind === 'staged' ? 'commit' : 'working tree'}.`,
    });
  }
}

interface AllowList {
  file: string;
  fingerprints: Set<string>;
  entries: number;
  invalid: number;
}

/**
 * The allow file: one fingerprint per line, `#` starting a comment. A line
 * that isn't a fingerprint is ignored with a warning giving its number only,
 * because a raw secret pasted there by mistake must not come back out.
 */
async function readAllowList(ctx: Ctx, named: string | undefined): Promise<AllowList | null> {
  const file = named ?? DEFAULT_ALLOW_FILE;
  // With no workspace (MCP, no root) there's nowhere for the default to be, and text still scans. A
  // default the file bounds refuse (a workspace at home, where .toil/ is toil's own) counts as absent.
  if (named === undefined) {
    let present: boolean;
    try {
      present = ctx.files.workspace !== undefined && ctx.files.exists(file);
    } catch {
      present = false;
    }
    if (!present) return null;
  }
  const input = await openInput(ctx, { file });
  const fingerprints = new Set<string>();
  let entries = 0;
  const invalid: number[] = [];
  for await (const line of input.lines()) {
    const value = line.text.replace(/#.*$/, '').trim();
    if (value === '') continue;
    if (FINGERPRINT.test(value.toLowerCase())) {
      fingerprints.add(value.toLowerCase());
      entries++;
    } else invalid.push(line.number);
  }
  if (invalid.length > 0) {
    ctx.warn({
      code: 'SECRETS_ALLOW_INVALID',
      message: `${invalid.length} line${invalid.length === 1 ? '' : 's'} of ${file} (line ${invalid.slice(0, 10).join(', ')}${invalid.length > 10 ? ', …' : ''}) ${invalid.length === 1 ? "isn't a fingerprint and was" : "aren't fingerprints and were"} ignored. A fingerprint is four groups of 8 hex digits, as a finding reports it; the line itself isn't shown, in case it holds a secret.`,
    });
  }
  return { file, fingerprints, entries, invalid: invalid.length };
}

/** A finding as the output holds it: the re-read's digest and first-line length left behind. */
const output = (h: Held): Finding => ({
  file: h.file,
  line: h.line,
  column: h.column,
  ...(h.endLine === undefined ? {} : { endLine: h.endLine }),
  length: h.length,
  rule: h.rule,
  confidence: h.confidence,
  entropy: h.entropy,
  preview: h.preview,
  fingerprint: h.fingerprint,
});

export async function scanSecrets(input: ScanOptions, ctx: Ctx): Promise<ScanData> {
  const given = [input.file !== undefined, input.text !== undefined, input.diff !== undefined].filter(Boolean).length;
  if (given > 1) {
    throw new ToilError('INVALID_INPUT', 'Pass one of file, text or diff.', { fix: 'file names a file or folder in the workspace, text is the content itself, and diff scans the repository\'s staged or working-tree changes.' });
  }
  const allow = await readAllowList(ctx, input.allowFile);
  const scan = new Scan(ctx, input.mask ?? maskSecret);
  let source: ScanData['source'];
  if (input.diff) {
    source = { kind: input.diff, path: null };
    await scanDiff(scan, input.diff);
  } else if (input.text !== undefined) {
    source = { kind: 'text', path: null };
    await scanOne(scan, { text: input.text });
  } else if (input.file === undefined || input.file === '-') {
    source = { kind: 'stdin', path: null };
    await scanOne(scan, input.file === undefined ? {} : { file: '-' });
  } else if (ctx.files.stat(input.file).type === 'directory') {
    source = { kind: 'folder', path: input.file };
    await scanFolder(scan, input.file);
  } else {
    source = { kind: 'file', path: input.file };
    const before = scan.unreadable.length;
    await scanFile(scan, input.file);
    // One file named on the call that can't be read is the call's failure, not a list entry.
    const failed = scan.unreadable.slice(before).find((u) => u.reason !== 'line-too-long');
    if (failed) throw new ToilError('INVALID_INPUT', failed.message, { fix: failed.reason === 'binary' ? 'Pass a text file.' : 'Check the path, and that the file can be read.' });
  }

  const all = await scan.verify();
  const findings: Finding[] = [];
  const allowed: Finding[] = [];
  const used = new Set<string>();
  for (const f of all) {
    if (allow?.fingerprints.has(f.fingerprint)) {
      used.add(f.fingerprint);
      allowed.push(output(f));
    } else findings.push(output(f));
  }
  if (scan.unreadable.length > 0) {
    const n = scan.unreadable.length;
    ctx.warn({ code: 'SECRETS_UNREADABLE', message: `${n} file${n === 1 ? '' : 's'} or line${n === 1 ? '' : 's'} couldn't be scanned in full; data.unreadable lists each with the reason.` });
  }
  const byRule: Record<string, number> = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  if (findings.length > 0) ctx.setExitCode(1);
  return {
    source,
    findings,
    allowed,
    unreadable: scan.unreadable,
    allowList: allow ? { file: allow.file, entries: allow.entries, invalid: allow.invalid, unused: [...allow.fingerprints].filter((fp) => !used.has(fp)).length } : null,
    summary: { files: scan.files, lines: scan.lines, findings: findings.length, allowed: allowed.length, unreadable: scan.unreadable.length, checksums: scan.checksums, placeholders: scan.placeholders, byRule },
    verified: scan.v.done(),
  };
}

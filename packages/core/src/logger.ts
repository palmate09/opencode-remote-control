/**
 * Structured logging (§6).
 *
 * Two streams with two jobs:
 *   - debug  (`logs/app.log`)  operator-facing, human-readable, rotates fast
 *   - audit  (`logs/audit.jsonl`) evidence, append-only, hash-chained
 *
 * Everything written to either stream passes through the redactor first
 * (§6.5), so a bug in an adapter cannot leak a token into a file you paste into
 * a bug report.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { elide, maskCredentials, registerSecret, scrubPath } from "./sanitize.js";
import type { Actor, LogLevel, Outcome } from "./types.js";

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

/** §6.2 — audit record. `actor` is always hashed, never plaintext. */
export interface AuditRecord {
  ts: string;
  seq: number;
  event: string;
  actor?: { platform: string; id: string };
  session?: string;
  correlation?: string;
  outcome?: Outcome;
  ns: string;
  fields?: Record<string, unknown>;
  hash?: string;
  prev?: string;
}

export interface LoggerOptions {
  readonly logDir: string;
  readonly level?: LogLevel;
  /** Namespace allowlist for `debug`/`trace`. Empty means "everything". */
  readonly debugFilter?: readonly string[];
  readonly stateDir?: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly actorMode?: "hash" | "raw";
  /** §8.3 — pseudonymisation salt for audit actor ids. */
  readonly salt?: string;
  readonly now?: () => number;
}

const MAX_FIELD = 3500;

function redactValue(value: unknown, stateDir: string | undefined, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value, stateDir);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message, stateDir) };
  }
  if (depth >= 4) return "(depth)";
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => redactValue(v, stateDir, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = redactValue(v, stateDir, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * §6.5 — the redaction step. Credential masking plus state-path scrubbing plus
 * a length cap. Cheap enough to run on every field of every record.
 */
export function redactString(input: string, stateDir?: string): string {
  const scrubbed = stateDir ? scrubPath(maskCredentials(input), stateDir) : maskCredentials(input);
  return elide(scrubbed, MAX_FIELD);
}

export interface AuditOptions {
  readonly path: string;
  readonly salt: string;
  readonly actorMode?: "hash" | "raw";
  readonly stateDir?: string;
}

/**
 * The chain's genesis constant: the `prev` of the first record (§6.3).
 *
 * Declared before the class so `prevHash` can be initialised from it inline,
 * rather than needing a definite-assignment assertion.
 */
export const GENESIS = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

export class AuditLog {
  private seq = 0;
  private readonly path: string;
  private readonly salt: string;
  private readonly actorMode: "hash" | "raw";
  private readonly stateDir?: string;
  /** The chain head. Starts at the genesis constant; see §6.3. */
  private prevHash: string = GENESIS;
  /** Report a failing audit write once, not on every record. */
  private reportedWriteFailure = false;

  constructor(opts: AuditOptions) {
    this.path = opts.path;
    this.salt = opts.salt;
    this.actorMode = opts.actorMode ?? "hash";
    this.stateDir = opts.stateDir;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    } catch {
      // The state directory may have been removed underneath us (tests, or an
      // operator cleaning up). Keep the object usable; writes report their own
      // failure below.
    }
    const tail = this.readTail();
    if (tail) {
      this.seq = tail.seq + 1;
      this.prevHash = tail.hash ?? GENESIS;
    }
  }

  private readTail(): AuditRecord | null {
    if (!existsSync(this.path)) return null;
    try {
      const text = readFileSync(this.path, "utf8");
      const lastLine = text.trimEnd().split("\n").pop();
      if (!lastLine) return null;
      return JSON.parse(lastLine) as AuditRecord;
    } catch {
      return null;
    }
  }

  /** §8.3 — sha256(salt + platform + ":" + id). */
  hashActor(actor: Pick<Actor, "platform" | "id">): string {
    if (this.actorMode === "raw") return `${actor.platform}:${actor.id}`;
    return `sha256:${createHash("sha256").update(`${this.salt}${actor.platform}:${actor.id}`).digest("hex")}`;
  }

  append(rec: Omit<AuditRecord, "ts" | "seq" | "hash" | "prev">): AuditRecord {
    const full: AuditRecord = {
      ts: new Date().toISOString(),
      seq: this.seq++,
      event: rec.event,
      ...(rec.actor
        ? { actor: { platform: rec.actor.platform, id: this.hashActor(rec.actor) } }
        : {}),
      ...(rec.session ? { session: rec.session } : {}),
      ...(rec.correlation ? { correlation: rec.correlation } : {}),
      ...(rec.outcome ? { outcome: rec.outcome } : {}),
      ns: rec.ns,
      ...(rec.fields
        ? { fields: redactValue(rec.fields, this.stateDir) as Record<string, unknown> }
        : {}),
    };
    full.prev = this.prevHash;
    full.hash = hashRecord(full);
    this.prevHash = full.hash;

    try {
      appendFileSync(this.path, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    } catch {
      // Losing an audit write must not take down the bridge — a permissions
      // error or a full disk is an operator problem, not a reason to crash the
      // process that is supervising an agent. Report once, then keep serving.
      if (!this.reportedWriteFailure) {
        this.reportedWriteFailure = true;
        process.stderr.write(`audit append failed: ${this.path}\n`);
      }
    }
    return full;
  }

  /** Reads records back, optionally filtered. Used by `export` and `verify`. */
  read(filter?: { since?: number; until?: number; actor?: string }): AuditRecord[] {
    if (!existsSync(this.path)) return [];
    const out: AuditRecord[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec: AuditRecord;
      try {
        rec = JSON.parse(line) as AuditRecord;
      } catch {
        continue;
      }
      if (filter?.since !== undefined && Date.parse(rec.ts) < filter.since) continue;
      if (filter?.until !== undefined && Date.parse(rec.ts) > filter.until) continue;
      if (filter?.actor !== undefined && rec.actor?.id !== filter.actor) continue;
      out.push(rec);
    }
    return out;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get head(): string {
    return this.prevHash;
  }
}

/**
 * §6.3 — `record_hash = sha256(seq ‖ ts ‖ event ‖ canonical(fields) ‖ prev)`.
 *
 * The parts are joined with U+0000 rather than a space or a newline. JSON
 * encodes a literal control character as the escape sequence `\u0000`, so the
 * separator can never appear in `canonicalFields` — which means no combination
 * of field values can be crafted to collide with another record's hash input.
 */
export function hashRecord(rec: AuditRecord): string {
  const payload = [
    String(rec.seq),
    rec.ts,
    rec.event,
    canonicalFields(rec.fields),
    rec.prev ?? GENESIS,
  ].join("\u0000");
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function canonicalFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "{}";
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(fields).sort()) sorted[k] = fields[k];
  return JSON.stringify(sorted);
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly records: number;
  readonly brokenAt: number | null;
  readonly reason: string | null;
}

/** §6.3 — walk the chain and report the first record that does not verify. */
export function verifyChain(path: string): VerifyResult {
  if (!existsSync(path)) return { ok: true, records: 0, brokenAt: null, reason: null };
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let rec: AuditRecord;
    try {
      rec = JSON.parse(lines[i] as string) as AuditRecord;
    } catch (err) {
      return {
        ok: false,
        records: i,
        brokenAt: i,
        reason: `unparseable JSON: ${(err as Error).message}`,
      };
    }
    if (rec.prev !== prev) {
      return {
        ok: false,
        records: i,
        brokenAt: rec.seq,
        reason: `prev-hash mismatch at seq ${rec.seq}`,
      };
    }
    if (rec.seq !== i) {
      return {
        ok: false,
        records: i,
        brokenAt: rec.seq,
        reason: `seq gap at ${i}, saw ${rec.seq}`,
      };
    }
    if (hashRecord(rec) !== rec.hash) {
      return {
        ok: false,
        records: i,
        brokenAt: rec.seq,
        reason: `content hash mismatch at seq ${rec.seq}`,
      };
    }
    prev = rec.hash ?? GENESIS;
  }
  return { ok: true, records: lines.length, brokenAt: null, reason: null };
}

export interface Logger {
  /** The namespace this logger writes under. */
  readonly ns: string;
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  trace(message: string, fields?: Record<string, unknown>): void;
  child(ns: string): Logger;
  audit(rec: Omit<AuditRecord, "ts" | "seq" | "hash" | "prev">): AuditRecord;
  readonly auditLog: AuditLog;
  close(): void;
}

export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? "info";
  const filter = new Set(opts.debugFilter ?? []);
  const ceiling = LEVEL_ORDER[level];
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 10;
  const stateDir = opts.stateDir;
  const path = join(opts.logDir, "app.log");
  mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });

  const write = (
    levelName: Exclude<LogLevel, "silent">,
    ns: string,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVEL_ORDER[levelName] > ceiling) return;
    if ((levelName === "debug" || levelName === "trace") && filter.size > 0 && !filter.has(ns))
      return;
    const ts = new Date().toISOString();
    const redacted = redactString(msg, stateDir);
    const extra =
      fields && Object.keys(fields).length > 0
        ? ` ${JSON.stringify(redactValue(fields, stateDir))}`
        : "";
    const line = `${ts} ${levelName.toUpperCase().padEnd(5)} [${ns}] ${redacted}${extra}\n`;
    rotateIfNeeded(path, maxBytes, maxFiles);
    try {
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      process.stderr.write(line);
    }
    if (levelName === "error") process.stderr.write(line);
  };

  const auditLog = new AuditLog({
    path: join(opts.logDir, "audit.jsonl"),
    salt: opts.salt ?? "",
    actorMode: opts.actorMode,
    stateDir,
  });

  const make = (ns: string): Logger => ({
    ns,
    error: (m, f) => write("error", ns, m, f),
    warn: (m, f) => write("warn", ns, m, f),
    info: (m, f) => write("info", ns, m, f),
    debug: (m, f) => write("debug", ns, m, f),
    trace: (m, f) => write("trace", ns, m, f),
    child: (child: string) => make(`${ns}.${child}`),
    audit: (rec) => auditLog.append({ ...rec, ns: rec.ns || ns }),
    auditLog,
    close: () => {},
  });

  return make("rc");
}

/**
 * §6.6 — size-based rotation. Debug logs rotate aggressively; the audit log is
 * retention-managed instead, because truncating evidence is not acceptable.
 */
export function rotateIfNeeded(path: string, maxBytes: number, maxFiles: number): void {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size < maxBytes) return;
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      if (existsSync(from)) {
        if (i + 1 > maxFiles) unlinkSync(from);
        else renameSync(from, to);
      }
    }
    renameSync(path, `${path}.1`);
  } catch {
    // Rotation is best-effort. Never fail a write because a rename raced.
  }
}

/** Default state/log locations, honouring XDG. */
export function defaultStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return xdg ? join(xdg, "opencode-rc") : join(homedir(), ".local", "state", "opencode-rc");
}

export function defaultLogDir(stateDir: string): string {
  return join(stateDir, "logs");
}

export { registerSecret };

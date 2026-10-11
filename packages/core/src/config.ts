/**
 * Fail-closed configuration (§5.3).
 *
 * Two rules govern this file:
 *   1. A missing or malformed security-relevant setting is an error, never a
 *      default. Defaults are only used for things that are safe when wrong
 *      (rotation sizes, retention days).
 *   2. Nothing is read from a source the operator did not name. `.env` in the
 *      project root, then the real process environment.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { defaultLogDir, defaultStateDir } from "./logger.js";
import { registerSecret } from "./sanitize.js";
import { LOG_LEVELS } from "./types.js";
import type { AccessConfig, GroupPolicy, LogLevel, ResolvedRuntimeConfig } from "./types.js";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    /** The exact setting to fix, named so the operator does not guess. */
    readonly setting: string,
  ) {
    super(`${message}\n  → fix: ${setting}`);
  }
}

export type EnvSource = Record<string, string | undefined>;

/**
 * Reads `.env` without adding a dependency. Later assignments do not override
 * earlier ones, matching every dotenv implementation, and an already-set
 * process variable always wins over the file.
 */
export function parseDotEnv(text: string): EnvSource {
  const out: EnvSource = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadDotEnv(path: string, base: EnvSource = process.env): EnvSource {
  if (!existsSync(path)) return base;
  const parsed = parseDotEnv(readFileSync(path, "utf8"));
  const merged: EnvSource = { ...parsed, ...stripUndefined(base) };
  return merged;
}

function stripUndefined(src: EnvSource): EnvSource {
  const out: EnvSource = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v;
  return out;
}

function str(env: EnvSource, key: string, fallback?: string): string | undefined {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  return v;
}

function requiredStr(env: EnvSource, key: string): string {
  const v = str(env, key);
  if (!v) throw new ConfigError(`Missing required setting ${key}`, key);
  return v;
}

function bool(env: EnvSource, key: string, fallback: boolean): boolean {
  const v = str(env, key);
  if (v === undefined) return fallback;
  const norm = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(norm)) return true;
  if (["0", "false", "no", "off"].includes(norm)) return false;
  throw new ConfigError(`${key} must be a boolean, got ${JSON.stringify(v)}`, key);
}

function int(env: EnvSource, key: string, fallback: number, min = 0): number {
  const v = str(env, key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be an integer`, key);
  if (n < min) throw new ConfigError(`${key} must be >= ${min}`, key);
  return n;
}

export interface LoadOptions {
  /** Path to `.env`. Defaults to `<cwd>/.env`. */
  readonly envPath?: string;
  /** Explicit environment. Defaults to `process.env` merged with `.env`. */
  readonly env?: EnvSource;
  /** Override the state directory (tests). */
  readonly stateDir?: string;
  /** Skip the access.json load — used by `rc init`. */
  readonly skipAccess?: boolean;
}

export interface LoadedConfig {
  readonly config: ResolvedRuntimeConfig;
  /** Salt for audit pseudonymisation; generated once and persisted. */
  readonly salt: string;
  /** Path of the state directory. */
  readonly stateDir: string;
}

export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const envPath = opts.envPath ?? resolve(process.cwd(), ".env");
  const env = opts.env ?? (opts.envPath ? loadDotEnv(envPath) : loadDotEnv(envPath));
  const stateDir = resolve(opts.stateDir ?? str(env, "RC_STATE_DIR") ?? defaultStateDir());
  const logDir = resolve(str(env, "RC_LOG_DIR") ?? defaultLogDir(stateDir));

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });

  const salt = ensureSalt(stateDir, str(env, "RC_AUDIT_SALT"));

  // Teach the redactor about every credential we were handed, so a token that
  // somehow reaches a log line or a chat message is masked by exact match.
  for (const key of [
    "RC_TELEGRAM_BOT_TOKEN",
    "RC_DISCORD_BOT_TOKEN",
    "RC_SLACK_BOT_TOKEN",
    "RC_SLACK_APP_TOKEN",
    "RC_WEBHOOK_TOKEN",
    "RC_API_PASSWORD",
    "RC_OPENCODE_PASSWORD",
  ]) {
    registerSecret(str(env, key));
  }

  const opencodeUrl = normaliseUrl(requiredStr(env, "RC_OPENCODE_URL"));

  const levelRaw = (str(env, "RC_LOG_LEVEL") ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(levelRaw)) {
    throw new ConfigError(`RC_LOG_LEVEL must be one of ${LOG_LEVELS.join(" < ")}`, "RC_LOG_LEVEL");
  }

  const debugFilter = (str(env, "RC_DEBUG_FILTER") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const projectDirRaw = str(env, "RC_PROJECT_DIR");
  const projectDir = projectDirRaw ? resolve(projectDirRaw) : undefined;

  const access: AccessConfig = opts.skipAccess
    ? { disabled: true, allowFrom: [], groups: {}, requireMention: true }
    : loadAccess(stateDir);

  const config: ResolvedRuntimeConfig = {
    stateDir,
    logDir,
    opencodeUrl,
    ...(str(env, "RC_OPENCODE_USERNAME")
      ? { opencodeUsername: str(env, "RC_OPENCODE_USERNAME") }
      : {}),
    ...(str(env, "RC_OPENCODE_PASSWORD")
      ? { opencodePassword: str(env, "RC_OPENCODE_PASSWORD") }
      : {}),
    ...(projectDir ? { projectDir } : {}),
    access,
    logLevel: levelRaw,
    debugFilter,
    logRotateMaxBytes: int(env, "RC_LOG_ROTATE_MAX_BYTES", 10 * 1024 * 1024, 1024),
    logRotateMaxFiles: int(env, "RC_LOG_ROTATE_MAX_FILES", 10, 1),
    logRetentionDays: int(env, "RC_LOG_RETENTION_DAYS", 7, 0),
    auditRetentionDays: int(env, "RC_AUDIT_RETENTION_DAYS", 90, 0),
    actorMode: (str(env, "RC_LOG_ACTOR") ?? "hash") === "raw" ? "raw" : "hash",
    maxTurnsPerPrompt: int(env, "RC_MAX_TURNS_PER_PROMPT", 50, 1),
    maxNotificationsPerRun: int(env, "RC_MAX_NOTIFICATIONS_PER_RUN", 20, 1),
    maxConcurrentSessions: int(env, "RC_MAX_CONCURRENT_SESSIONS", 4, 1),
    requirePermissionAsk: bool(env, "RC_REQUIRE_PERMISSION_ASK", true),
  };

  return { config, salt, stateDir };
}

function normaliseUrl(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//.test(u)) u = `http://${u}`;
  const parsed = new URL(u);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("RC_OPENCODE_URL must be http or https", "RC_OPENCODE_URL");
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}

/** §8.3 — the salt is generated once, stored 0600, and reused forever. */
export function ensureSalt(stateDir: string, fromEnv?: string): string {
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const path = `${stateDir}/audit.salt`;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const salt = randomBytes(32).toString("hex");
  writeFileSync(path, `${salt}\n`, { mode: 0o600 });
  return salt;
}

export interface AccessFile {
  allowFrom: string[];
  groups: Record<string, GroupPolicy>;
  requireMention: boolean;
  disabled: boolean;
  updatedAt?: string;
}

const EMPTY_ACCESS: AccessFile = {
  allowFrom: [],
  groups: {},
  requireMention: true,
  disabled: false,
};

export function loadAccess(stateDir: string): AccessConfig {
  const path = accessPath(stateDir);
  if (!existsSync(path)) return { ...EMPTY_ACCESS };
  let parsed: Partial<AccessFile>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AccessFile>;
  } catch {
    // Fail closed on a corrupt file rather than silently opening the gate.
    return { disabled: true, allowFrom: [], groups: {}, requireMention: true };
  }
  return {
    disabled: parsed.disabled ?? false,
    allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [],
    groups: parsed.groups && typeof parsed.groups === "object" ? parsed.groups : {},
    requireMention: parsed.requireMention ?? true,
  };
}

export function accessPath(stateDir: string): string {
  return `${stateDir}/access.json`;
}

/** Atomic write: tmp + rename. Never a half-written access file. */
export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  // `rename` is atomic within a filesystem on POSIX.
  renameSync(tmp, path);
}

/** §8.4 — DPDP consent, captured once at first run. */
export interface ConsentRecord {
  version: string;
  grantedAt: string;
  basis: "consent" | "legitimate-interest";
  noticeHash: string;
}

export function consentPath(stateDir: string): string {
  return `${stateDir}/consent.json`;
}

export function readConsent(stateDir: string): ConsentRecord | null {
  const path = consentPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConsentRecord;
  } catch {
    return null;
  }
}

export function writeConsent(stateDir: string, rec: ConsentRecord): void {
  writeJsonAtomic(consentPath(stateDir), rec);
}

export function withdrawConsent(stateDir: string): void {
  const path = consentPath(stateDir);
  if (existsSync(path)) unlinkSync(path);
}

/** Validates the shape of a project directory path. */
export function assertProjectDir(dir: string): string {
  if (!isAbsolute(dir)) return resolve(dir);
  return dir;
}

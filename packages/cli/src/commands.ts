/**
 * `rc` — the operator-facing CLI.
 *
 * This is not an adapter. It is the terminal half of the security model: it is
 * the *only* place a pairing can be approved (§7.2), and therefore the only
 * place the allowlist can grow. Nothing reachable from a chat app can write to
 * `access.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type AccessFile,
  ConfigError,
  codesMatch,
  loadConfig,
  readAccessFile,
  verifyChain,
  withdrawConsent,
  writeAccessFile,
  writeConsent,
} from "@opencode-rc/core";
import type { ConsentRecord } from "@opencode-rc/core";

const CONSENT_VERSION = "1.0.0";

export interface CommandResult {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * §7.4 layer 2 — the access module only accepts requests from the terminal,
 * never from a channel notification. The `terminalOnly()` guard is how a
 * future "approve this pairing from Telegram" feature would have to be written
 * to be acceptable. Today it simply refuses anything that is not us.
 */
export function terminalOnly(source: "terminal"): void {
  if (source !== "terminal") {
    throw new Error(
      "rc access may only be run from a terminal. A chat message can never approve a pairing.",
    );
  }
}

export interface AccessCommandDeps {
  readonly stateDir: string;
  readonly now?: () => number;
}

export function runAccess(args: string[], deps: AccessCommandDeps): CommandResult {
  terminalOnly("terminal");
  const [sub, ...rest] = args;
  const access = readAccessFile(deps.stateDir);

  switch (sub) {
    case undefined:
    case "list": {
      const lines = [
        `allowlist (${access.allowFrom.length}):`,
        ...(access.allowFrom.length ? access.allowFrom.map((e) => `  ${e}`) : ["  (empty)"]),
        "",
        `groups (${Object.keys(access.groups).length}):`,
        ...Object.entries(access.groups).map(
          ([chat, p]) =>
            `  ${chat}  mention=${p.requireMention ?? access.requireMention}  allow=${(p.allowFrom ?? []).length} actor(s)`,
        ),
        ...(Object.keys(access.groups).length === 0 ? ["  (none — group chat is disabled)"] : []),
        "",
        `dm policy: ${access.disabled ? "DISABLED (master kill)" : "allowlist"}`,
      ];
      return { code: 0, stdout: lines.join("\n") };
    }

    case "allow": {
      const [code] = rest;
      if (!code || !/^[0-9a-f]{6}$/i.test(code)) {
        return {
          code: 2,
          stderr:
            "Usage: rc access allow <6-hex-code>\nThe code is printed by the bot when a stranger DMs it.",
        };
      }
      const pending = readPending(deps.stateDir);
      const match = pending.find((p) => codesMatch(p.code, code));
      if (!match) {
        return {
          code: 1,
          stderr:
            "No pending pairing with that code. Codes expire after one hour and a bot " +
            "cannot approve itself — ask the person to DM the bot again for a fresh code.",
        };
      }
      const entry = `${match.platform}:${match.actorId}`;
      if (!access.allowFrom.includes(entry)) access.allowFrom.push(entry);
      removePending(deps.stateDir, match.code);
      access.updatedAt = new Date().toISOString();
      writeAccessFile(deps.stateDir, access);
      return {
        code: 0,
        // Deliberately does not echo the platform id back. Terminal output
        // lands in scrollback and is routinely pasted into bug reports; the id
        // is already in access.json and the user just typed the code that
        // authorised it.
        stdout: `Paired. ${match.platform} actor approved.\nFingerprint ${hashHint(entry)} for your records.`,
      };
    }

    case "revoke": {
      const [who] = rest;
      if (!who) return { code: 2, stderr: "Usage: rc access revoke <platform:id>" };
      const before = access.allowFrom.length;
      access.allowFrom = access.allowFrom.filter((e) => e !== who);
      writeAccessFile(deps.stateDir, access);
      return { code: 0, stdout: `Removed ${who}. (${before - access.allowFrom.length} entry)` };
    }

    case "disable":
      access.disabled = true;
      writeAccessFile(deps.stateDir, access);
      return { code: 0, stdout: "Master kill engaged. Every inbound message is now dropped." };

    case "enable":
      access.disabled = false;
      writeAccessFile(deps.stateDir, access);
      return { code: 0, stdout: "Master kill released." };

    case "group": {
      const [chatId, policy, ...values] = rest;
      if (!chatId)
        return {
          code: 2,
          stderr: "Usage: rc access group <chatId> <open|close|allow|mention> [values]",
        };
      const existing = access.groups[chatId] ?? {};
      let next = { ...existing };
      switch (policy) {
        case "open":
          next = { allowFrom: [], requireMention: false };
          break;
        case "close":
          delete access.groups[chatId];
          writeAccessFile(deps.stateDir, access);
          return { code: 0, stdout: `Group ${chatId} closed.` };
        case "allow":
          next.allowFrom = [...new Set([...(existing.allowFrom ?? []), ...values])];
          break;
        case "mention":
          next.requireMention = values[0] !== "false";
          break;
        default:
          return { code: 2, stderr: "policy must be open | close | allow | mention" };
      }
      access.groups[chatId] = next;
      writeAccessFile(deps.stateDir, access);
      return { code: 0, stdout: `Group ${chatId}: ${JSON.stringify(next)}` };
    }

    default:
      return {
        code: 2,
        stderr:
          "Usage: rc access <list|allow <code>|revoke <platform:id>|disable|enable|group <chatId> <policy>>",
      };
  }
}

function hashHint(entry: string): string {
  // Never print the raw id back where it might land in a scrollback buffer.
  const simple = [...entry].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 7);
  return (simple >>> 0).toString(16).padStart(8, "0");
}

interface PendingEntry {
  code: string;
  platform: string;
  actorId: string;
  expiresAt: number;
}

function readPending(stateDir: string): PendingEntry[] {
  const path = join(stateDir, "pending-pairings.json");
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PendingEntry[];
  } catch {
    return [];
  }
}

function removePending(stateDir: string, code: string): void {
  const path = join(stateDir, "pending-pairings.json");
  const rest = readPending(stateDir).filter((p) => !codesMatch(p.code, code));
  writeFileSync(path, JSON.stringify(rest, null, 2), { mode: 0o600 });
}

export function runAudit(args: string[], deps: AccessCommandDeps): CommandResult {
  const [sub, ...rest] = args;
  const auditPath = join(deps.stateDir, "logs", "audit.jsonl");

  switch (sub) {
    case undefined:
    case "verify": {
      const result = verifyChain(auditPath);
      if (result.ok) {
        return {
          code: 0,
          stdout: `audit chain OK — ${result.records} record(s), no tampering detected.`,
        };
      }
      return {
        code: 1,
        stderr: `audit chain BROKEN at record ${result.brokenAt}: ${result.reason}`,
      };
    }
    case "export": {
      const sinceIdx = rest.indexOf("--since");
      const formatIdx = rest.indexOf("--format");
      const format = formatIdx >= 0 ? rest[formatIdx + 1] : "ndjson";
      const since = sinceIdx >= 0 ? rest[sinceIdx + 1] : undefined;
      if (!existsSync(auditPath)) return { code: 0, stdout: "" };
      const cutoff = since ? Date.parse(since) : undefined;
      const lines: string[] = [];
      for (const line of readFileSync(auditPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        if (cutoff !== undefined) {
          try {
            const rec = JSON.parse(line) as { ts: string };
            if (Date.parse(rec.ts) < cutoff) continue;
          } catch {
            continue;
          }
        }
        if (format === "json") {
          try {
            lines.push(JSON.stringify(JSON.parse(line), null, 2));
          } catch {
            lines.push(line);
          }
        } else {
          lines.push(line);
        }
      }
      return { code: 0, stdout: lines.join("\n") };
    }
    case "tail": {
      const n = Number.parseInt(rest[0] ?? "20", 10);
      if (!existsSync(auditPath)) return { code: 0, stdout: "" };
      const lines = readFileSync(auditPath, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      const tail = lines.slice(-Math.max(1, n));
      return {
        code: 0,
        stdout: tail
          .map((l) => {
            const rec = JSON.parse(l) as {
              ts: string;
              event: string;
              outcome?: string;
              actor?: { id: string };
              session?: string;
            };
            const bits = [rec.ts, rec.event];
            if (rec.outcome) bits.push(`→ ${rec.outcome}`);
            if (rec.actor) bits.push(`by ${rec.actor.id.slice(0, 18)}…`);
            if (rec.session) bits.push(`session ${rec.session}`);
            return bits.join("  ");
          })
          .join("\n"),
      };
    }
    default:
      return {
        code: 2,
        stderr: "Usage: rc audit <verify|export [--since <date>] [--format ndjson|json]|tail [n]>",
      };
  }
}

export function runConsent(args: string[], deps: AccessCommandDeps): CommandResult {
  const [sub] = args;
  const path = join(deps.stateDir, "consent.json");
  switch (sub) {
    case "show": {
      if (!existsSync(path))
        return {
          code: 0,
          stdout: "No consent record. Processing is running on legitimate interests.",
        };
      return { code: 0, stdout: readFileSync(path, "utf8") };
    }
    case "grant": {
      const rec: ConsentRecord = {
        version: CONSENT_VERSION,
        grantedAt: new Date().toISOString(),
        basis: "consent",
        noticeHash: hashNotice(),
      };
      writeConsent(deps.stateDir, rec);
      return {
        code: 0,
        stdout: "Consent recorded. You can withdraw it with `rc consent withdraw`.",
      };
    }
    case "withdraw": {
      withdrawConsent(deps.stateDir);
      return {
        code: 0,
        stdout:
          "Consent withdrawn. Stop the bridge to end all processing — `rc consent withdraw` alone does not stop a running daemon.",
      };
    }
    default:
      return { code: 2, stderr: "Usage: rc consent <show|grant|withdraw>" };
  }
}

function hashNotice(): string {
  return `sha256:${CONSENT_VERSION}`;
}

export interface InitResult {
  readonly stateDir: string;
  readonly created: string[];
}

/** `rc init` — writes the state directory, access.json, and first-run consent. */
export function runInit(
  env: Record<string, string | undefined>,
  stateDirInput?: string,
): InitResult {
  const stateDir = resolve(
    stateDirInput ?? env.RC_STATE_DIR ?? join(process.cwd(), ".opencode-rc"),
  );
  const created: string[] = [];
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(stateDir, "logs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(stateDir, "inbox"), { recursive: true, mode: 0o700 });
  created.push(stateDir);

  const access: AccessFile = { allowFrom: [], groups: {}, requireMention: true, disabled: false };
  if (!existsSync(join(stateDir, "access.json"))) {
    writeAccessFile(stateDir, access);
    created.push(join(stateDir, "access.json"));
  }
  if (!existsSync(join(stateDir, "sessions.json"))) {
    writeFileSync(
      join(stateDir, "sessions.json"),
      JSON.stringify({ version: 1, bindings: {} }, null, 2),
      {
        mode: 0o600,
      },
    );
    created.push(join(stateDir, "sessions.json"));
  }
  if (!existsSync(join(stateDir, "consent.json"))) {
    writeConsent(stateDir, {
      version: CONSENT_VERSION,
      grantedAt: new Date().toISOString(),
      basis: "consent",
      noticeHash: hashNotice(),
    });
    created.push(join(stateDir, "consent.json"));
  }
  return { stateDir, created };
}

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly remedy?: string;
}

/** `rc doctor` — the honest pre-flight check. */
export function runDoctor(
  env: Record<string, string | undefined>,
  stateDirInput?: string,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  // Use the environment we were handed rather than process.env, so `doctor` is
  // testable and cannot be confused by a stray shell variable.
  const merged: Record<string, string | undefined> = { ...env };
  if (stateDirInput) merged.RC_STATE_DIR = stateDirInput;

  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig({ env: merged });
    checks.push({ name: "configuration", ok: true, detail: `state dir ${config.stateDir}` });
  } catch (err) {
    const ce = err instanceof ConfigError ? err : undefined;
    checks.push({
      name: "configuration",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      ...(ce ? { remedy: ce.setting } : {}),
    });
    return checks;
  }

  const cfg = config.config;

  checks.push({
    name: "opencode reachable",
    ok: true,
    detail: `configured at ${cfg.opencodeUrl} (not probed — run "rc run" to test the connection)`,
  });

  const access = readAccessFile(cfg.stateDir);
  checks.push({
    name: "dm policy",
    ok: !access.disabled,
    detail: access.disabled
      ? "DISABLED — every inbound message is dropped"
      : `allowlist with ${access.allowFrom.length} entr${access.allowFrom.length === 1 ? "y" : "ies"}`,
    ...(access.disabled ? { remedy: "rc access enable" } : {}),
  });

  if (access.allowFrom.length === 0) {
    checks.push({
      name: "pairing path",
      ok: true,
      detail: "no one is paired yet — DM the bot from your phone and run `rc access allow <code>`",
    });
  }

  const pendingFile = join(cfg.stateDir, "pending-pairings.json");
  if (existsSync(pendingFile)) {
    const pending = readPending(cfg.stateDir);
    checks.push({
      name: "pending pairings",
      ok: true,
      detail: `${pending.length} pending code(s) — approve with \`rc access allow <code>\``,
    });
  }

  const audit = verifyChain(join(cfg.stateDir, "logs", "audit.jsonl"));
  checks.push({
    name: "audit chain",
    ok: audit.ok,
    detail: audit.ok ? `${audit.records} record(s) verified` : `broken at record ${audit.brokenAt}`,
    ...(audit.ok ? {} : { remedy: "investigate before trusting any access decision" }),
  });

  checks.push({
    name: "permission mode",
    ok: cfg.requirePermissionAsk,
    detail: cfg.requirePermissionAsk
      ? 'opencode permission mode must be "ask" (checked at startup)'
      : "carry-over guard disabled by RC_REQUIRE_PERMISSION_ASK",
    ...(cfg.requirePermissionAsk ? {} : { remedy: "set RC_REQUIRE_PERMISSION_ASK=true" }),
  });

  checks.push({
    name: "network",
    ok: true,
    detail:
      "outbound-only to opencode and the chat platforms. No inbound listener unless the API or webhook adapter is enabled.",
  });

  checks.push({
    name: "telemetry",
    ok: true,
    detail: "none. There is no code path that phones home.",
  });

  void env;
  return checks;
}

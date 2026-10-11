/**
 * Pairing, the allowlist, and the gate (§7.1, §7.2).
 *
 * This file is the entire security argument for opencode-rc. The property that
 * matters: **a bot cannot approve itself**. Pairing is completed at a terminal,
 * never from a chat message, so a compromised chat account is not a
 * compromise.
 *
 * Two further properties are load-bearing and easy to break:
 *
 *   - `disabled` is checked before the allowlist, so it is a true master kill.
 *   - "approve the pairing" without a code never auto-resolves, *even when
 *     exactly one code is pending*. An attacker can seed a single pending entry
 *     by DMing the bot; auto-picking it is an authentication bypass.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type AccessFile, accessPath, writeJsonAtomic } from "./config.js";
import type { AuditLog } from "./logger.js";
import type { Actor, InboundMessage } from "./types.js";
import { actorKey } from "./types.js";

/** §10.1 — 3 random bytes → 6 hex characters → 24 bits of CSPRNG entropy. */
export const PAIRING_CODE_BYTES = 3;
export const PAIRING_TTL_MS = 3_600_000;
export const PAIRING_REPLY_BUDGET = 2;
export const MAX_PENDING_CODES = 3;

export type GateOutcome =
  | { readonly action: "deliver" }
  | { readonly action: "drop"; readonly reason: string }
  | {
      readonly action: "pair";
      readonly code: string;
      readonly expiresAt: number;
      readonly budget: number;
    };

export interface PendingCode {
  readonly code: string;
  readonly platform: string;
  readonly actorId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Replies already sent for this code. After the budget, stay silent. */
  replies: number;
  /** Set once the operator has approved it at the terminal. */
  approved?: boolean;
}

export interface PairingStore {
  readonly stateDir: string;
  list(): PendingCode[];
  find(code: string): PendingCode | undefined;
  findForActor(actor: Actor): PendingCode | undefined;
  add(entry: PendingCode): PairingStore;
  remove(code: string): void;
  prune(now: number): number;
  save(): void;
  canReply(code: string): boolean;
  recordReply(code: string): void;
}

export function mintCode(): string {
  return randomBytes(PAIRING_CODE_BYTES).toString("hex");
}

export class PairingManager implements PairingStore {
  readonly stateDir: string;
  private pending = new Map<string, PendingCode>();

  constructor(
    stateDir: string,
    private readonly audit: AuditLog,
    private readonly now: () => number = Date.now,
  ) {
    this.stateDir = stateDir;
    this.load();
  }

  private get file(): string {
    return join(this.stateDir, "pending-pairings.json");
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as PendingCode[];
      const now = this.now();
      for (const p of parsed) if (p.expiresAt > now) this.pending.set(p.code, p);
    } catch {
      // A corrupt pending file is not an outage and not a security event: the
      // codes inside it are useless without the terminal step anyway.
    }
  }

  save(): void {
    writeJsonAtomic(this.file, [...this.pending.values()]);
  }

  list(): PendingCode[] {
    this.prune(this.now());
    return [...this.pending.values()];
  }

  find(code: string): PendingCode | undefined {
    const entry = this.pending.get(normaliseCode(code));
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(entry.code);
      this.save();
      return undefined;
    }
    return entry;
  }

  findForActor(actor: Actor): PendingCode | undefined {
    return this.list().find((p) => p.platform === actor.platform && p.actorId === actor.id);
  }

  add(entry: PendingCode): PairingStore {
    this.pending.set(entry.code, entry);
    this.save();
    return this;
  }

  remove(code: string): void {
    this.pending.delete(normaliseCode(code));
    this.save();
  }

  prune(now: number): number {
    let removed = 0;
    for (const [code, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(code);
        removed++;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  canReply(code: string): boolean {
    const entry = this.find(code);
    return !!entry && entry.replies < PAIRING_REPLY_BUDGET;
  }

  recordReply(code: string): void {
    const entry = this.find(code);
    if (!entry) return;
    entry.replies++;
    this.save();
  }

  /** Issues a fresh code for a stranger, subject to the global cap. */
  issue(actor: Actor): GateOutcome {
    this.prune(this.now());
    if (this.pending.size >= MAX_PENDING_CODES) {
      // Anti-spam: silent. Answering would confirm the bot exists and is a
      // usable oracle for enumerating pending state.
      this.audit.append({
        event: "pairing.dropped",
        actor,
        outcome: "drop",
        ns: "pairing",
        fields: { reason: "pending table full", pending: this.pending.size },
      });
      return { action: "drop", reason: "pending table full" };
    }
    const existing = this.findForActor(actor);
    if (existing) {
      this.audit.append({
        event: "pairing.code_reissued",
        actor,
        outcome: "drop",
        ns: "pairing",
        fields: { reason: "already pending" },
      });
      return {
        action: "pair",
        code: existing.code,
        expiresAt: existing.expiresAt,
        budget: Math.max(0, PAIRING_REPLY_BUDGET - existing.replies),
      };
    }
    const code = mintCode();
    const now = this.now();
    this.add({
      code,
      platform: actor.platform,
      actorId: actor.id,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      replies: 0,
    });
    this.audit.append({
      event: "pairing.code_issued",
      actor,
      outcome: "drop",
      ns: "pairing",
      fields: { expiresAt: new Date(now + PAIRING_TTL_MS).toISOString() },
    });
    return { action: "pair", code, expiresAt: now + PAIRING_TTL_MS, budget: PAIRING_REPLY_BUDGET };
  }
}

function normaliseCode(code: string): string {
  return String(code ?? "")
    .trim()
    .toLowerCase();
}

/** Constant-time comparison so a code cannot be recovered by timing the CLI. */
export function codesMatch(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(normaliseCode(a));
  const bb = new TextEncoder().encode(normaliseCode(b));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Actors that are locally trusted *by construction*.
 *
 * §7.4 layer 2: "the access module only accepts requests from the terminal,
 * never from a channel notification." The CLI adapter **is** the terminal — it
 * reads stdin, so pairing it with itself would be circular: the pairing code
 * arrives at the same terminal you would have to type it into.
 *
 * Making this explicit, rather than a special case at the call site, means:
 *   - the master kill still applies, so `rc access disable` stops the CLI too;
 *   - the exemption is one reviewable line rather than a hidden branch;
 *   - the audit trail still records who acted, because trust is not anonymity.
 *
 * **Anything reachable over a network MUST NOT be listed here.** The MCP server
 * is stdio and is therefore also local, but it is a *model-driven* surface, so
 * it deliberately is not trusted implicitly — see the adapter's own note.
 */
export const LOCALLY_TRUSTED_ACTORS: readonly string[] = ["cli:local"];

export interface GateInput {
  readonly message: InboundMessage;
  readonly access:
    | AccessFile
    | {
        readonly disabled: boolean;
        readonly allowFrom: readonly string[];
        readonly groups: Record<string, GroupPolicyLike>;
        readonly requireMention: boolean;
      };
}

export interface GroupPolicyLike {
  readonly allowFrom?: readonly string[];
  readonly requireMention?: boolean;
  readonly label?: string;
}

/**
 * §7.1 — the gate. Every inbound message on every adapter passes through this
 * before anything else happens, including before parsing commands.
 */
export class Gate {
  constructor(
    private readonly pairing: PairingManager,
    private readonly audit: AuditLog,
    private readonly access: () => GateInput["access"],
  ) {}

  check(message: InboundMessage): GateOutcome {
    const access = this.access();

    // 1. Master kill. Checked FIRST, before the allowlist, always.
    if (access.disabled) {
      this.audit.append({
        event: "gate.dropped",
        actor: message.actor,
        outcome: "drop",
        ns: "gate",
        fields: { reason: "disabled" },
      });
      return { action: "drop", reason: "disabled" };
    }

    if (!message.isGroup) {
      const key = actorKey(message.actor);
      if (access.allowFrom.includes(key)) return { action: "deliver" };
      // The terminal is trust boundary 1 (§7.4 layer 2). Pairing the CLI with
      // itself would be circular — the code arrives at the same terminal you
      // would have to type it into. The master kill above still applies.
      if (LOCALLY_TRUSTED_ACTORS.includes(key)) {
        this.audit.append({
          event: "gate.delivered",
          actor: message.actor,
          ns: "gate",
          fields: { via: "local-terminal", key },
        });
        return { action: "deliver" };
      }
      return this.pairing.issue(message.actor);
    }

    // Groups are off until an explicit per-group policy exists.
    const policy = access.groups[message.chat.chatId];
    if (!policy) {
      this.audit.append({
        event: "gate.dropped",
        actor: message.actor,
        outcome: "drop",
        ns: "gate",
        fields: { reason: "group not configured", chat: message.chat.chatId },
      });
      return { action: "drop", reason: "group not allowed" };
    }
    if (
      policy.allowFrom &&
      policy.allowFrom.length > 0 &&
      !policy.allowFrom.includes(message.actor.id)
    ) {
      this.audit.append({
        event: "gate.dropped",
        actor: message.actor,
        outcome: "drop",
        ns: "gate",
        fields: { reason: "actor not in group allowlist" },
      });
      return { action: "drop", reason: "not allowed in this group" };
    }
    const requireMention = policy.requireMention ?? access.requireMention;
    if (requireMention && !message.mentionsBot) {
      this.audit.append({
        event: "gate.dropped",
        actor: message.actor,
        outcome: "drop",
        ns: "gate",
        fields: { reason: "mention required" },
      });
      return { action: "drop", reason: "mention the bot to talk to it" };
    }
    return { action: "deliver" };
  }
}

/** Reads the allowlist so `rc access allow <code>` can mutate it. */
export function readAccessFile(stateDir: string): AccessFile {
  const path = accessPath(stateDir);
  if (!existsSync(path))
    return { allowFrom: [], groups: {}, requireMention: true, disabled: false };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AccessFile;
  } catch {
    return { allowFrom: [], groups: {}, requireMention: true, disabled: false };
  }
}

export function writeAccessFile(stateDir: string, access: AccessFile): void {
  writeJsonAtomic(accessPath(stateDir), access);
}

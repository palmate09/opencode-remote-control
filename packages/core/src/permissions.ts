/**
 * Pending-permission registry with first-answer-wins semantics (§2.3, §6).
 *
 * opencode gives us its own permission ids. Those are long and awkward to type
 * on a phone, so we mint a short five-letter id using Claude's alphabet — `a`
 * to `z` excluding `l`, because `l` and `1` are indistinguishable on a phone
 * keyboard — and the relay only answers if the short id still maps to an open
 * request.
 */

import type { AuditLog } from "./logger.js";
import type { PermissionVerdict } from "./types.js";

/** §2.3 / §10.1 — five lowercase letters a–z, minus `l`. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyz";
export const SHORT_ID_LENGTH = 5;

/**
 * §2.3 — the strict reply grammar. Bare `yes` is rejected on purpose: a loose
 * `/yes/i` would silently swallow the user's normal conversation.
 *
 * The plan's grammar is `y|yes|n|no`. We add `a|always` so all three verdicts
 * are reachable by typing, which acceptance test 6 requires. It does not widen
 * the surface in any meaningful way — the five-letter code is still mandatory
 * and a bare `always` is still rejected.
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|always|a|n|no)\s+([a-km-z]{5})\s*$/i;

export interface PendingPermission {
  /** The short id we show the user. */
  readonly shortId: string;
  /** The opencode permission id. Never shown to a human. */
  readonly permissionId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly tool: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Set the moment an answer is applied. Makes the registry first-answer-wins. */
  answered?: PermissionVerdict;
  answeredAt?: number;
  /** Who answered, hashed by the audit layer. */
  answeredBy?: string;
}

export interface PermissionRegistryOptions {
  readonly audit: AuditLog;
  readonly ttlMs?: number;
  readonly maxPending?: number;
  readonly now?: () => number;
}

export function mintShortId(): string {
  let out = "";
  const bytes = new Uint8Array(SHORT_ID_LENGTH);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
  }
  return out;
}

export function isShortId(value: string): boolean {
  return /^[a-km-z]{5}$/.test(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

/**
 * Parses a permission reply. Strict by design: a loose `/yes/i` would silently
 * swallow the user's normal conversation.
 */
export function parsePermissionReply(
  text: string,
): { verdict: PermissionVerdict; shortId: string } | null {
  const m = PERMISSION_REPLY_RE.exec(String(text ?? ""));
  if (!m) return null;
  const [, token, id] = m;
  const word = (token ?? "").toLowerCase();
  const verdict: PermissionVerdict = /^(y|yes)$/.test(word)
    ? "once"
    : /^(a|always)$/.test(word)
      ? "always"
      : "reject";
  return { verdict, shortId: (id ?? "").toLowerCase() };
}

export class PermissionRegistry {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly byOpencodeId = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly audit: AuditLog;

  constructor(opts: PermissionRegistryOptions) {
    this.audit = opts.audit;
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.maxPending = opts.maxPending ?? 100;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Registers a permission request and returns the short id to render. If a
   * short id collides (astronomically unlikely) we re-mint.
   */
  register(input: {
    permissionId: string;
    sessionId: string;
    title: string;
    tool: string;
  }): PendingPermission {
    this.prune();
    const now = this.now();
    let shortId = mintShortId();
    let guard = 0;
    while (this.pending.has(shortId) && guard++ < 32) shortId = mintShortId();

    const entry: PendingPermission = {
      shortId,
      permissionId: input.permissionId,
      sessionId: input.sessionId,
      title: input.title,
      tool: input.tool,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.pending.set(shortId, entry);
    this.byOpencodeId.set(input.permissionId, shortId);

    if (this.pending.size > this.maxPending) {
      this.audit.append({
        event: "permission.registry_full",
        outcome: "error",
        ns: "permissions",
        fields: { size: this.pending.size, max: this.maxPending },
      });
    }
    this.audit.append({
      event: "permission.requested",
      session: input.sessionId,
      ns: "permissions",
      fields: { shortId, tool: input.tool },
    });
    return entry;
  }

  get(shortId: string): PendingPermission | undefined {
    const entry = this.pending.get(normalise(shortId));
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(entry.shortId);
      this.byOpencodeId.delete(entry.permissionId);
      return undefined;
    }
    return entry;
  }

  byOpencode(permissionId: string): PendingPermission | undefined {
    const shortId = this.byOpencodeId.get(permissionId);
    return shortId ? this.get(shortId) : undefined;
  }

  listForSession(sessionId: string): PendingPermission[] {
    return this.list().filter((p) => p.sessionId === sessionId);
  }

  /**
   * Requests still awaiting a verdict.
   *
   * Answered requests are excluded: they are resolved, and reporting them as
   * "pending" would make `/status` lie and would cause a caller polling this
   * list to keep re-answering something that is already closed. They stay in
   * the map only long enough for `claim()` to reject a duplicate tap.
   */
  list(): PendingPermission[] {
    this.prune();
    return [...this.pending.values()].filter((p) => !p.answered);
  }

  /** Every request, answered or not. Used by tests and diagnostics. */
  listAll(): PendingPermission[] {
    this.prune();
    return [...this.pending.values()];
  }

  /**
   * Claims a permission for answering. Returns `null` if it is unknown, expired,
   * or already answered — which is exactly the double-tap guard (§2.2 rule 6).
   */
  claim(shortId: string, by: string): PendingPermission | null {
    const entry = this.get(shortId);
    if (!entry) {
      this.audit.append({
        event: "permission.unknown",
        outcome: "drop",
        ns: "permissions",
        fields: { shortId },
      });
      return null;
    }
    if (entry.answered) {
      this.audit.append({
        event: "permission.duplicate_ignored",
        outcome: "drop",
        session: entry.sessionId,
        ns: "permissions",
        fields: { shortId: entry.shortId, already: entry.answered },
      });
      return null;
    }
    entry.answered = "reject"; // provisional, set before the I/O so a race cannot double-apply
    entry.answeredAt = this.now();
    entry.answeredBy = by;
    return entry;
  }

  markAnswered(shortId: string, verdict: PermissionVerdict): void {
    const entry = this.get(shortId);
    if (entry) entry.answered = verdict;
  }

  /** Releases a provisional claim when the opencode call failed. */
  release(shortId: string): void {
    const entry = this.pending.get(normalise(shortId));
    if (!entry) return;
    if (entry.answeredAt && this.now() - entry.answeredAt < 5_000) {
      entry.answered = undefined;
      entry.answeredAt = undefined;
      entry.answeredBy = undefined;
    }
  }

  forget(permissionId: string): void {
    const shortId = this.byOpencodeId.get(permissionId);
    if (!shortId) return;
    this.pending.delete(shortId);
    this.byOpencodeId.delete(permissionId);
  }

  forgetSession(sessionId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionId !== sessionId) continue;
      this.pending.delete(entry.shortId);
      this.byOpencodeId.delete(entry.permissionId);
    }
  }

  clear(): void {
    this.pending.clear();
    this.byOpencodeId.clear();
  }

  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(id);
        this.byOpencodeId.delete(entry.permissionId);
        removed++;
      }
    }
    return removed;
  }
}

function normalise(shortId: string): string {
  return String(shortId ?? "")
    .trim()
    .toLowerCase();
}

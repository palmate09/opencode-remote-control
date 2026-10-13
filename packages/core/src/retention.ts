/**
 * Retention (§8.6).
 *
 * Purge runs on a timer *and* at startup, because a laptop that was asleep for
 * a month must catch up the moment it wakes — a purely timer-driven purge would
 * leave stale records on disk for as long as the machine was off.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "./logger.js";
import { purgeAuditFile } from "./logger.js";
import type { PairingStore } from "./pairing.js";
import type { PermissionRegistry } from "./permissions.js";

export interface RetentionTargets {
  readonly logDir: string;
  readonly auditPath: string;
  readonly stateDir: string;
}

export interface RetentionOptions {
  readonly logger: Logger;
  readonly logDir: string;
  readonly auditPath: string;
  readonly logRetentionDays: number;
  readonly auditRetentionDays: number;
  readonly pairing: PairingStore;
  readonly permissions: PermissionRegistry;
  /**
   * The live audit log, when one exists.
   *
   * Preferred over rewriting the file directly: the bridge holds an `AuditLog`
   * with an in-memory chain tail, and a purge that only touched the file would
   * leave that tail pointing at a record that no longer exists. Passing the
   * instance lets it re-seat itself so the next append continues the new chain.
   */
  readonly audit?: import("./logger.js").AuditLog;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

const DAY_MS = 86_400_000;

export interface RetentionResult {
  readonly logsRemoved: number;
  readonly auditRecordsRemoved: number;
  readonly pairingsPruned: number;
  readonly permissionsPruned: number;
}

export class Retention {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: RetentionOptions) {}

  /** Safe to call repeatedly; used by both startup and the timer. */
  purge(): RetentionResult {
    const now = this.opts.now ?? Date.now;
    const t = now();
    const logsRemoved = this.purgeOldFiles(
      this.opts.logDir,
      t - this.opts.logRetentionDays * DAY_MS,
    );
    const auditRecordsRemoved = this.rewriteAudit(t - this.opts.auditRetentionDays * DAY_MS);
    const pairingsPruned = this.opts.pairing.prune(t);
    const permissionsPruned = this.opts.permissions.prune();

    if (logsRemoved || auditRecordsRemoved || pairingsPruned || permissionsPruned) {
      this.opts.logger.info("retention purge", {
        logsRemoved,
        auditRecordsRemoved,
        pairingsPruned,
        permissionsPruned,
      });
    }
    return { logsRemoved, auditRecordsRemoved, pairingsPruned, permissionsPruned };
  }

  private purgeOldFiles(dir: string, cutoff: number): number {
    if (!existsSync(dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(dir)) {
      // Never touch the live file or the current rotation slot.
      if (name === "app.log" || name === "audit.jsonl" || !/\.\d+$/.test(name)) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
          removed++;
        }
      } catch {
        // Best-effort.
      }
    }
    return removed;
  }

  /**
   * Drops records outside the window and **re-anchors** the chain, so a purge
   * does not make `rc audit verify` report a break it caused itself.
   *
   * `purgeAuditFile` owns the atomic rewrite (`<path>.purge` + rename); this is
   * only the retention policy on top of it. Retention holds the path rather than
   * a live `AuditLog` on purpose: a second in-memory tail would drift from the
   * file the moment a purge happened.
   */
  private rewriteAudit(cutoff: number): number {
    const predicate = (rec: { ts: string }): boolean => {
      const t = Date.parse(rec.ts);
      return Number.isFinite(t) && t < cutoff;
    };
    // A live AuditLog re-seats its own tail; without one, rewrite the file and
    // rely on the next process to read the re-anchored head.
    const removed = this.opts.audit
      ? this.opts.audit.purge(predicate)
      : purgeAuditFile(this.opts.auditPath, predicate).removed;
    if (removed > 0) this.opts.logger.info("audit log purged and re-chained", { removed });
    return removed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => {
        try {
          this.purge();
        } catch (err) {
          this.opts.logger.error("retention purge failed", { error: String(err) });
        }
      },
      this.opts.intervalMs ?? 6 * 3600_000,
    );
    // Never hold the process open for a purge timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

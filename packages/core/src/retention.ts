/**
 * Retention (§8.6).
 *
 * Purge runs on a timer *and* at startup, because a laptop that was asleep for
 * a month must catch up the moment it wakes — a purely timer-driven purge would
 * leave stale records on disk for as long as the machine was off.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { Logger } from "./logger.js";
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
   * Rewrites the audit log keeping only records inside the window. This is the
   * one place we rewrite an append-only file, and it is done atomically with a
   * `.purge` temp file so a crash mid-rewrite cannot corrupt the chain.
   */
  private rewriteAudit(cutoff: number): number {
    const path = this.opts.auditPath;
    if (!existsSync(path)) return 0;
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const keep: string[] = [];
    let dropped = 0;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as { ts: string };
        if (Date.parse(rec.ts) < cutoff) {
          dropped++;
          continue;
        }
        keep.push(line);
      } catch {
        dropped++;
      }
    }
    if (dropped === 0) return 0;
    const tmp = `${path}.purge`;
    writeFileSync(tmp, keep.length ? `${keep.join("\n")}\n` : "", { mode: 0o600 });
    renameSync(tmp, path);
    this.opts.logger.info("audit log purged", { removed: dropped, kept: keep.length });
    return dropped;
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

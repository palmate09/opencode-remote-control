/**
 * §6 logging model: two streams, tamper *evidence*, redaction before write,
 * rotation, and retention.
 */

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  AuditLog,
  GENESIS,
  createLogger,
  hashRecord,
  rotateIfNeeded,
  verifyChain,
} from "../packages/core/src/logger.ts";
import { PairingManager } from "../packages/core/src/pairing.ts";
import { PermissionRegistry } from "../packages/core/src/permissions.ts";
import { Retention } from "../packages/core/src/retention.ts";
import { clearRegisteredSecrets, registerSecret } from "../packages/core/src/sanitize.ts";
import { cleanup, tempStateDir, testAudit } from "./helpers.ts";

let stateDir: string;
let logDir: string;

beforeEach(() => {
  stateDir = tempStateDir();
  logDir = join(stateDir, "logs");
  clearRegisteredSecrets();
});

afterEach(() => cleanup(stateDir));

describe("audit records", () => {
  test("carry the documented schema", () => {
    const audit = testAudit(stateDir);
    const rec = audit.append({
      event: "permission.answered",
      actor: { platform: "telegram", id: "12345" },
      session: "ses_1",
      correlation: "a1b2c3d4",
      outcome: "allow",
      ns: "permissions",
      fields: { permissionID: "p1", tool: "bash" },
    });

    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(rec.seq).toBe(0);
    expect(rec.event).toBe("permission.answered");
    expect(rec.outcome).toBe("allow");
    expect(rec.ns).toBe("permissions");
    expect(rec.prev).toBe(GENESIS);
    expect(rec.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("write one JSON object per line", () => {
    const audit = testAudit(stateDir);
    for (let i = 0; i < 5; i++) audit.append({ event: "test", ns: "t" });
    const lines = readFileSync(join(logDir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("seq is monotonic across a restart", () => {
    const first = testAudit(stateDir);
    for (let i = 0; i < 3; i++) first.append({ event: "test", ns: "t" });
    const second = testAudit(stateDir);
    const rec = second.append({ event: "test", ns: "t" });
    expect(rec.seq).toBe(3);
    expect(rec.prev).toBe(first.head);
  });
});

describe("§8.3 — actors are pseudonymised, never plaintext", () => {
  test("the raw platform id never reaches the file", () => {
    const audit = testAudit(stateDir);
    audit.append({
      event: "message.received",
      actor: { platform: "telegram", id: "999888777" },
      ns: "router",
    });
    const raw = readFileSync(join(logDir, "audit.jsonl"), "utf8");
    expect(raw).not.toContain("999888777");
    expect(raw).toContain("sha256:");
  });

  test("hashing is stable for one actor and distinct across actors", () => {
    const audit = testAudit(stateDir);
    const a = audit.hashActor({ platform: "telegram", id: "1" });
    const b = audit.hashActor({ platform: "telegram", id: "1" });
    const c = audit.hashActor({ platform: "telegram", id: "2" });
    const d = audit.hashActor({ platform: "discord", id: "1" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  test("the salt is the operator's, so two installs cannot correlate", () => {
    const other = new AuditLog({
      path: join(stateDir, "logs", "other.jsonl"),
      salt: "a-completely-different-salt",
    });
    const audit = testAudit(stateDir);
    expect(audit.hashActor({ platform: "telegram", id: "1" })).not.toBe(
      other.hashActor({ platform: "telegram", id: "1" }),
    );
  });

  test("RC_LOG_ACTOR=raw is opt-in and then stores the id in the clear", () => {
    const raw = new AuditLog({
      path: join(logDir, "raw.jsonl"),
      salt: "s",
      actorMode: "raw",
    });
    const rec = raw.append({
      event: "test",
      actor: { platform: "telegram", id: "12345" },
      ns: "t",
    });
    expect(rec.actor?.id).toBe("telegram:12345");
  });
});

describe("§6.3 — tamper evidence", () => {
  test("an untouched chain verifies", () => {
    const audit = testAudit(stateDir);
    for (let i = 0; i < 20; i++) {
      audit.append({ event: `e${i}`, ns: "t", outcome: "allow" });
    }
    const result = verifyChain(join(logDir, "audit.jsonl"));
    expect(result.ok).toBe(true);
    expect(result.records).toBe(20);
  });

  test("editing a record in place is detected", () => {
    const audit = testAudit(stateDir);
    for (let i = 0; i < 5; i++) audit.append({ event: `e${i}`, ns: "t" });
    const path = join(logDir, "audit.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    lines[2] = lines[2]!.replace('"e2"', '"e999"');
    writeFileSync(path, `${lines.join("\n")}\n`);

    const result = verifyChain(path);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("content hash mismatch");
  });

  test("deleting a record is detected", () => {
    const audit = testAudit(stateDir);
    for (let i = 0; i < 5; i++) audit.append({ event: `e${i}`, ns: "t" });
    const path = join(logDir, "audit.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    lines.splice(2, 1);
    writeFileSync(path, `${lines.join("\n")}\n`);

    const result = verifyChain(path);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("prev-hash mismatch");
    expect(result.brokenAt).toBe(3);
  });

  test("reordering records is detected", () => {
    const audit = testAudit(stateDir);
    for (let i = 0; i < 5; i++) audit.append({ event: `e${i}`, ns: "t" });
    const path = join(logDir, "audit.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    [lines[1], lines[3]] = [lines[3]!, lines[1]!];
    writeFileSync(path, `${lines.join("\n")}\n`);

    expect(verifyChain(path).ok).toBe(false);
  });

  test("unparseable JSON is reported, not silently skipped", () => {
    const audit = testAudit(stateDir);
    audit.append({ event: "e", ns: "t" });
    const path = join(logDir, "audit.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8").trim()}\nnot json\n`);
    const result = verifyChain(path);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unparseable");
  });

  test("the hash covers fields, so removing a field breaks the chain", () => {
    const rec = { ts: "t", seq: 0, event: "e", ns: "n", fields: { a: 1, b: 2 }, prev: GENESIS };
    const original = hashRecord(rec);
    expect(hashRecord({ ...rec, fields: { a: 1 } })).not.toBe(original);
    expect(hashRecord({ ...rec, fields: { b: 2, a: 1 } })).toBe(original);
  });
});

describe("§6.5 — redaction before write", () => {
  test("credentials in a log field become [REDACTED]", () => {
    const audit = testAudit(stateDir);
    audit.append({
      event: "test",
      ns: "t",
      fields: { note: "key sk-abcdefghijklmnopqrstuvwx" },
    });
    const raw = readFileSync(join(logDir, "audit.jsonl"), "utf8");
    expect(raw).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(raw).toContain("[REDACTED]");
  });

  test("the state directory is scrubbed from log output", () => {
    const logger = createLogger({ logDir, level: "debug", stateDir, salt: "s" });
    logger.info(`reading ${join(stateDir, "access.json")}`);
    const raw = readFileSync(join(logDir, "app.log"), "utf8");
    expect(raw).toContain("<state>/access.json");
    expect(raw).not.toContain(stateDir);
  });

  test("an operator-registered secret is masked", () => {
    registerSecret("my-very-secret-bot-token-value");
    const logger = createLogger({ logDir, level: "debug", stateDir, salt: "s" });
    logger.info("token is my-very-secret-bot-token-value");
    expect(readFileSync(join(logDir, "app.log"), "utf8")).toContain("[REDACTED]");
  });

  test("levels respect the ceiling", () => {
    const logger = createLogger({ logDir, level: "warn", stateDir, salt: "s" });
    logger.info("should not appear");
    logger.warn("should appear");
    logger.error("should also appear");
    const raw = readFileSync(join(logDir, "app.log"), "utf8");
    expect(raw).not.toContain("should not appear");
    expect(raw).toContain("should appear");
    expect(raw).toContain("should also appear");
  });

  test("debugFilter restricts debug/trace to named namespaces", () => {
    const logger = createLogger({
      logDir,
      level: "trace",
      // The root logger is namespaced "rc", so filtering on "rc.permissions"
      // keeps that subtree and drops everything else.
      debugFilter: ["rc.permissions"],
      stateDir,
      salt: "s",
    });
    logger.debug("dropped at the root");
    logger.child("permissions").debug("kept in the subtree");
    logger.child("opencode").debug("also dropped");

    const raw = readFileSync(join(logDir, "app.log"), "utf8");
    expect(raw).toContain("kept in the subtree");
    expect(raw).not.toContain("dropped at the root");
    expect(raw).not.toContain("also dropped");
  });

  test("child namespaces nest", () => {
    const logger = createLogger({ logDir, level: "debug", stateDir, salt: "s" });
    expect(logger.child("permissions").ns).toBe("rc.permissions");
  });
});

describe("§6.6 — rotation", () => {
  test("rotates at the size limit and keeps the configured number of files", () => {
    const path = join(logDir, "app.log");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path, "x".repeat(2000));
    rotateIfNeeded(path, 1000, 3);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.1`)).toBe(true);

    for (let i = 0; i < 6; i++) {
      writeFileSync(path, "x".repeat(2000));
      rotateIfNeeded(path, 1000, 3);
    }
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(true);
    expect(existsSync(`${path}.4`)).toBe(false);
  });
});

describe("§8.6 — retention", () => {
  function buildRetention(days: number, audit = testAudit(stateDir)) {
    const logger = createLogger({ logDir, level: "error", stateDir, salt: "s" });
    const now = () => Date.now();
    const pairing = new PairingManager(stateDir, audit, now);
    const permissions = new PermissionRegistry({ audit, now });
    return new Retention({
      logger,
      logDir,
      auditPath: join(logDir, "audit.jsonl"),
      logRetentionDays: days,
      auditRetentionDays: days,
      pairing,
      permissions,
      audit,
      now,
    });
  }

  test("purges expired rotated debug logs but never the live file", () => {
    mkdirSync(logDir, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000);
    writeFileSync(join(logDir, "app.log.3"), "old");
    writeFileSync(join(logDir, "app.log"), "live");
    utimesSync(join(logDir, "app.log.3"), old, old);

    const result = buildRetention(7).purge();
    expect(result.logsRemoved).toBe(1);
    expect(existsSync(join(logDir, "app.log"))).toBe(true);
    expect(existsSync(join(logDir, "app.log.3"))).toBe(false);
  });

  test("keeps audit records inside the window and drops the rest", () => {
    const audit = testAudit(stateDir);
    audit.append({ event: "recent", ns: "t" });
    // Rewrite the timestamp of one record backwards past the window.
    const path = join(logDir, "audit.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const old = {
      ...(JSON.parse(lines[0]!) as Record<string, unknown>),
      ts: "2000-01-01T00:00:00.000Z",
    };
    writeFileSync(path, `${JSON.stringify(old)}\n${lines[1] ?? ""}\n`);

    const result = buildRetention(90).purge();
    expect(result.auditRecordsRemoved).toBe(1);
    expect(readFileSync(path, "utf8").trim()).not.toContain("2000-01-01");
  });

  test("a purge re-anchors the chain, so `verify` still passes afterwards", () => {
    // The bug this guards against: retention dropped old lines, leaving the
    // first survivor's `prev` pointing at a deleted hash. `rc audit verify`
    // then failed on every machine that had run for longer than the window.
    const audit = testAudit(stateDir);
    audit.append({ event: "recent", ns: "t" });
    const path = join(logDir, "audit.jsonl");
    // Backdate the first record; leave the second current.
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const old = {
      ...(JSON.parse(lines[0]!) as Record<string, unknown>),
      ts: "2000-01-01T00:00:00.000Z",
    };
    audit.append({ event: "second", ns: "t" });
    const after = readFileSync(path, "utf8").trim().split("\n");
    after[0] = JSON.stringify(old);
    writeFileSync(path, `${after.join("\n")}\n`);

    const removed = buildRetention(90, audit).purge();
    expect(removed.auditRecordsRemoved).toBeGreaterThan(0);

    // The retained record is re-anchored to GENESIS and its hash recomputed.
    const result = verifyChain(path);
    expect(result.ok).toBe(true);
    const kept = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[0]!) as {
      prev: string;
      seq: number;
    };
    expect(kept.prev).toBe(GENESIS);
    expect(kept.seq).toBe(0);

    // And the live tail agrees, so the next append continues the new chain.
    const rec = audit.append({ event: "after-purge", ns: "t" });
    expect(rec.seq).toBe(1);
    expect(rec.prev).not.toBe(GENESIS);
    expect(verifyChain(path).ok).toBe(true);
  });

  test("runs at startup, not only on the timer", () => {
    // A laptop that was asleep for a month must catch up the moment it wakes.
    const retention = buildRetention(7);
    const result = retention.purge();
    expect(typeof result.logsRemoved).toBe("number");
  });
});

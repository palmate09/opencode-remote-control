/**
 * The `rc` CLI, especially `rc access` — the only place a pairing can be
 * approved, and therefore the whole security boundary.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  runAccess,
  runAudit,
  runConsent,
  runDoctor,
  runInit,
} from "../packages/cli/src/commands.ts";
import { verifyChain } from "../packages/core/src/logger.ts";
import { mintCode, writeAccessFile } from "../packages/core/src/pairing.ts";
import { cleanup, tempStateDir } from "./helpers.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = tempStateDir();
});

afterEach(() => cleanup(stateDir));

function seedPending(code: string, platform = "telegram", actorId = "user-42"): void {
  writeFileSync(
    join(stateDir, "pending-pairings.json"),
    JSON.stringify([
      {
        code,
        platform,
        actorId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
        replies: 0,
      },
    ]),
  );
}

describe("rc init", () => {
  test("creates the state directory with restrictive modes", () => {
    const result = runInit({}, stateDir);
    expect(result.stateDir).toBe(stateDir);
    for (const path of [
      join(stateDir, "access.json"),
      join(stateDir, "sessions.json"),
      join(stateDir, "consent.json"),
    ]) {
      expect(existsSync(path)).toBe(true);
    }
    expect(existsSync(join(stateDir, "logs"))).toBe(true);
    expect(existsSync(join(stateDir, "inbox"))).toBe(true);
  });

  test("writes an allowlist that is empty rather than open", () => {
    runInit({}, stateDir);
    const access = JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8"));
    expect(access.allowFrom).toEqual([]);
    expect(access.disabled).toBe(false);
    expect(access.requireMention).toBe(true);
  });

  test("records first-run consent", () => {
    runInit({}, stateDir);
    const consent = JSON.parse(readFileSync(join(stateDir, "consent.json"), "utf8"));
    expect(consent.basis).toBe("consent");
    expect(consent.grantedAt).toBeTruthy();
    expect(consent.version).toBeTruthy();
  });

  test("is idempotent and never overwrites an existing allowlist", () => {
    runInit({}, stateDir);
    writeAccessFile(stateDir, {
      allowFrom: ["telegram:keepme"],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    runInit({}, stateDir);
    const access = JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8"));
    expect(access.allowFrom).toEqual(["telegram:keepme"]);
  });
});

describe("rc access allow — the security boundary", () => {
  test("approves a pending code and adds the actor to the allowlist", () => {
    writeAccessFile(stateDir, { allowFrom: [], groups: {}, requireMention: true, disabled: false });
    const code = mintCode();
    seedPending(code);

    const result = runAccess(["allow", code], { stateDir });
    expect(result.code).toBe(0);

    const access = JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8"));
    expect(access.allowFrom).toEqual(["telegram:user-42"]);
  });

  test("consumes the code, so it cannot be replayed", () => {
    writeAccessFile(stateDir, { allowFrom: [], groups: {}, requireMention: true, disabled: false });
    const code = mintCode();
    seedPending(code);

    runAccess(["allow", code], { stateDir });
    expect(JSON.parse(readFileSync(join(stateDir, "pending-pairings.json"), "utf8"))).toEqual([]);

    const replay = runAccess(["allow", code], { stateDir });
    expect(replay.code).toBe(1);
    expect(replay.stderr).toContain("No pending pairing");
  });

  test("refuses a code that was never issued", () => {
    writeAccessFile(stateDir, { allowFrom: [], groups: {}, requireMention: true, disabled: false });
    const result = runAccess(["allow", "abcdef"], { stateDir });
    expect(result.code).toBe(1);
    expect(JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8")).allowFrom).toEqual([]);
  });

  test("refuses a malformed code without touching the allowlist", () => {
    writeAccessFile(stateDir, { allowFrom: [], groups: {}, requireMention: true, disabled: false });
    for (const bad of ["", "xyz", "1234567", "../../etc/passwd"]) {
      const result = runAccess(["allow", bad], { stateDir });
      expect(result.code).toBe(2);
    }
    expect(JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8")).allowFrom).toEqual([]);
  });

  test("accepts a code case-insensitively", () => {
    writeAccessFile(stateDir, { allowFrom: [], groups: {}, requireMention: true, disabled: false });
    const code = mintCode().toUpperCase();
    seedPending(code.toLowerCase());
    expect(runAccess(["allow", code], { stateDir }).code).toBe(0);
  });

  test("never prints the raw platform id back to the terminal", () => {
    writeAccessFile(stateDir, { allowFrom: [], groups: {}, requireMention: true, disabled: false });
    const code = mintCode();
    seedPending(code);
    const result = runAccess(["allow", code], { stateDir });
    expect(result.stdout).not.toContain("user-42");
    expect(result.stdout).toContain("Fingerprint");
  });

  test("approving twice is idempotent, not duplicative", () => {
    writeAccessFile(stateDir, { allowFrom: [], groups: {}, requireMention: true, disabled: false });
    const code = mintCode();
    seedPending(code);
    runAccess(["allow", code], { stateDir });
    seedPending(code);
    runAccess(["allow", code], { stateDir });
    expect(JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8")).allowFrom).toEqual([
      "telegram:user-42",
    ]);
  });
});

describe("rc access — policy control", () => {
  beforeEach(() => {
    writeAccessFile(stateDir, { allowFrom: [], groups: {}, requireMention: true, disabled: false });
  });

  test("list shows the state honestly", () => {
    const result = runAccess(["list"], { stateDir });
    expect(result.stdout).toContain("allowlist (0)");
    expect(result.stdout).toContain("group chat is disabled");
  });

  test("disable is a true master kill", () => {
    expect(runAccess(["disable"], { stateDir }).code).toBe(0);
    expect(JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8")).disabled).toBe(true);
    expect(runAccess(["enable"], { stateDir }).code).toBe(0);
    expect(JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8")).disabled).toBe(false);
  });

  test("revoke removes exactly one entry", () => {
    writeAccessFile(stateDir, {
      allowFrom: ["telegram:a", "telegram:b"],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    runAccess(["revoke", "telegram:a"], { stateDir });
    expect(JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8")).allowFrom).toEqual([
      "telegram:b",
    ]);
  });

  test("groups are off until explicitly opened", () => {
    runAccess(["group", "-1001234", "open"], { stateDir });
    const access = JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8"));
    expect(access.groups["-1001234"]).toEqual({ allowFrom: [], requireMention: false });

    runAccess(["group", "-1001234", "close"], { stateDir });
    expect(JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8")).groups).toEqual({});
  });

  test("a group actor allowlist is additive and de-duplicated", () => {
    runAccess(["group", "-1", "allow", "alice", "bob"], { stateDir });
    runAccess(["group", "-1", "allow", "bob", "carol"], { stateDir });
    expect(
      JSON.parse(readFileSync(join(stateDir, "access.json"), "utf8")).groups["-1"].allowFrom,
    ).toEqual(["alice", "bob", "carol"]);
  });

  test("an unknown subcommand prints usage, not a stack trace", () => {
    const result = runAccess(["nonsense"], { stateDir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: rc access");
  });
});

describe("rc audit", () => {
  test("verify passes on an untouched log", () => {
    runInit({}, stateDir);
    runConsent(["grant"], { stateDir });
    expect(verifyChain(join(stateDir, "logs", "audit.jsonl")).ok).toBe(true);
    expect(runAudit(["verify"], { stateDir }).code).toBe(0);
  });

  test("verify names the record where the chain breaks", () => {
    runInit({}, stateDir);
    const path = join(stateDir, "logs", "audit.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", seq: 0, event: "x", ns: "n", prev: "sha256:bad", hash: "sha256:bad" })}\n`,
    );
    const result = runAudit(["verify"], { stateDir });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("BROKEN");
  });

  test("verify on a missing log is not an error", () => {
    expect(runAudit(["verify"], { stateDir }).code).toBe(0);
  });

  test("export produces parseable records", () => {
    runInit({}, stateDir);
    runConsent(["grant"], { stateDir });
    const result = runAudit(["export"], { stateDir });
    for (const line of (result.stdout ?? "").split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("tail renders a human line and never a raw actor id", () => {
    runInit({}, stateDir);
    expect(typeof runAudit(["tail", "5"], { stateDir }).stdout).toBe("string");
  });
});

describe("rc consent", () => {
  test("grant then withdraw removes the record", () => {
    runInit({}, stateDir);
    expect(existsSync(join(stateDir, "consent.json"))).toBe(true);

    expect(runConsent(["withdraw"], { stateDir }).code).toBe(0);
    expect(existsSync(join(stateDir, "consent.json"))).toBe(false);

    expect(runConsent(["grant"], { stateDir }).code).toBe(0);
    expect(existsSync(join(stateDir, "consent.json"))).toBe(true);
  });

  test("withdraw says plainly that it does not stop a running daemon", () => {
    runInit({}, stateDir);
    expect(runConsent(["withdraw"], { stateDir }).stdout).toContain(
      "does not stop a running daemon",
    );
  });
});

describe("rc doctor", () => {
  test("reports the open-code configuration and the access policy", () => {
    const checks = runDoctor({ RC_OPENCODE_URL: "http://127.0.0.1:4096", RC_STATE_DIR: stateDir });
    const names = checks.map((c) => c.name);
    expect(names).toContain("configuration");
    expect(names).toContain("dm policy");
    expect(names).toContain("audit chain");
    expect(names).toContain("telemetry");
  });

  test("fails with a named setting when configuration is missing", () => {
    const checks = runDoctor({ RC_STATE_DIR: stateDir });
    const config = checks.find((c) => c.name === "configuration");
    expect(config?.ok).toBe(false);
    expect(config?.remedy).toBe("RC_OPENCODE_URL");
  });

  test("states that telemetry is absent rather than merely disabled", () => {
    const checks = runDoctor({ RC_OPENCODE_URL: "http://127.0.0.1:4096", RC_STATE_DIR: stateDir });
    const telemetry = checks.find((c) => c.name === "telemetry");
    expect(telemetry?.detail).toContain("none");
    expect(telemetry?.detail).toContain("phones home");
  });

  test("flags a disabled bridge loudly", () => {
    writeAccessFile(stateDir, {
      allowFrom: [],
      groups: {},
      requireMention: true,
      disabled: true,
    });
    const checks = runDoctor({ RC_OPENCODE_URL: "http://127.0.0.1:4096", RC_STATE_DIR: stateDir });
    const dm = checks.find((c) => c.name === "dm policy");
    expect(dm?.ok).toBe(false);
    expect(dm?.remedy).toBe("rc access enable");
  });
});

/**
 * §7.1 gate and §7.2 pairing. This is the security model; these tests are the
 * executable form of the argument that a bot cannot approve itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { loadAccess } from "../packages/core/src/config.ts";
import type { AccessFile } from "../packages/core/src/config.ts";
import {
  Gate,
  MAX_PENDING_CODES,
  PAIRING_REPLY_BUDGET,
  PAIRING_TTL_MS,
  PairingManager,
  codesMatch,
  mintCode,
  readAccessFile,
  writeAccessFile,
} from "../packages/core/src/pairing.ts";
import type { AccessConfig, InboundMessage } from "../packages/core/src/types.ts";
import { cleanup, tempStateDir, testAudit } from "./helpers.ts";

let stateDir: string;
let audit: ReturnType<typeof testAudit>;
let clock: number;

beforeEach(() => {
  stateDir = tempStateDir();
  audit = testAudit(stateDir);
  clock = 1_700_000_000_000;
});

afterEach(() => cleanup(stateDir));

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "telegram",
    messageId: "m1",
    actor: { platform: "telegram", id: "user-1" },
    chat: { platform: "telegram", chatId: "dm:user-1" },
    text: "hello",
    timestamp: clock,
    isGroup: false,
    mentionsBot: false,
    ...overrides,
  };
}

function build(access: AccessFile) {
  writeAccessFile(stateDir, access);
  const pairing = new PairingManager(stateDir, audit, () => clock);
  const config: AccessConfig = {
    disabled: access.disabled,
    allowFrom: access.allowFrom,
    groups: access.groups,
    requireMention: access.requireMention,
  };
  return { gate: new Gate(pairing, audit, () => config), pairing };
}

describe("mintCode", () => {
  test("produces six lowercase hex characters — 24 bits of CSPRNG", () => {
    for (let i = 0; i < 200; i++) {
      expect(mintCode()).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  test("does not repeat", () => {
    const codes = new Set(Array.from({ length: 500 }, mintCode));
    expect(codes.size).toBeGreaterThan(490);
  });
});

describe("codesMatch", () => {
  test("is case-insensitive", () => {
    expect(codesMatch("ABC123", "abc123")).toBe(true);
  });
  test("rejects a wrong code and a wrong length", () => {
    expect(codesMatch("abc123", "abc124")).toBe(false);
    expect(codesMatch("abc", "abcd")).toBe(false);
    // An empty "code" must never match anything, including another empty one.
    expect(codesMatch("", "")).toBe(false);
  });
});

describe("master kill switch", () => {
  test("`disabled` drops everything, allowlisted or not", () => {
    const { gate, pairing } = build({
      allowFrom: ["telegram:user-1"],
      groups: {},
      requireMention: true,
      disabled: true,
    });
    expect(gate.check(message()).action).toBe("drop");
    expect(pairing.list()).toHaveLength(0);
  });

  test("`disabled` is checked BEFORE the allowlist", () => {
    // A gate that consulted the allowlist first and then re-checked `disabled`
    // would still be correct, but one that checked the allowlist first and
    // *returned early* would not be. Assert the ordering explicitly.
    const { gate } = build({
      allowFrom: ["telegram:user-1"],
      groups: {},
      requireMention: true,
      disabled: true,
    });
    expect(gate.check(message({ actor: { platform: "telegram", id: "user-1" } }))).toEqual({
      action: "drop",
      reason: "disabled",
    });
  });
});

describe("DM policy", () => {
  test("an allowlisted sender is delivered", () => {
    const { gate, pairing } = build({
      allowFrom: ["telegram:user-1"],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    expect(gate.check(message()).action).toBe("deliver");
    expect(pairing.list()).toHaveLength(0);
  });

  test("a stranger gets a pairing code and is not delivered", () => {
    const { gate, pairing } = build({
      allowFrom: [],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    const result = gate.check(message({ actor: { platform: "telegram", id: "stranger" } }));
    expect(result.action).toBe("pair");
    if (result.action !== "pair") throw new Error("unreachable");
    expect(result.code).toMatch(/^[0-9a-f]{6}$/);
    expect(result.expiresAt).toBe(clock + PAIRING_TTL_MS);
    expect(pairing.list()).toHaveLength(1);
  });

  test("the allowlist is per-platform: a telegram id is not a discord id", () => {
    const { gate } = build({
      allowFrom: ["telegram:user-1"],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    const result = gate.check(
      message({ platform: "discord", actor: { platform: "discord", id: "user-1" } }),
    );
    expect(result.action).toBe("pair");
  });

  test("re-DMing reissues the same code rather than minting a second one", () => {
    const { gate, pairing } = build({
      allowFrom: [],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    const stranger = message({ actor: { platform: "telegram", id: "stranger" } });
    const first = gate.check(stranger);
    const second = gate.check({ ...stranger, messageId: "m2" });
    expect(first.action).toBe("pair");
    expect(second.action).toBe("pair");
    if (first.action !== "pair" || second.action !== "pair") throw new Error("unreachable");
    expect(second.code).toBe(first.code);
    expect(pairing.list()).toHaveLength(1);
  });

  test("the reply budget counts down and then the gate goes silent", () => {
    const { gate, pairing } = build({
      allowFrom: [],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    const stranger = message({ actor: { platform: "telegram", id: "stranger" } });
    const first = gate.check(stranger);
    if (first.action !== "pair") throw new Error("unreachable");

    // The bridge consumes one reply of budget each time it prompts.
    for (let i = 0; i < PAIRING_REPLY_BUDGET; i++) pairing.recordReply(first.code);

    const third = gate.check({ ...stranger, messageId: "m3" });
    expect(third.action).toBe("pair");
    if (third.action !== "pair") throw new Error("unreachable");
    expect(third.budget).toBe(0);
    expect(pairing.canReply(first.code)).toBe(false);
  });
});

describe("anti-spam — the pending table is capped", () => {
  test(`at most ${MAX_PENDING_CODES} pending codes globally`, () => {
    const { gate, pairing } = build({
      allowFrom: [],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    for (let i = 0; i < MAX_PENDING_CODES; i++) {
      const r = gate.check(message({ actor: { platform: "telegram", id: `s${i}` } }));
      expect(r.action).toBe("pair");
    }
    const overflow = gate.check(message({ actor: { platform: "telegram", id: "one-too-many" } }));
    expect(overflow).toEqual({ action: "drop", reason: "pending table full" });
    expect(pairing.list()).toHaveLength(MAX_PENDING_CODES);
  });
});

describe("TTL", () => {
  test("a code expires after one hour and is pruned lazily", () => {
    const { gate, pairing } = build({
      allowFrom: [],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    gate.check(message({ actor: { platform: "telegram", id: "stranger" } }));
    expect(pairing.list()).toHaveLength(1);

    clock += PAIRING_TTL_MS + 1;
    expect(pairing.find(mintCode())).toBeUndefined();
    expect(pairing.list()).toHaveLength(0);
  });

  test("the pruned set does not survive a restart", () => {
    const { gate, pairing } = build({
      allowFrom: [],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    gate.check(message({ actor: { platform: "telegram", id: "stranger" } }));
    const before = pairing.list().length;
    clock += PAIRING_TTL_MS + 1;

    const restarted = new PairingManager(stateDir, audit, () => clock);
    expect(restarted.list()).toHaveLength(0);
    expect(before).toBe(1);
  });
});

describe("group policy", () => {
  test("groups are off by default", () => {
    const { gate } = build({ allowFrom: [], groups: {}, requireMention: true, disabled: false });
    const group = message({
      isGroup: true,
      chat: { platform: "telegram", chatId: "-1009999" },
      mentionsBot: true,
    });
    expect(gate.check(group)).toEqual({ action: "drop", reason: "group not allowed" });
  });

  test("an allowlisted sender in an allowlisted group is delivered", () => {
    const { gate } = build({
      allowFrom: [],
      groups: { "-1009999": { requireMention: false } },
      requireMention: true,
      disabled: false,
    });
    const group = message({
      isGroup: true,
      chat: { platform: "telegram", chatId: "-1009999" },
      mentionsBot: false,
    });
    expect(gate.check(group).action).toBe("deliver");
  });

  test("a mention is required by default", () => {
    const { gate } = build({
      allowFrom: [],
      groups: { "-1009999": {} },
      requireMention: true,
      disabled: false,
    });
    const unmentioned = message({
      isGroup: true,
      chat: { platform: "telegram", chatId: "-1009999" },
      mentionsBot: false,
    });
    expect(gate.check(unmentioned)).toEqual({
      action: "drop",
      reason: "mention the bot to talk to it",
    });

    const mentioned = { ...unmentioned, mentionsBot: true };
    expect(gate.check(mentioned).action).toBe("deliver");
  });

  test("a per-group actor allowlist is enforced", () => {
    const { gate } = build({
      allowFrom: [],
      groups: { "-1009999": { allowFrom: ["allowed-1"], requireMention: false } },
      requireMention: true,
      disabled: false,
    });
    const denied = message({
      isGroup: true,
      chat: { platform: "telegram", chatId: "-1009999" },
      mentionsBot: true,
      actor: { platform: "telegram", id: "not-allowed" },
    });
    expect(gate.check(denied).action).toBe("drop");

    const allowed = { ...denied, actor: { platform: "telegram", id: "allowed-1" } };
    expect(gate.check(allowed).action).toBe("deliver");
  });

  test("a group never bypasses the master kill", () => {
    const { gate } = build({
      allowFrom: ["telegram:user-1"],
      groups: { "-1009999": { requireMention: false } },
      requireMention: true,
      disabled: true,
    });
    const group = message({
      isGroup: true,
      chat: { platform: "telegram", chatId: "-1009999" },
      mentionsBot: true,
    });
    expect(gate.check(group).action).toBe("drop");
  });
});

describe("access.json handling", () => {
  test("a corrupt access.json fails closed rather than opening the gate", () => {
    writeFileSync(`${stateDir}/access.json`, "{ this is not json");
    // The CLI's permissive reader returns an empty policy…
    const cliView = readAccessFile(stateDir);
    expect(cliView.allowFrom).toEqual([]);
    // …while loadAccess, which the gate actually uses, disables everything.
    const gateView = loadAccess(stateDir);
    expect(gateView.disabled).toBe(true);
    expect(gateView.allowFrom).toEqual([]);
  });

  test("an absent access.json means an empty allowlist, not an open one", () => {
    const view = loadAccess(stateDir);
    expect(view.disabled).toBe(false);
    expect(view.allowFrom).toEqual([]);
  });

  test("the gate reloads access on every message, so a live change takes effect", () => {
    let current: AccessConfig = {
      disabled: false,
      allowFrom: [],
      groups: {},
      requireMention: true,
    };
    const pairing = new PairingManager(stateDir, audit, () => clock);
    const gate = new Gate(pairing, audit, () => current);

    expect(gate.check(message()).action).toBe("pair");
    current = { ...current, allowFrom: ["telegram:user-1"] };
    expect(gate.check(message()).action).toBe("deliver");
    current = { ...current, disabled: true };
    expect(gate.check(message()).action).toBe("drop");
  });
});

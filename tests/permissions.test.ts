/**
 * §2.3 permission relay and the four-step protocol from the plan.
 *
 * The properties that matter: short ids use Claude's phone-legible alphabet,
 * the reply grammar is strict, and **first answer wins**.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  PERMISSION_REPLY_RE,
  PermissionRegistry,
  isShortId,
  mintShortId,
  parsePermissionReply,
} from "../packages/core/src/permissions.ts";
import { Router } from "../packages/core/src/router.ts";
import type { InboundMessage } from "../packages/core/src/types.ts";
import { cleanup, tempStateDir, testAudit } from "./helpers.ts";

let stateDir: string;
let registry: PermissionRegistry;
let clock: number;

beforeEach(() => {
  stateDir = tempStateDir();
  const audit = testAudit(stateDir);
  clock = 1_700_000_000_000;
  registry = new PermissionRegistry({ audit, ttlMs: 60_000, now: () => clock });
});

afterEach(() => cleanup(stateDir));

describe("short ids", () => {
  test("use five letters a-z excluding `l`", () => {
    // `l` and `1` are indistinguishable on a phone keyboard, so `l` is out.
    for (let i = 0; i < 500; i++) {
      const id = mintShortId();
      expect(id).toMatch(/^[a-km-z]{5}$/);
      expect(id).not.toContain("l");
    }
  });

  test("do not collide in practice", () => {
    const ids = new Set(Array.from({ length: 2000 }, mintShortId));
    expect(ids.size).toBeGreaterThan(1990);
  });

  test("isShortId rejects `l` and wrong lengths", () => {
    expect(isShortId("abcde")).toBe(true);
    expect(isShortId("abcde".replace("a", "l"))).toBe(false);
    expect(isShortId("abcd")).toBe(false);
    expect(isShortId("abcdef")).toBe(false);
  });
});

describe("the strict reply grammar", () => {
  test("accepts the documented forms, case-insensitively", () => {
    expect(PERMISSION_REPLY_RE.test("yes abcde")).toBe(true);
    expect(PERMISSION_REPLY_RE.test("Y ABCDE")).toBe(true);
    expect(PERMISSION_REPLY_RE.test("  no   abcde  ")).toBe(true);
    expect(PERMISSION_REPLY_RE.test("always abcde")).toBe(true);
  });

  test("rejects a bare yes — this is the whole point of the strictness", () => {
    // A loose /yes/i would swallow the user's ordinary conversation and approve
    // something they never looked at.
    expect(parsePermissionReply("yes")).toBeNull();
    expect(parsePermissionReply("no")).toBeNull();
    expect(parsePermissionReply("yes please")).toBeNull();
    expect(parsePermissionReply("sure, go ahead")).toBeNull();
    expect(parsePermissionReply("ok")).toBeNull();
  });

  test("rejects chatter around an otherwise-valid reply", () => {
    expect(parsePermissionReply("hey yes abcde please")).toBeNull();
    expect(parsePermissionReply("yes abcde thanks")).toBeNull();
  });

  test("requires the five-letter code", () => {
    expect(parsePermissionReply("yes abcd")).toBeNull();
    expect(parsePermissionReply("yes abcdef")).toBeNull();
    expect(parsePermissionReply("yes 12345")).toBeNull();
    expect(parsePermissionReply("yes abcde" + "l")).toBeNull();
  });

  test("maps each token to the three opencode verdicts", () => {
    expect(parsePermissionReply("yes abcde")).toEqual({ verdict: "once", shortId: "abcde" });
    expect(parsePermissionReply("y abcde")).toEqual({ verdict: "once", shortId: "abcde" });
    expect(parsePermissionReply("always abcde")).toEqual({ verdict: "always", shortId: "abcde" });
    expect(parsePermissionReply("no abcde")).toEqual({ verdict: "reject", shortId: "abcde" });
  });
});

describe("the four-step protocol", () => {
  test("1. opencode asks → 2. we mint a short id → 3. a verdict arrives → 4. it applies only if the id is open", () => {
    const entry = registry.register({
      permissionId: "perm_opencode_123",
      sessionId: "ses_1",
      title: "rm -rf build",
      tool: "bash",
    });

    // Step 2: the short id is what a human types.
    expect(entry.shortId).not.toBe("perm_opencode_123");

    // Step 3 + 4.
    const parsed = parsePermissionReply(`yes ${entry.shortId}`);
    expect(parsed).not.toBeNull();
    const claimed = registry.claim(parsed!.shortId, "telegram:1");
    expect(claimed?.permissionId).toBe("perm_opencode_123");
  });

  test("an unknown code is refused, not guessed at", () => {
    expect(registry.claim("zzzzz", "telegram:1")).toBeNull();
    expect(registry.claim("", "telegram:1")).toBeNull();
  });

  test("first answer wins — a second tap is ignored", () => {
    const entry = registry.register({
      permissionId: "p1",
      sessionId: "ses_1",
      title: "t",
      tool: "bash",
    });
    expect(registry.claim(entry.shortId, "telegram:1")).not.toBeNull();
    expect(registry.claim(entry.shortId, "telegram:1")).toBeNull();
    expect(registry.claim(entry.shortId, "telegram:2")).toBeNull();
  });

  test("the claim is provisional, so a failed opencode call can release it", () => {
    const entry = registry.register({
      permissionId: "p1",
      sessionId: "ses_1",
      title: "t",
      tool: "bash",
    });
    expect(registry.claim(entry.shortId, "telegram:1")).not.toBeNull();
    registry.release(entry.shortId);
    expect(registry.claim(entry.shortId, "telegram:1")).not.toBeNull();
  });

  test("a release only works within a few seconds of the claim", () => {
    const entry = registry.register({
      permissionId: "p1",
      sessionId: "ses_1",
      title: "t",
      tool: "bash",
    });
    registry.claim(entry.shortId, "telegram:1");
    clock += 60_000;
    registry.release(entry.shortId);
    expect(registry.claim(entry.shortId, "telegram:1")).toBeNull();
  });

  test("expired requests are unreachable", () => {
    const entry = registry.register({
      permissionId: "p1",
      sessionId: "ses_1",
      title: "t",
      tool: "bash",
    });
    clock += 60_001;
    expect(registry.get(entry.shortId)).toBeUndefined();
    expect(registry.claim(entry.shortId, "telegram:1")).toBeNull();
  });

  test("opencode's own id resolves back to the short id", () => {
    const entry = registry.register({
      permissionId: "p_opencode",
      sessionId: "ses_1",
      title: "t",
      tool: "bash",
    });
    expect(registry.byOpencode("p_opencode")?.shortId).toBe(entry.shortId);
  });

  test("permission.replied closes the request", () => {
    const entry = registry.register({
      permissionId: "p1",
      sessionId: "ses_1",
      title: "t",
      tool: "bash",
    });
    registry.markAnswered(entry.shortId, "once");
    expect(registry.claim(entry.shortId, "telegram:1")).toBeNull();
  });

  test("forgetSession clears every request for a session", () => {
    registry.register({ permissionId: "p1", sessionId: "ses_1", title: "a", tool: "bash" });
    registry.register({ permissionId: "p2", sessionId: "ses_1", title: "b", tool: "bash" });
    registry.register({ permissionId: "p3", sessionId: "ses_2", title: "c", tool: "bash" });
    expect(registry.list()).toHaveLength(3);
    registry.forgetSession("ses_1");
    expect(registry.list()).toHaveLength(1);
  });

  test("an answered request stops appearing as pending", () => {
    // `/status` reports "pending permissions: N" from this list, so an answered
    // request that stayed here would be a lie, and a poller would keep
    // re-answering something already closed.
    const entry = registry.register({
      permissionId: "p1",
      sessionId: "ses_1",
      title: "t",
      tool: "bash",
    });
    expect(registry.list()).toHaveLength(1);
    registry.claim(entry.shortId, "telegram:1");
    registry.markAnswered(entry.shortId, "once");
    expect(registry.list()).toHaveLength(0);
    expect(registry.listAll()).toHaveLength(1);
    // Still unreachable for a second answer — first answer wins.
    expect(registry.claim(entry.shortId, "telegram:1")).toBeNull();
  });

  test("listForSession scopes the view to one session", () => {
    registry.register({ permissionId: "p1", sessionId: "ses_1", title: "a", tool: "bash" });
    registry.register({ permissionId: "p2", sessionId: "ses_2", title: "b", tool: "bash" });
    expect(registry.listForSession("ses_1")).toHaveLength(1);
  });
});

describe("router — permission replies are checked before commands", () => {
  const router = new Router();

  function msg(text: string): InboundMessage {
    return {
      platform: "telegram",
      messageId: "m",
      actor: { platform: "telegram", id: "u" },
      chat: { platform: "telegram", chatId: "dm:u" },
      text,
      timestamp: 0,
      isGroup: false,
      mentionsBot: false,
    };
  }

  test("a permission reply routes as a permission intent", () => {
    expect(router.route(msg("yes abcde"))).toEqual({
      kind: "permission",
      shortId: "abcde",
      verdict: "once",
    });
    expect(router.route(msg("no abcde"))).toEqual({
      kind: "permission",
      shortId: "abcde",
      verdict: "reject",
    });
  });

  test("a command routes as a command intent", () => {
    expect(router.route(msg("/new fix the parser"))).toEqual({
      kind: "command",
      name: "new",
      args: ["fix", "the", "parser"],
      raw: "/new fix the parser",
    });
    expect(router.route(msg("/abort"))).toEqual({
      kind: "command",
      name: "abort",
      args: [],
      raw: "/abort",
    });
  });

  test("an unknown slash command is still a command, not a prompt", () => {
    // Otherwise `/rm -rf /` would be forwarded to the model as a prompt.
    expect(router.route(msg("/nope now")).kind).toBe("command");
  });

  test("btw queues a follow-up instead of running now", () => {
    expect(router.route(msg("btw also bump the version"))).toEqual({
      kind: "btw",
      text: "also bump the version",
    });
  });

  test("ordinary text is a prompt", () => {
    expect(router.route(msg("fix the failing test"))).toEqual({
      kind: "prompt",
      text: "fix the failing test",
    });
  });

  test("empty text is ignored", () => {
    expect(router.route(msg("   ")).kind).toBe("ignore");
  });

  test("the bot's own messages are ignored", () => {
    const botRouter = new Router({ botUserId: "bot-1" });
    const self = { ...msg("/status"), actor: { platform: "telegram", id: "bot-1" } };
    expect(botRouter.route(self)).toEqual({ kind: "ignore", reason: "self" });
  });

  test("the command prefix is configurable for Slack", () => {
    const slack = new Router({ commandPrefix: "!" });
    expect(slack.route(msg("!help")).kind).toBe("command");
    // A `/help` on Slack is a slash command the workspace handles, not ours.
    expect(slack.route(msg("/help")).kind).toBe("prompt");
  });

  test("help lists every command with its usage", () => {
    const names = router.help().map((h) => h.name);
    for (const expected of [
      "new",
      "sessions",
      "status",
      "diff",
      "abort",
      "export",
      "forget",
      "privacy",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

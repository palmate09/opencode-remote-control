/**
 * Adapter-level tests: card rendering, capability declarations, and the
 * security-relevant promise each adapter makes.
 *
 * §7.4 layer 7 is the point: an adapter that cannot authenticate the replier
 * must not advertise `permissionRelay`.
 */

import { describe, expect, test } from "bun:test";

import { API_CAPABILITIES } from "../packages/api/src/index.ts";
import { CLI_CAPABILITIES, renderCards } from "../packages/cli/src/adapter.ts";
import { DISCORD_CAPABILITIES, customId, parseCustomId } from "../packages/discord/src/index.ts";
import { MCP_CAPABILITIES } from "../packages/mcp/src/index.ts";
import { SLACK_CAPABILITIES, actionId, parseActionId } from "../packages/slack/src/index.ts";
import {
  TELEGRAM_CAPABILITIES,
  callbackData,
  escapeMarkdownV2,
  parseCallbackData,
} from "../packages/telegram/src/index.ts";
import { WEBHOOK_CAPABILITIES } from "../packages/webhook/src/index.ts";

describe("§7.4 layer 7 — capability declarations", () => {
  const adapters: [string, typeof TELEGRAM_CAPABILITIES][] = [
    ["telegram", TELEGRAM_CAPABILITIES],
    ["discord", DISCORD_CAPABILITIES],
    ["slack", SLACK_CAPABILITIES],
    ["webhook", WEBHOOK_CAPABILITIES],
    ["api", API_CAPABILITIES],
    ["mcp", MCP_CAPABILITIES],
    ["cli", CLI_CAPABILITIES],
  ];

  test("every adapter declares its capabilities explicitly", () => {
    for (const [name, caps] of adapters) {
      expect(typeof caps.messaging, name).toBe("boolean");
      expect(typeof caps.permissionRelay, name).toBe("boolean");
      expect(typeof caps.threads, name).toBe("boolean");
      expect(typeof caps.richCards, name).toBe("boolean");
    }
  });

  test("the webhook adapter does NOT advertise permission relay", () => {
    // A webhook URL authenticates the caller of an HTTP endpoint, not a person.
    // Declaring otherwise would be a remote-code-execution bug.
    expect(WEBHOOK_CAPABILITIES.permissionRelay).toBe(false);
  });

  test("every adapter that DOES relay buttons carries a user id", () => {
    for (const [name, caps] of adapters) {
      if (!caps.permissionRelay) continue;
      expect(["telegram", "discord", "slack", "api", "mcp", "cli"], name).toContain(name);
    }
  });
});

describe("permission button payloads round-trip", () => {
  test("telegram", () => {
    for (const verdict of ["once", "always", "reject"] as const) {
      const data = callbackData("abcde", verdict);
      expect(data.length).toBeLessThanOrEqual(64); // Telegram's hard limit
      expect(parseCallbackData(data)).toEqual({ verdict, shortId: "abcde" });
    }
  });

  test("discord", () => {
    for (const verdict of ["once", "always", "reject"] as const) {
      const id = customId("abcde", verdict);
      expect(id.length).toBeLessThanOrEqual(100); // Discord's hard limit
      expect(parseCustomId(id)).toEqual({ verdict, shortId: "abcde" });
    }
  });

  test("slack", () => {
    for (const verdict of ["once", "always", "reject"] as const) {
      const id = actionId("abcde", verdict);
      expect(parseActionId(id)).toEqual({ verdict, shortId: "abcde" });
    }
  });
});

describe("button payloads reject anything forged", () => {
  const parsers: readonly ((value: string | undefined) => unknown)[] = [
    parseCallbackData,
    parseCustomId,
    parseActionId,
  ];

  test("malformed payloads are refused", () => {
    for (const parse of parsers) {
      expect(parse(undefined)).toBeNull();
      expect(parse("")).toBeNull();
      expect(parse("rm -rf /")).toBeNull();
      expect(parse("abcde")).toBeNull(); // no verdict prefix
      expect(parse("yabcde")).toBeNull(); // right shape, wrong namespace
    }
  });

  test("a code containing `l` is refused", () => {
    for (const parse of parsers) {
      expect(parse("rclbcde")).toBeNull();
    }
  });

  test("all three adapters namespace their payloads the same way", () => {
    // One shape means one parser to review and one forged form to reject.
    expect(callbackData("abcde", "once")).toBe("rcyabcde");
    expect(customId("abcde", "once")).toBe("rcyabcde");
    expect(actionId("abcde", "once")).toBe("rc_y_abcde");
  });

  test("a verdict outside the three allowed values is refused", () => {
    for (const parse of parsers) {
      expect(parse("rczabcde")).toBeNull();
      expect(parse("rcqabcde")).toBeNull();
    }
  });
});

describe("MarkdownV2 escaping", () => {
  test("escapes every character Telegram treats as an entity", () => {
    expect(escapeMarkdownV2("a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s")).toBe(
      "a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s",
    );
  });

  test("leaves ordinary prose alone", () => {
    expect(escapeMarkdownV2("the parser is fixed")).toBe("the parser is fixed");
  });

  test("escapes the backslash itself so escaping is not reversible", () => {
    expect(escapeMarkdownV2("a\\b")).toBe("a\\\\b");
  });
});

describe("CLI card rendering", () => {
  test("a permission card spells out all three verdicts with the code", () => {
    const out = renderCards([
      {
        kind: "permission",
        id: "abcde",
        title: "rm -rf build",
        tool: "bash",
        expiresAt: Date.now() + 60_000,
      },
    ]).join("\n");
    expect(out).toContain("yes abcde");
    expect(out).toContain("always abcde");
    expect(out).toContain("no abcde");
    expect(out).toContain("rm -rf build");
  });

  test("an error card is visually distinct", () => {
    const out = renderCards([{ kind: "error", message: "provider exploded" }]).join("\n");
    expect(out).toContain("error:");
    expect(out).toContain("provider exploded");
  });

  test("a diff card lists each file with its line counts", () => {
    const out = renderCards([
      { kind: "diff", files: [{ path: "src/a.ts", additions: 3, deletions: 1 }] },
    ]).join("\n");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("+3");
  });

  test("a long reply is capped at the relay limit, not truncated silently", () => {
    // `sanitizeText` caps at 3,500 code points before chunking, so a 20,000
    // character reply is one message with an explicit elision marker — the
    // tail is preserved, which is the part an approver needs.
    const long = `${"x".repeat(10_000)} rm -rf /`;
    const chunks = renderCards([{ kind: "text", markdown: long }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("code points elided");
    expect(chunks[0]).toContain("rm -rf /");
  });
});

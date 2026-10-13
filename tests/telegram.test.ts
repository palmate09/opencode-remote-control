/**
 * Telegram adapter transport tests.
 *
 * These run against a **fake Bot API server** served over real HTTP on
 * loopback. That is the point: the adapter's HTTP shape, its MarkdownV2
 * escaping, its long-poll offset arithmetic and its 64-byte callback-data limit
 * are exactly the things a unit test on pure functions cannot check, and they
 * are exactly the things that break when Telegram changes something.
 *
 * No token and no network egress. `apiBase` points at the local server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

import type {
  AdapterContext,
  BridgeHandle,
  Card,
  ConversationRef,
  InboundMessage,
  PermissionVerdict,
} from "../packages/core/src/types.ts";
import { TelegramAdapter, escapeMarkdownV2 } from "../packages/telegram/src/index.ts";

interface Call {
  method: string;
  body: Record<string, unknown>;
}

let server: Server;
let calls: Call[] = [];
let port = 0;
/**
 * Batches returned by the *bootstrap* poll (timeout 0). The adapter starts at
 * offset 0 and then jumps past whatever it saw, so a cold start deliberately
 * does not replay a backlog. Tests seed this separately from the batches they
 * actually want delivered.
 */
let bootstrapBatch: unknown[] = [];
/** Batches returned by the running poll loop, consumed in order. */
let updateBatches: unknown[][] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const method = url.pathname.split("/").pop() ?? "";
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method, body });

      const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));

      switch (method) {
        case "getMe":
          return ok({ id: 777, username: "rc_test_bot" });
        case "getUpdates": {
          const timeout = Number(body.timeout ?? 0);
          if (timeout === 0) return ok(bootstrapBatch);
          const offset = Number(body.offset ?? 0);
          const batch = updateBatches.shift() ?? [];
          // Respect the offset the adapter computed, like the real API does.
          const fresh = (batch as { update_id: number }[]).filter((u) => u.update_id >= offset);
          return ok(fresh);
        }
        case "sendMessage":
        case "editMessageText":
          return ok({ message_id: 1, chat: { id: body.chat_id }, text: body.text });
        case "sendDocument":
          // The body is multipart, so `req.json()` above yielded {} — the
          // method name from the path is what the test asserts on.
          return ok({ message_id: 2, chat: { id: 555 } });
        case "answerCallbackQuery":
          return ok(true);
        default:
          return new Response(JSON.stringify({ ok: false, description: "unknown method" }), {
            status: 404,
          });
      }
    },
  });
  port = server.port;
});

afterAll(() => {
  server?.stop(true);
});

afterEach(() => {
  calls = [];
  updateBatches = [];
  bootstrapBatch = [];
});

function adapter(): TelegramAdapter {
  return new TelegramAdapter({
    token: "test-token",
    apiBase: `http://127.0.0.1:${port}`,
    pollIntervalMs: 5,
  });
}

/** A context that records what the adapter sends to the bridge. */
function makeContext(sink: { sent: InboundMessage[]; answered: [string, PermissionVerdict][] }) {
  const bridge: BridgeHandle = {
    handle: async (m) => {
      sink.sent.push(m);
    },
    prompt: async () => "ses_1",
    newSession: async () => "ses_2",
    abort: async () => {},
    deliver: async () => {},
    answerPermission: async (_c: ConversationRef, shortId: string, verdict: PermissionVerdict) => {
      sink.answered.push([shortId, verdict]);
      return true;
    },
    sendFile: async () => true,
  };
  const ctx = {
    config: {} as AdapterContext["config"],
    logger: {
      ns: "t",
      error() {},
      warn() {},
      info() {},
      debug() {},
      trace() {},
      child: () => makeContext(sink).logger,
      audit: () => ({}) as never,
      auditLog: {} as never,
      close() {},
    },
    audit: { append: () => ({}) as never } as never,
    sessions: {} as never,
    permissions: {} as never,
    bridge,
    hub: {} as never,
    outbox: {} as never,
  } as unknown as AdapterContext;
  return ctx;
}

const sink = { sent: [] as InboundMessage[], answered: [] as [string, PermissionVerdict][] };
beforeEach(() => {
  sink.sent = [];
  sink.answered = [];
});

function findCall(method: string): Call | undefined {
  return calls.find((c) => c.method === method);
}

describe("Bot API transport", () => {
  test("polling resumes from the newest update, not from zero", async () => {
    // A cold start at offset 0 would replay an hour of backlog at the user.
    const a = adapter();
    bootstrapBatch = [
      {
        update_id: 900,
        message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: { id: 1 },
          text: "x",
          date: 1,
        },
      },
    ];
    await a.start(makeContext(sink));
    await new Promise((r) => setTimeout(r, 60));

    // The bootstrap poll used timeout 0; a later poll must use offset 901.
    const realPoll = calls.filter((c) => c.method === "getUpdates" && Number(c.body.timeout) > 0);
    expect(realPoll.length).toBeGreaterThan(0);
    expect(Number(realPoll[0]!.body.offset)).toBe(901);
    await a.stop();
  });

  test("authenticates with the token in the URL path, as the Bot API requires", async () => {
    const a = adapter();
    await a.identify();
    expect(findCall("getMe")).toBeDefined();
    await a.stop();
  });

  test("resolves the bot's own id and username so echoes can be ignored", async () => {
    const a = adapter();
    const me = await a.identify();
    expect(me).toEqual({ id: 777, username: "rc_test_bot" });
    await a.stop();
  });
});

describe("inbound messages", () => {
  test("translates a DM into an InboundMessage", async () => {
    const a = adapter();
    updateBatches = [
      [
        {
          update_id: 1,
          message: {
            message_id: 10,
            chat: { id: 555, type: "private" },
            from: { id: 42, first_name: "Ada", username: "ada" },
            text: "fix the parser",
            date: 1700000000,
          },
        },
      ],
    ];
    await a.start(makeContext(sink));
    await new Promise((r) => setTimeout(r, 80));

    expect(sink.sent).toHaveLength(1);
    const m = sink.sent[0]!;
    expect(m.platform).toBe("telegram");
    expect(m.actor.id).toBe("42");
    expect(m.actor.displayName).toBe("Ada");
    expect(m.chat.chatId).toBe("555");
    expect(m.text).toBe("fix the parser");
    expect(m.isGroup).toBe(false);
    expect(m.timestamp).toBe(1700000000000);
    await a.stop();
  });

  test("marks group chats as groups so the group gate applies", async () => {
    const a = adapter();
    updateBatches = [
      [
        {
          update_id: 2,
          message: {
            message_id: 11,
            chat: { id: -100999, type: "supergroup" },
            from: { id: 43, first_name: "B" },
            text: "@rc_test_bot hello",
            date: 1700000000,
          },
        },
      ],
    ];
    await a.start(makeContext(sink));
    await new Promise((r) => setTimeout(r, 80));

    expect(sink.sent[0]!.isGroup).toBe(true);
    expect(sink.sent[0]!.mentionsBot).toBe(true);
    // The @mention is addressing, not content.
    expect(sink.sent[0]!.text).toBe("hello");
    await a.stop();
  });

  test("an unmentioned group message still arrives, with mentionsBot false", async () => {
    // The gate decides whether to drop it. The adapter's job is to report
    // accurately, not to enforce.
    const a = adapter();
    updateBatches = [
      [
        {
          update_id: 3,
          message: {
            message_id: 12,
            chat: { id: -100999, type: "supergroup" },
            from: { id: 44 },
            text: "chatter without a mention",
            date: 1,
          },
        },
      ],
    ];
    await a.start(makeContext(sink));
    await new Promise((r) => setTimeout(r, 80));
    expect(sink.sent[0]!.mentionsBot).toBe(false);
    await a.stop();
  });

  test("ignores bot-authored messages and its own echoes", async () => {
    const a = adapter();
    updateBatches = [
      [
        {
          update_id: 4,
          message: {
            message_id: 1,
            chat: { id: 1, type: "private" },
            from: { id: 5, is_bot: true },
            text: "bot",
            date: 1,
          },
        },
        {
          update_id: 5,
          message: {
            message_id: 2,
            chat: { id: 1, type: "private" },
            from: { id: 777 },
            text: "own echo",
            date: 1,
          },
        },
        {
          update_id: 6,
          message: {
            message_id: 3,
            chat: { id: 1, type: "private" },
            from: { id: 6 },
            text: "",
            date: 1,
          },
        },
      ],
    ];
    await a.start(makeContext(sink));
    await new Promise((r) => setTimeout(r, 80));
    expect(sink.sent).toHaveLength(0);
    await a.stop();
  });
});

describe("permission buttons", () => {
  test("renders three buttons whose callback_data fits Telegram's 64-byte cap", async () => {
    const a = adapter();
    await a.start(makeContext(sink));
    await a.send({
      conversation: { platform: "telegram", chatId: "555" },
      cards: [
        {
          kind: "permission",
          id: "abcde",
          tool: "bash",
          title: "rm -rf build",
          expiresAt: Date.now() + 600_000,
        },
      ],
    });

    const sent = findCall("sendMessage");
    expect(sent).toBeDefined();
    const markup = sent!.body.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const row = markup.inline_keyboard[0]!;
    expect(row).toHaveLength(3);
    expect(row.map((b) => b.text)).toEqual(["✅ Approve once", "♾️ Always", "⛔️ Deny"]);
    for (const button of row) {
      expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
    // Every button carries the same short id, so a tap cannot name another
    // request by accident.
    for (const button of row) {
      expect(button.callback_data.endsWith("abcde")).toBe(true);
    }
    await a.stop();
  });

  test("a tap is acknowledged and relayed to the bridge", async () => {
    const a = adapter();
    updateBatches = [
      [
        {
          update_id: 10,
          callback_query: {
            id: "cq_1",
            from: { id: 42, first_name: "Ada" },
            message: { message_id: 9, chat: { id: 555, type: "private" } },
            data: "rcyabcde",
          },
        },
      ],
    ];
    await a.start(makeContext(sink));
    await new Promise((r) => setTimeout(r, 80));

    // Acked inside the interaction window.
    expect(findCall("answerCallbackQuery")).toBeDefined();
    expect(sink.answered).toEqual([["abcde", "once"]]);
    // And the card is edited so the chat records the outcome.
    expect(findCall("editMessageText")).toBeDefined();
    await a.stop();
  });

  test("each verdict maps to a distinct button", async () => {
    const a = adapter();
    updateBatches = [
      [
        {
          update_id: 11,
          callback_query: {
            id: "cq_2",
            from: { id: 42 },
            message: { message_id: 9, chat: { id: 555, type: "private" } },
            data: "rcaabcde",
          },
        },
      ],
    ];
    await a.start(makeContext(sink));
    await new Promise((r) => setTimeout(r, 80));
    expect(sink.answered).toEqual([["abcde", "always"]]);
    await a.stop();
  });

  test("a forged callback is ignored rather than reaching the bridge", async () => {
    const a = adapter();
    updateBatches = [
      [
        {
          update_id: 12,
          callback_query: {
            id: "cq_3",
            from: { id: 42 },
            message: { message_id: 9, chat: { id: 555, type: "private" } },
            data: "rczabcde",
          },
        },
      ],
    ];
    await a.start(makeContext(sink));
    await new Promise((r) => setTimeout(r, 80));
    expect(sink.answered).toHaveLength(0);
    await a.stop();
  });
});

describe("outbound rendering", () => {
  test("escapes MarkdownV2 so Telegram does not silently drop the message", async () => {
    const a = adapter();
    await a.start(makeContext(sink));
    await a.send({
      conversation: { platform: "telegram", chatId: "555" },
      cards: [{ kind: "text", markdown: "a_b*c[d]e" }],
    });
    const sent = findCall("sendMessage")!;
    expect(sent.body.parse_mode).toBe("MarkdownV2");
    expect(sent.body.text).toBe("a\\_b\\*c\\[d\\]e");
    await a.stop();
  });

  test("a long reply is capped at 3,500 code points, inside Telegram's limit", async () => {
    // §10.2: the relay cap (3,500) is deliberately lower than Telegram's
    // message limit (4,096), so a single Card can never exceed the limit and
    // `chunkText` is a belt-and-braces second pass rather than the primary
    // mechanism. Head and tail both survive.
    const a = adapter();
    await a.start(makeContext(sink));
    const long = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    await a.send({
      conversation: { platform: "telegram", chatId: "555" },
      cards: [{ kind: "text", markdown: long }],
    });
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    const text = String(sent[0]!.body.text);
    expect(text.length).toBeLessThanOrEqual(4096);
    // The elision marker is explicit, and the tail — the dangerous half of a
    // command — is preserved.
    expect(text).toContain("code points elided");
    expect(text).toContain("line 599");
  });

  test("multiple cards become multiple messages", async () => {
    const a = adapter();
    await a.start(makeContext(sink));
    await a.send({
      conversation: { platform: "telegram", chatId: "555" },
      cards: [
        { kind: "text", markdown: "first" },
        { kind: "notice", text: "second" },
      ],
    });
    expect(calls.filter((c) => c.method === "sendMessage").length).toBe(2);
    await a.stop();
  });

  test("renders a diff as a file list", async () => {
    const a = adapter();
    await a.start(makeContext(sink));
    await a.send({
      conversation: { platform: "telegram", chatId: "555" },
      cards: [{ kind: "diff", files: [{ path: "src/a.ts", additions: 3, deletions: 1 }] }],
    });
    // The path is MarkdownV2-escaped, which is correct: Telegram would drop the
    // whole message on an unbalanced entity.
    const text = String(findCall("sendMessage")!.body.text);
    expect(text).toContain("src/a\\.ts");
    expect(text).toContain("\\+3");
    expect(text).toContain("−1");
    await a.stop();
  });

  test("an unparseable chat id is a no-op rather than a thrown error", async () => {
    const a = adapter();
    await a.start(makeContext(sink));
    await a.send({
      conversation: { platform: "telegram", chatId: "not-a-number" },
      cards: [{ kind: "text", markdown: "hello" }],
    });
    expect(findCall("sendMessage")).toBeUndefined();
    await a.stop();
  });
});

describe("file upload (§7.4 layer 6)", () => {
  test("an approved path is uploaded as sendDocument", async () => {
    // The bridge runs the exfiltration guard; the adapter only has to make the
    // multipart request. This test covers the adapter half.
    const a = adapter();
    await a.start(makeContext(sink));

    const path = join(tmpdir(), `rc-upload-${Date.now()}.txt`);
    writeFileSync(path, "report contents");

    await a.sendFile({ platform: "telegram", chatId: "555" }, { path, name: "report.txt" });

    const sent = findCall("sendDocument");
    expect(sent).toBeDefined();
    expect(sent!.method).toBe("sendDocument");

    unlinkSync(path);
    await a.stop();
  });

  test("an unparseable chat id is a no-op, like send()", async () => {
    const a = adapter();
    await a.start(makeContext(sink));
    const path = join(tmpdir(), `rc-upload-${Date.now()}.txt`);
    writeFileSync(path, "x");

    await a.sendFile({ platform: "telegram", chatId: "not-a-number" }, { path, name: "x.txt" });
    expect(findCall("sendDocument")).toBeUndefined();

    unlinkSync(path);
    await a.stop();
  });

  test("a rejected upload throws, so the bridge can report the failure", async () => {
    const a = adapter();
    await a.start(makeContext(sink));
    await expect(
      a.sendFile(
        { platform: "telegram", chatId: "555" },
        {
          path: "/nonexistent/definitely-missing-xyz",
          name: "gone.txt",
        },
      ),
    ).rejects.toThrow();
    await a.stop();
  });
});

describe("MarkdownV2 escaping", () => {
  test("covers every character Telegram treats as an entity", () => {
    expect(escapeMarkdownV2("_")).toBe("\\_");
    expect(escapeMarkdownV2("*")).toBe("\\*");
    expect(escapeMarkdownV2("[")).toBe("\\[");
    expect(escapeMarkdownV2("]")).toBe("\\]");
    expect(escapeMarkdownV2("(")).toBe("\\(");
    expect(escapeMarkdownV2(")")).toBe("\\)");
    expect(escapeMarkdownV2("~")).toBe("\\~");
    expect(escapeMarkdownV2("`")).toBe("\\`");
    expect(escapeMarkdownV2(">")).toBe("\\>");
    expect(escapeMarkdownV2("#")).toBe("\\#");
    expect(escapeMarkdownV2("+")).toBe("\\+");
    expect(escapeMarkdownV2("-")).toBe("\\-");
    expect(escapeMarkdownV2("=")).toBe("\\=");
    expect(escapeMarkdownV2("|")).toBe("\\|");
    expect(escapeMarkdownV2("{")).toBe("\\{");
    expect(escapeMarkdownV2("}")).toBe("\\}");
    expect(escapeMarkdownV2(".")).toBe("\\.");
    expect(escapeMarkdownV2("!")).toBe("\\!");
  });

  test("leaves a plain sentence untouched", () => {
    expect(escapeMarkdownV2("the parser is fixed")).toBe("the parser is fixed");
  });
});

describe("Card coverage", () => {
  test("every Card kind renders without throwing", async () => {
    const a = adapter();
    await a.start(makeContext(sink));
    const cards: Card[] = [
      { kind: "text", markdown: "text" },
      { kind: "status", label: "editing src/a.ts…" },
      { kind: "notice", text: "queued" },
      { kind: "error", message: "provider exploded" },
      { kind: "diff", files: [{ path: "a.ts", additions: 1, deletions: 0 }] },
      { kind: "permission", id: "abcde", tool: "bash", title: "t", expiresAt: Date.now() + 60_000 },
    ];
    for (const card of cards) {
      await a.send({ conversation: { platform: "telegram", chatId: "555" }, cards: [card] });
    }
    expect(calls.filter((c) => c.method === "sendMessage").length).toBeGreaterThanOrEqual(
      cards.length,
    );
    await a.stop();
  });
});

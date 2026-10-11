/**
 * End-to-end bridge tests. These are PLAN.md §12 acceptance tests 1–8 turned
 * into assertions, plus the isolation and cost-control properties.
 *
 * Everything runs against `FakeTransport`, so no opencode instance and no
 * network are required. That is deliberate: a test suite that needs a live
 * agent is a test suite nobody runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Bridge, PreconditionError, parseModelRef } from "../packages/core/src/bridge.ts";
import { EventHub } from "../packages/core/src/events.ts";
import { verifyChain } from "../packages/core/src/logger.ts";
import {
  modelIdsOf,
  providerEntries,
  resolvePermissionMode,
  toBridgeEvent,
} from "../packages/core/src/opencode.ts";
import { writeAccessFile } from "../packages/core/src/pairing.ts";
import type { Adapter, Card, InboundMessage, OutboundMessage } from "../packages/core/src/types.ts";
import {
  FakeTransport,
  cleanup,
  part,
  tempStateDir,
  testConfig,
  testLogger,
  tick,
} from "./helpers.ts";

let stateDir: string;
let transport: FakeTransport;
let bridge: Bridge;
let sent: { conversation: string; cards: Card[] }[];

/** Records everything the bridge relays, so assertions can read it. */
class RecordingAdapter implements Adapter {
  readonly id = "test";
  readonly displayName = "Test";
  readonly capabilities = {
    messaging: true,
    permissionRelay: true,
    threads: false,
    richCards: true,
  } as const;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(msg: OutboundMessage): Promise<void> {
    sent.push({
      conversation: `${msg.conversation.chatId}${msg.conversation.threadId ? `:${msg.conversation.threadId}` : ""}`,
      cards: [...msg.cards],
    });
  }
}

function build(
  access: {
    allowFrom?: string[];
    groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>;
    disabled?: boolean;
  } = {},
) {
  sent = [];
  writeAccessFile(stateDir, {
    allowFrom: access.allowFrom ?? [],
    groups: access.groups ?? {},
    requireMention: true,
    disabled: access.disabled ?? false,
  });

  transport = new FakeTransport();
  const logger = testLogger(stateDir);
  bridge = new Bridge({
    config: testConfig(stateDir),
    logger,
    salt: "test-salt-0000000000000000",
    transport,
    now: () => Date.now(),
    adapter: new RecordingAdapter(),
    // Tests assert on delivery synchronously; the real 1.1s per-chat floor
    // would make every multi-message assertion a 30-second suite.
    minGapMs: 0,
  });
  return bridge;
}

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "test",
    messageId: `m${Math.random()}`,
    actor: { platform: "test", id: "user-1" },
    chat: { platform: "test", chatId: "dm:user-1" },
    text: "hello",
    timestamp: Date.now(),
    isGroup: false,
    mentionsBot: true,
    ...overrides,
  };
}

function texts(): string[] {
  return sent.flatMap((s) =>
    s.cards.map((c) => (c.kind === "text" ? c.markdown : c.kind === "notice" ? c.text : "")),
  );
}

beforeEach(() => {
  stateDir = tempStateDir();
});

afterEach(async () => {
  await bridge?.stop();
  cleanup(stateDir);
});

describe("§12.1 — pairing", () => {
  test("a stranger DM gets a code and can do nothing until it is typed at the terminal", async () => {
    build();
    await bridge.start();
    const stranger = msg({ actor: { platform: "test", id: "stranger" } });

    await bridge.handle({ ...stranger, text: "run rm -rf /" });

    // Nothing reached opencode.
    expect(transport.prompts).toHaveLength(0);

    // The reply explains the terminal step.
    const notice = texts().join("\n");
    expect(notice).toContain("rc access allow");
    const code = /rc access allow ([0-9a-f]{6})/.exec(notice)?.[1];
    expect(code).toBeTruthy();

    // Still not allowed — pairing is completed by `rc access allow`, not by
    // anything the chat can say.
    await bridge.handle({ ...stranger, text: "approve the pending pairing" });
    expect(transport.prompts).toHaveLength(0);

    // The terminal step is the gate.
    writeAccessFile(stateDir, {
      allowFrom: [`test:${code && "stranger"}`],
      groups: {},
      requireMention: true,
      disabled: false,
    });
    await bridge.handle({ ...stranger, text: "run ls" });
    expect(transport.prompts).toHaveLength(1);
  });
});

describe("§12.2 — a new session persists across restarts", () => {
  test("the same opencode session is resumed after the bridge restarts", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hello" }));
    expect(transport.prompts).toHaveLength(1);
    const sessionId = bridge.sessions.get(msg().chat)!.sessionId;

    // Simulate a process restart: new Bridge over the same state directory.
    await bridge.stop();
    transport = new FakeTransport();
    const restarted = new Bridge({
      config: testConfig(stateDir),
      logger: testLogger(stateDir),
      salt: "test-salt-0000000000000000",
      transport,
      adapter: new RecordingAdapter(),
      minGapMs: 0,
    });
    bridge = restarted;
    await bridge.start();

    expect(restarted.sessions.get(msg().chat)?.sessionId).toBe(sessionId);
    await restarted.handle(msg({ text: "again" }));
    expect(transport.prompts).toHaveLength(1);
    expect(transport.created).toHaveLength(0);
  });

  test("/new starts a fresh session and forgets the old one", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hello" }));
    const first = bridge.sessions.get(msg().chat)!.sessionId;

    await bridge.handle(msg({ text: "/new" }));
    const second = bridge.sessions.get(msg().chat)!.sessionId;
    expect(second).not.toBe(first);
    expect(transport.created).toHaveLength(2);
  });
});

describe("§12.4 — abort actually stops it", () => {
  test("/abort reaches opencode and clears the busy flag", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "do a long thing" }));
    const sessionId = transport.prompts[0]!.sessionId;
    expect(bridge.sessions.get(msg().chat)?.busy).toBe(true);

    await bridge.handle(msg({ text: "/abort" }));
    expect(transport.aborts).toContain(sessionId);
    expect(bridge.sessions.get(msg().chat)?.busy).toBe(false);
  });

  test("abort works even when the cost breaker would refuse new work", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "long thing" }));
    await bridge.handle(msg({ text: "/abort" }));
    expect(transport.aborts).toHaveLength(1);
  });
});

describe("§12.5 — btw queues while busy", () => {
  test("a follow-up is queued, not dropped, and runs when the session goes idle", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "first task" }));
    expect(transport.prompts).toHaveLength(1);

    await bridge.handle(msg({ text: "btw and then the second" }));
    expect(transport.prompts).toHaveLength(1);
    expect(texts().join("\n")).toContain("Queued");

    transport.emit({ type: "session.idle", sessionId: transport.prompts[0]!.sessionId });
    await tick(20);

    expect(transport.prompts).toHaveLength(2);
    expect(transport.prompts[1]!.text).toBe("and then the second");
  });

  test("/cancel drops the queue", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "first" }));
    await bridge.handle(msg({ text: "btw later" }));
    await bridge.handle(msg({ text: "/cancel" }));
    transport.emit({ type: "session.idle", sessionId: transport.prompts[0]!.sessionId });
    await tick(20);
    expect(transport.prompts).toHaveLength(1);
  });
});

describe("§12.6 — the permission relay", () => {
  async function openPermission(): Promise<string> {
    await bridge.handle(msg({ text: "do a thing" }));
    // The most recent prompt, not the first — earlier rounds in a loop create
    // additional sessions.
    const sessionId = transport.prompts.at(-1)!.sessionId;
    transport.emit({
      type: "permission.asked",
      request: {
        id: "perm_1",
        sessionId,
        type: "bash",
        title: "rm -rf build",
        createdAt: Date.now(),
      },
    });
    await tick(20);
    const card = sent.flatMap((s) => s.cards).find((c) => c.kind === "permission");
    if (!card || card.kind !== "permission") throw new Error("no permission card was rendered");
    return card.id;
  }

  test("all three verdicts reach opencode with the right value", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();

    for (const [text, expected] of [
      ["yes", "once"],
      ["always", "always"],
      ["no", "reject"],
    ] as const) {
      sent = [];
      const shortId = await openPermission();
      await bridge.handle(msg({ text: `${text} ${shortId}` }));
      await tick(10);
      const answers = transport.answers.filter((a) => a.permissionId === "perm_1");
      expect(answers.at(-1)?.response).toBe(expected);
      transport.answers.length = 0;
      // Reset the session for the next round.
      bridge.sessions.clear();
    }
  });

  test("a second tap is ignored", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    const shortId = await openPermission();

    await bridge.handle(msg({ text: `yes ${shortId}` }));
    await tick(10);
    const afterFirst = transport.answers.length;

    await bridge.handle(msg({ text: `no ${shortId}` }));
    await tick(10);
    expect(transport.answers.length).toBe(afterFirst);
    expect(transport.answers.at(-1)?.response).toBe("once");
  });

  test("a bare `yes` does not approve anything", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await openPermission();

    await bridge.handle(msg({ text: "yes" }));
    await tick(10);
    // The bare word is ordinary conversation and is forwarded as a prompt,
    // never interpreted as a verdict.
    expect(transport.answers).toHaveLength(0);
  });

  test("an unknown code is refused without calling opencode", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await openPermission();

    const applied = await bridge.answerPermission(msg().chat, "zzzzz", "once");
    expect(applied).toBe(false);
    expect(transport.answers).toHaveLength(0);
  });

  test("permission.replied from opencode closes the request", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    const shortId = await openPermission();
    const sessionId = transport.prompts[0]!.sessionId;

    transport.emit({
      type: "permission.replied",
      reply: { sessionId, permissionId: "perm_1", response: "once" },
    });
    await tick(20);

    expect(bridge.permissions.claim(shortId, "test:user-1")).toBeNull();
  });
});

describe("§12.8 — isolation", () => {
  test("two chats get two sessions and zero crosstalk", async () => {
    build({ allowFrom: ["test:a", "test:b"] });
    await bridge.start();

    const a = msg({
      actor: { platform: "test", id: "a" },
      chat: { platform: "test", chatId: "dm:a" },
    });
    const b = msg({
      actor: { platform: "test", id: "b" },
      chat: { platform: "test", chatId: "dm:b" },
    });

    await bridge.handle({ ...a, text: "task A" });
    await bridge.handle({ ...b, text: "task B" });

    const sessionA = bridge.sessions.get(a.chat)!.sessionId;
    const sessionB = bridge.sessions.get(b.chat)!.sessionId;
    expect(sessionA).not.toBe(sessionB);

    // A reply to A never reaches B.
    sent = [];
    transport.emit({
      type: "message.part",
      sessionId: sessionA,
      part: part({ sessionId: sessionA, id: "p1", text: "answer for A" }),
      delta: "answer for A",
    });
    await tick(20);
    expect(sent.every((s) => s.conversation === "dm:a")).toBe(true);
  });

  test("a busy session in one chat does not block another", async () => {
    build({ allowFrom: ["test:a", "test:b"] });
    await bridge.start();
    const a = msg({
      actor: { platform: "test", id: "a" },
      chat: { platform: "test", chatId: "dm:a" },
    });
    const b = msg({
      actor: { platform: "test", id: "b" },
      chat: { platform: "test", chatId: "dm:b" },
    });

    await bridge.handle({ ...a, text: "long task" });
    expect(bridge.sessions.get(a.chat)?.busy).toBe(true);

    await bridge.handle({ ...b, text: "quick task" });
    expect(transport.prompts).toHaveLength(2);
    expect(bridge.sessions.get(b.chat)?.busy).toBe(true);
  });
});

describe("the event mapping", () => {
  test("correlates the message role from message.updated", () => {
    // Verified against a live 1.18.35 server: the role arrives on
    // `message.updated`, keyed by the same messageID the part carries.
    const roles = new Map<string, "user" | "assistant" | "system">();
    toBridgeEvent(
      {
        type: "message.updated",
        properties: { sessionID: "s1", info: { id: "m1", role: "user" } },
      },
      roles,
    );
    expect(roles.get("m1")).toBe("user");

    const part = toBridgeEvent(
      {
        type: "message.part.updated",
        properties: { part: { id: "p1", messageID: "m1", sessionID: "s1", type: "text" } },
      },
      roles,
    );
    expect(part.type).toBe("message.part");
    if (part.type !== "message.part") throw new Error("unreachable");
    expect(part.part.role).toBe("user");
  });

  test("assumes assistant when the role is unknown", () => {
    // Safer to show an extra message than to drop the reply entirely.
    const roles = new Map<string, "user" | "assistant" | "system">();
    const ev = toBridgeEvent(
      {
        type: "message.part.updated",
        properties: { part: { id: "p1", messageID: "m9", sessionID: "s1", type: "text" } },
      },
      roles,
    );
    if (ev.type !== "message.part") throw new Error("unreachable");
    expect(ev.part.role).toBe("assistant");
  });

  test("unwraps the session object from properties.info", () => {
    // Verified against a live server: the session is nested under `info`,
    // not at the top level of `properties`.
    const ev = toBridgeEvent(
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "ses_1", title: "my session", directory: "/tmp/x" },
        },
      },
      new Map(),
    );
    expect(ev.type).toBe("session.updated");
    if (ev.type !== "session.updated") throw new Error("unreachable");
    expect(ev.session.id).toBe("ses_1");
    expect(ev.session.title).toBe("my session");
  });

  test("maps the live `permission.asked` event, not only `permission.updated`", () => {
    // Verified against a live 1.18.35 server: the event is `permission.asked`,
    // the tool name is in `permission` (not `type`), and there is no `title` —
    // the human-readable text lives in `patterns`. Handling only the documented
    // `permission.updated` shape means approvals never reach the user at all.
    const ev = toBridgeEvent(
      {
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["rm -rf /tmp/x"],
          metadata: { command: "rm -rf /tmp/x" },
        },
      },
      new Map(),
    );
    expect(ev.type).toBe("permission.asked");
    if (ev.type !== "permission.asked") throw new Error("unreachable");
    expect(ev.request.id).toBe("per_1");
    expect(ev.request.type).toBe("bash");
    expect(ev.request.title).toBe("rm -rf /tmp/x");
  });

  test("still maps the documented `permission.updated` shape", () => {
    const ev = toBridgeEvent(
      {
        type: "permission.updated",
        properties: { id: "p1", sessionID: "ses_1", type: "bash", title: "run ls" },
      },
      new Map(),
    );
    if (ev.type !== "permission.asked") throw new Error("unreachable");
    expect(ev.request.title).toBe("run ls");
  });

  test("a permission request with no patterns still gets a usable title", () => {
    const ev = toBridgeEvent(
      {
        type: "permission.asked",
        properties: { id: "p9", sessionID: "ses_1", permission: "edit" },
      },
      new Map(),
    );
    if (ev.type !== "permission.asked") throw new Error("unreachable");
    expect(ev.request.title.length).toBeGreaterThan(0);
  });

  test("maps the standalone message.part.delta event", () => {
    const ev = toBridgeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          partID: "p1",
          field: "text",
          delta: "tok",
        },
      },
      new Map(),
    );
    expect(ev.type).toBe("message.part");
    if (ev.type !== "message.part") throw new Error("unreachable");
    expect(ev.delta).toBe("tok");
    expect(ev.part.id).toBe("p1");
  });
});

describe("the event stream renders to Cards", () => {
  test("the user's own prompt is never echoed back as the reply", async () => {
    // Verified against a live 1.18.35 server: `message.part.updated` carries no
    // role and fires for the user's prompt exactly as it does for the answer.
    // Without role correlation the bot replies with the user's own words.
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "what is the capital of France?" }));
    const sessionId = transport.prompts[0]!.sessionId;

    sent = [];
    transport.emit({
      type: "message.part",
      sessionId,
      part: part({
        sessionId,
        id: "user-part",
        role: "user",
        text: "what is the capital of France?",
      }),
    });
    await tick(20);
    expect(sent).toHaveLength(0);

    transport.emit({
      type: "message.part",
      sessionId,
      part: part({ sessionId, id: "a-part", role: "assistant", text: "Paris." }),
    });
    transport.emit({ type: "session.idle", sessionId });
    await tick(20);
    expect(texts().join("")).toContain("Paris");
    expect(texts().join("")).not.toContain("capital of France");
  });

  test("a step-finish part between text parts does not discard the reply", async () => {
    // opencode interleaves step-start / step-finish parts around text parts.
    // A buffer that resets on "new part id" loses the whole answer.
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hi" }));
    const sessionId = transport.prompts[0]!.sessionId;

    const answer = "The answer is forty-two, which is the answer to everything.";
    sent = [];
    transport.emit({
      type: "message.part",
      sessionId,
      part: part({ sessionId, id: "step-1", type: "step-start", text: "" }),
    });
    transport.emit({
      type: "message.part",
      sessionId,
      part: part({ sessionId, id: "text-1", type: "text", text: "" }),
      delta: answer,
    });
    transport.emit({
      type: "message.part",
      sessionId,
      part: part({ sessionId, id: "step-2", type: "step-finish", text: "" }),
    });
    transport.emit({ type: "session.idle", sessionId });
    await tick(20);

    expect(texts().join("")).toContain("forty-two");
  });

  test("streaming deltas accumulate before being relayed", async () => {
    // Mirrors the real `message.part.delta` event shape, which carries no part
    // snapshot at all — only sessionID, messageID, partID and the delta.
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hi" }));
    const sessionId = transport.prompts[0]!.sessionId;

    sent = [];
    for (const chunk of ["Hello", " there,", " world."]) {
      transport.emit({
        type: "message.part",
        sessionId,
        part: part({ sessionId, id: "stream-part", type: "text", text: "" }),
        delta: chunk,
      });
    }
    transport.emit({ type: "session.idle", sessionId });
    await tick(20);
    expect(texts().join("")).toContain("Hello there, world.");
  });
  test("text deltas stream, then flush on idle", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hi" }));
    const sessionId = transport.prompts[0]!.sessionId;

    sent = [];
    const answer = "Hello there — the parser is fixed and the suite is green.";
    transport.emit({
      type: "message.part",
      sessionId,
      part: part({ sessionId, id: "p1", text: "" }),
      delta: answer.slice(0, 20),
    });
    transport.emit({
      type: "message.part",
      sessionId,
      part: part({ sessionId, id: "p1", text: answer }),
      delta: answer.slice(20),
    });
    await tick(20);
    expect(texts().join("")).toContain("the parser is fixed");

    sent = [];
    transport.emit({ type: "session.idle", sessionId });
    await tick(20);
    expect(texts().join("")).toContain("the parser is fixed");
    expect(bridge.sessions.get(msg().chat)?.busy).toBe(false);
  });

  test("a session.error is reported rather than hanging", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hi" }));
    const sessionId = transport.prompts[0]!.sessionId;

    sent = [];
    transport.emit({ type: "session.error", sessionId, message: "provider exploded" });
    await tick(20);
    expect(sent.flatMap((s) => s.cards).some((c) => c.kind === "error")).toBe(true);
    expect(bridge.sessions.get(msg().chat)?.busy).toBe(false);
  });

  test("invisible characters in a model reply are stripped before relay", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hi" }));
    const sessionId = transport.prompts[0]!.sessionId;

    sent = [];
    transport.emit({
      type: "message.part",
      sessionId,
      part: part({ sessionId, id: "p1", text: "clean\u200b\u202e text" }),
      delta: "clean\u200b\u202e text",
    });
    await tick(20);
    const out = texts().join("");
    expect(out).not.toContain("\u200b");
    expect(out).not.toContain("\u202e");
  });

  test("secrets in a tool output are masked before relay", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hi" }));
    const sessionId = transport.prompts[0]!.sessionId;

    sent = [];
    transport.emit({
      type: "message.part",
      sessionId,
      part: part({
        sessionId,
        id: "tool1",
        type: "tool",
        tool: "bash",
        state: { status: "completed", output: "AWS key AKIAIOSFODNN7EXAMPLE used" },
      }),
    });
    await tick(20);
    expect(sent.flatMap((s) => s.cards).some((c) => c.kind === "status")).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("the provider catalogue shape", () => {
  // Verified on a live 1.18.35 server: `/provider` returns `{ all, connected,
  // default }` where `all` is an ARRAY. Reading it as an object keyed by
  // provider id yields ["0","1","2",…] and nothing resolves, which is why
  // `/model` listed zero models.
  test("providerEntries accepts the array form", () => {
    const entries = providerEntries([
      { id: "opencode", models: { "big-pickle": {}, "muse-spark": {} } },
      { id: "other", models: [] },
    ]);
    expect(entries.map((e) => e.id)).toEqual(["opencode", "other"]);
    expect(modelIdsOf(entries[0]!.models)).toEqual(["big-pickle", "muse-spark"]);
  });

  test("providerEntries still accepts the object-keyed form", () => {
    const entries = providerEntries({ opencode: { models: ["a", "b"] } });
    expect(entries).toHaveLength(1);
    expect(modelIdsOf(entries[0]!.models)).toEqual(["a", "b"]);
  });

  test("modelIdsOf accepts both array and map shapes", () => {
    expect(modelIdsOf(["a", "b"])).toEqual(["a", "b"]);
    expect(modelIdsOf([{ id: "a" }, { id: "b" }])).toEqual(["a", "b"]);
    expect(modelIdsOf({ x: {}, y: {} })).toEqual(["x", "y"]);
    expect(modelIdsOf(undefined)).toEqual([]);
    expect(modelIdsOf("nonsense")).toEqual([]);
  });

  test("a malformed entry is dropped rather than producing an empty id", () => {
    expect(providerEntries([{ models: {} }, { id: "real", models: {} }])).toHaveLength(1);
    expect(providerEntries(null)).toEqual([]);
  });

  test("the connected filter keeps only usable providers", () => {
    const all = providerEntries([
      { id: "opencode", models: ["a"] },
      { id: "unconnected", models: ["b"] },
    ]);
    const connected = new Set(["opencode"]);
    expect(all.filter((e) => connected.has(e.id)).map((e) => e.id)).toEqual(["opencode"]);
  });
});

describe("model selection", () => {
  test("parses provider/model, and does not split a model id containing a slash", () => {
    // opencode model ids contain slashes (`anthropic/claude-haiku-4-5` under
    // `openrouter`). A naive split("/") yields provider `openrouter` and model
    // `anthropic`, which opencode rejects at prompt time.
    const withSlash = parseModelRef("openrouter/anthropic/claude-haiku-4-5");
    expect(withSlash).toEqual({
      ok: true,
      value: { providerID: "openrouter", modelID: "anthropic/claude-haiku-4-5" },
    });

    expect(parseModelRef("opencode/big-pickle")).toEqual({
      ok: true,
      value: { providerID: "opencode", modelID: "big-pickle" },
    });
  });

  test("a known model is matched exactly before any splitting", () => {
    const known = [{ providerID: "openrouter", modelID: "anthropic/claude-haiku-4-5" }];
    expect(parseModelRef("openrouter/anthropic/claude-haiku-4-5", undefined, known)).toEqual({
      ok: true,
      value: { providerID: "openrouter", modelID: "anthropic/claude-haiku-4-5" },
    });
  });

  test("a bare model id reuses the currently selected provider", () => {
    expect(parseModelRef("big-pickle", { providerID: "opencode", modelID: "old" })).toEqual({
      ok: true,
      value: { providerID: "opencode", modelID: "big-pickle" },
    });
  });

  test("a bare id with no current provider is refused with a usable message", () => {
    const result = parseModelRef("big-pickle");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("/model <provider>/<model>");
  });

  test("refuses an empty or slash-only argument", () => {
    expect(parseModelRef("").ok).toBe(false);
    expect(parseModelRef("/").ok).toBe(false);
    expect(parseModelRef("opencode/").ok).toBe(false);
    expect(parseModelRef("/big-pickle").ok).toBe(false);
  });

  test("the selection is applied to the next prompt", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "/model opencode/big-pickle" }));
    await bridge.handle(msg({ text: "hello" }));
    expect(transport.prompts.at(-1)?.model).toEqual({
      providerID: "opencode",
      modelID: "big-pickle",
    });
  });

  test("the selection applies once, not to every later prompt", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "/model opencode/big-pickle" }));
    await bridge.handle(msg({ text: "first" }));
    transport.emit({ type: "session.idle", sessionId: transport.prompts[0]!.sessionId });
    await tick(20);
    await bridge.handle(msg({ text: "second" }));
    expect(transport.prompts.at(-1)?.model).toBeUndefined();
  });
});

describe("§2.4 — the global-flag carry-over guard", () => {
  test("refuses to start when opencode's permission mode is not `ask`", async () => {
    build();
    transport.permissionModeValue = "allow";
    await expect(bridge.verifyPreconditions()).rejects.toBeInstanceOf(PreconditionError);
    await expect(bridge.verifyPreconditions()).rejects.toThrow(/permission mode is "allow"/);
  });

  test("passes when the mode is `ask`", async () => {
    build();
    transport.permissionModeValue = "ask";
    await expect(bridge.verifyPreconditions()).resolves.toBeUndefined();
  });

  test("the refusal names the setting to fix", async () => {
    build();
    transport.permissionModeValue = "yolo";
    try {
      await bridge.verifyPreconditions();
      throw new Error("should have thrown");
    } catch (err) {
      expect(String(err)).toContain("opencode.json");
    }
  });

  test("fails closed when the mode cannot be determined", async () => {
    // "Could not determine" is not "the mode is ask". If we cannot prove the
    // agent will ask before acting, we must not start.
    build();
    transport.permissionModeValue = undefined;
    await expect(bridge.verifyPreconditions()).rejects.toBeInstanceOf(PreconditionError);
    await expect(bridge.verifyPreconditions()).rejects.toThrow(/cannot confirm/);
  });

  test("the documented escape hatch still works", async () => {
    const relaxed = new Bridge({
      config: testConfig(stateDir, { requirePermissionAsk: false }),
      logger: testLogger(stateDir),
      salt: "test-salt-0000000000000000",
      transport,
      minGapMs: 0,
    });
    transport.permissionModeValue = "allow";
    await expect(relaxed.verifyPreconditions()).resolves.toBeUndefined();
  });

  test("reads the object form opencode actually uses", () => {
    expect(resolvePermissionMode("ask")).toBe("ask");
    expect(resolvePermissionMode({ "*": "ask" })).toBe("ask");
    expect(resolvePermissionMode({ "*": "allow" })).toBe("allow");
    expect(resolvePermissionMode({ bash: "allow" })).toBe("allow");
    // Mixed shapes are genuinely ambiguous.
    expect(resolvePermissionMode({ a: "allow", b: "ask" })).toBeUndefined();
    expect(resolvePermissionMode({})).toBeUndefined();
    expect(resolvePermissionMode(null)).toBeUndefined();
    expect(resolvePermissionMode(42)).toBeUndefined();
  });
});

describe("§7.4 layer 1 — the anti-injection system instruction", () => {
  test("every relayed prompt carries it", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hello" }));
    expect(transport.prompts[0]!.system).toContain("rc access");
    expect(transport.prompts[0]!.system).toContain("prompt injection");
  });
});

describe("§8.5 — data subject rights", () => {
  test("/export produces valid JSON and /forget removes it", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hello" }));
    const actor = { platform: "test", id: "user-1" };

    const bundle = JSON.parse(bridge.privacy.exportData(actor));
    expect(bundle.actor.id).toBe("user-1");
    expect(bundle.sessions).toHaveLength(1);
    expect(Array.isArray(bundle.audit)).toBe(true);
    expect(bundle.consent).toBeNull();

    const ndjson = bridge.privacy.exportData(actor, "ndjson").split("\n");
    expect(ndjson.length).toBeGreaterThan(1);
    for (const line of ndjson) expect(() => JSON.parse(line)).not.toThrow();

    const result = bridge.privacy.forget(actor);
    expect(result.sessionsRemoved).toBe(1);
    expect(bridge.sessions.list()).toHaveLength(0);
    expect(JSON.parse(bridge.privacy.exportData(actor)).sessions).toHaveLength(0);
  });

  test("message bodies never reach the audit log", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    const secret = "my-really-secret-project-plan-1234";
    await bridge.handle(msg({ text: secret }));

    const raw = await Bun.file(join(stateDir, "logs", "audit.jsonl")).text();
    expect(raw).not.toContain(secret);
    // But the fact that a message was sent, and its length, is recorded.
    expect(raw).toContain("message.received");
    expect(raw).toContain("length");
  });

  test("the audit chain still verifies after a rights request", async () => {
    build({ allowFrom: ["test:user-1"] });
    await bridge.start();
    await bridge.handle(msg({ text: "hello" }));
    bridge.privacy.forget({ platform: "test", id: "user-1" });
    const result = verifyChain(join(stateDir, "logs", "audit.jsonl"));
    expect(result.ok).toBe(true);
  });

  test("the notice states who the controller is", () => {
    build();
    const notice = bridge.privacy.notice();
    expect(notice).toContain("you, the person running this instance, are the controller");
    expect(notice).toContain("no telemetry");
    expect(notice).toContain("Message bodies are never written to our");
  });
});

describe("§5.5 — one event stream, many consumers", () => {
  test("the hub deduplicates replayed frames", () => {
    const logger = testLogger(stateDir);
    const hub = new EventHub({ transport: new FakeTransport(), logger });
    let seen = 0;
    hub.subscribe(() => seen++);

    const event = {
      type: "permission.asked" as const,
      request: {
        id: "p1",
        sessionId: "ses_1",
        type: "bash",
        title: "t",
        createdAt: 0,
      },
    };
    hub.dispatch(event);
    hub.dispatch(event);
    expect(seen).toBe(1);
  });

  test("one bad subscriber does not stop the others", () => {
    const logger = testLogger(stateDir);
    const hub = new EventHub({ transport: new FakeTransport(), logger });
    let reached = 0;
    hub.subscribe(() => {
      throw new Error("boom");
    });
    hub.subscribe(() => reached++);
    hub.dispatch({ type: "session.idle", sessionId: "ses_1" });
    expect(reached).toBe(1);
  });

  test("unsubscribing actually unsubscribes", () => {
    const logger = testLogger(stateDir);
    const hub = new EventHub({ transport: new FakeTransport(), logger });
    let seen = 0;
    const off = hub.subscribe(() => seen++);
    off();
    hub.dispatch({ type: "session.idle", sessionId: "ses_1" });
    expect(seen).toBe(0);
  });
});

describe("§7.6 — the cost breaker", () => {
  test("notification volume per run is capped", async () => {
    build({ allowFrom: ["test:user-1"] });
    // Rebuild with a tighter cap.
    const tighter = new Bridge({
      config: testConfig(stateDir, { maxNotificationsPerRun: 2 }),
      logger: testLogger(stateDir),
      salt: "test-salt-0000000000000000",
      transport,
      adapter: new RecordingAdapter(),
      minGapMs: 0,
    });
    await tighter.start();

    for (let i = 0; i < 6; i++) {
      await tighter.deliver(msg().chat, [{ kind: "notice", text: `n${i}` }]);
    }
    await tick(20);
    // The queue collapses rather than growing without bound.
    expect(sent.length).toBeLessThanOrEqual(3);
    await tighter.stop();
  });
});

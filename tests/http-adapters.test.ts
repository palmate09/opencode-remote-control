/**
 * API (REST + SSE) and webhook adapter transport tests.
 *
 * These two bind real servers on loopback and are driven with real HTTP
 * requests. They are the only adapters that break the outbound-only rule, so
 * their authentication and their capability declarations are worth testing for
 * real rather than by inspection.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { ApiAdapter } from "../packages/api/src/index.ts";
import type {
  AdapterContext,
  BridgeHandle,
  ConversationRef,
  InboundMessage,
  PermissionVerdict,
} from "../packages/core/src/types.ts";
import { WEBHOOK_CAPABILITIES, WebhookAdapter } from "../packages/webhook/src/index.ts";

interface Sink {
  handled: InboundMessage[];
  answered: [ConversationRef, string, PermissionVerdict][];
  delivered: { cards: unknown[]; chatId: string }[];
  claimed: [string, string, string][];
}

function makeContext(sink: Sink): AdapterContext {
  const bridge: BridgeHandle = {
    handle: async (m) => {
      sink.handled.push(m);
    },
    prompt: async () => "ses_1",
    newSession: async () => "ses_2",
    abort: async () => {},
    deliver: async (conversation, cards) => {
      sink.delivered.push({ cards: [...cards], chatId: conversation.chatId });
    },
    answerPermission: async (conversation, shortId, verdict) => {
      sink.claimed.push([conversation.chatId, shortId, verdict]);
      sink.answered.push([conversation, shortId, verdict]);
      return true;
    },
  };
  const noopLogger = {
    ns: "t",
    error() {},
    warn() {},
    info() {},
    debug() {},
    trace() {},
    child: () => noopLogger,
    audit: () => ({}) as never,
    auditLog: {} as never,
    close() {},
  };
  return {
    config: {} as AdapterContext["config"],
    logger: noopLogger as unknown as AdapterContext["logger"],
    audit: { append: () => ({}) as never } as never,
    sessions: { list: () => [] } as never,
    permissions: {} as never,
    bridge,
    hub: { subscribe: () => () => {} } as never,
    outbox: {} as never,
  } as unknown as AdapterContext;
}

function sink(): Sink {
  return { handled: [], answered: [], delivered: [], claimed: [] };
}

const running: Server[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.stop(true);
});

// ── API ────────────────────────────────────────────────────────────────────

async function startApi(password = "hunter2-not-in-git") {
  const adapter = new ApiAdapter({ password, port: 0, host: "127.0.0.1" });
  await adapter.start(makeContext(sink()));
  running.push(serverOf(adapter));
  return adapter;
}

function serverOf(adapter: unknown): Server {
  const internal = (adapter as unknown as { server: Server }).server;
  if (!internal) throw new Error("adapter has no server");
  return internal;
}

function apiUrl(adapter: ApiAdapter, path: string): string {
  const port = serverOf(adapter).port;
  return `http://127.0.0.1:${port}${path}`;
}

const AUTH = { authorization: "Bearer hunter2-not-in-git" };

describe("api adapter — authentication", () => {
  test("rejects an unauthenticated request with 401", async () => {
    const adapter = await startApi();
    const res = await fetch(apiUrl(adapter, "/sessions"));
    expect(res.status).toBe(401);
  });

  test("rejects a wrong password", async () => {
    const adapter = await startApi();
    const res = await fetch(apiUrl(adapter, "/sessions"), {
      headers: { authorization: "Bearer wrong-password" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects a prefix of the real password", async () => {
    // Constant-time compare of equal-length prefixes must not pass.
    const adapter = await startApi();
    const res = await fetch(apiUrl(adapter, "/sessions"), {
      headers: { authorization: "Bearer hunter2-not-in" },
    });
    expect(res.status).toBe(401);
  });

  test("accepts the correct password", async () => {
    const adapter = await startApi();
    const res = await fetch(apiUrl(adapter, "/sessions"), { headers: AUTH });
    expect(res.status).toBe(200);
  });

  test("health needs no password, because it reveals nothing", async () => {
    const adapter = await startApi();
    const res = await fetch(apiUrl(adapter, "/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test("the health response does not leak anything", async () => {
    const adapter = await startApi("super-secret-value");
    const body = await (await fetch(apiUrl(adapter, "/health"))).text();
    expect(body).not.toContain("super-secret-value");
  });
});

describe("api adapter — routing", () => {
  test("an unknown path is 404, not a 500", async () => {
    const adapter = await startApi();
    const res = await fetch(apiUrl(adapter, "/nope"), { headers: AUTH });
    expect(res.status).toBe(404);
  });

  test("/prompt requires text", async () => {
    const adapter = await startApi();
    const res = await fetch(apiUrl(adapter, "/prompt"), {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ chat: "c1" }),
    });
    expect(res.status).toBe(400);
  });

  test("/prompt forwards to the bridge", async () => {
    const s = sink();
    const adapter = new ApiAdapter({ password: "hunter2-not-in-git", port: 0, host: "127.0.0.1" });
    await adapter.start(makeContext(s));
    running.push(serverOf(adapter));

    const res = await fetch(apiUrl(adapter, "/prompt"), {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", chat: "c1" }),
    });
    expect(res.status).toBe(200);
    expect(s.claimed).toEqual([]);
    await adapter.stop();
  });

  test("/permission validates the verdict", async () => {
    const adapter = await startApi();
    for (const verdict of ["maybe", "", "ONCE", 1, null]) {
      const res = await fetch(apiUrl(adapter, "/permission/abcde"), {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ verdict }),
      });
      expect(res.status).toBe(400);
    }
  });

  test("/permission accepts only the three opencode verdicts", async () => {
    const s = sink();
    const adapter = new ApiAdapter({ password: "hunter2-not-in-git", port: 0, host: "127.0.0.1" });
    await adapter.start(makeContext(s));
    running.push(serverOf(adapter));

    for (const verdict of ["once", "always", "reject"] as const) {
      const res = await fetch(apiUrl(adapter, "/permission/abcde"), {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ verdict, chat: "c1" }),
      });
      expect(res.status).toBe(200);
    }
    expect(s.claimed.map((c) => c[2])).toEqual(["once", "always", "reject"]);
    await adapter.stop();
  });

  test("a permission path with a bad shape is 404", async () => {
    const adapter = await startApi();
    for (const path of ["/permission/abc", "/permission/toolong", "/permission/abcde/extra"]) {
      const res = await fetch(apiUrl(adapter, path), { method: "POST", headers: AUTH });
      expect(res.status).toBe(404);
    }
  });
});

describe("api adapter — SSE", () => {
  test("the stream sets event-stream headers and stays open", async () => {
    const adapter = await startApi();
    const controller = new AbortController();
    const res = await fetch(apiUrl(adapter, "/events"), {
      headers: AUTH,
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // No proxy may buffer this or the stream is useless.
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("connected");
    controller.abort();
  });

  test("the stream requires the password", async () => {
    const adapter = await startApi();
    const res = await fetch(apiUrl(adapter, "/events"));
    expect(res.status).toBe(401);
  });

  test("cards reach connected clients as plain JSON", async () => {
    const adapter = new ApiAdapter({ password: "hunter2-not-in-git", port: 0, host: "127.0.0.1" });
    await adapter.start(makeContext(sink()));
    running.push(serverOf(adapter));

    const controller = new AbortController();
    const res = await fetch(apiUrl(adapter, "/events"), {
      headers: AUTH,
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // the "connected" preamble

    await adapter.send({
      conversation: { platform: "api", chatId: "c1" },
      cards: [{ kind: "text", markdown: "hello stream" }],
    });

    const next = await reader.read();
    const payload = new TextDecoder().decode(next.value);
    expect(payload).toContain("rc.cards");
    expect(payload).toContain("hello stream");
    controller.abort();
    await adapter.stop();
  });
});

// ── webhook ────────────────────────────────────────────────────────────────

async function startWebhook(opts: { permissionRelay?: boolean; token?: string } = {}) {
  return new WebhookAdapter({
    token: opts.token ?? "webhook-token-value",
    host: "127.0.0.1",
    port: 0,
    allowPermissionRelay: opts.permissionRelay === true,
  });
}

/** startWebhook + start, for tests that only need a reachable server. */
async function startWebhookServer(opts: { permissionRelay?: boolean } = {}) {
  const adapter = await startWebhook(opts);
  await adapter.start(makeContext(sink()));
  running.push(serverOf(adapter));
  return adapter;
}

function hookUrl(adapter: WebhookAdapter, path: string): string {
  return `http://127.0.0.1:${serverOf(adapter).port}${path}`;
}

const HOOK_AUTH = { authorization: "Bearer webhook-token-value" };

describe("webhook adapter — capability declaration", () => {
  // §7.4 layer 7. A webhook URL authenticates a caller, not a person, so this
  // adapter must NOT advertise permission-relay capability.
  test("does not advertise permissionRelay", () => {
    expect(WEBHOOK_CAPABILITIES.permissionRelay).toBe(false);
  });
});

describe("webhook adapter — authentication", () => {
  test("rejects an unauthenticated inbound message", async () => {
    const adapter = await startWebhookServer();
    const res = await fetch(hookUrl(adapter, "/inbound"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects a wrong token", async () => {
    const adapter = await startWebhookServer();
    const res = await fetch(hookUrl(adapter, "/inbound"), {
      method: "POST",
      headers: { ...HOOK_AUTH, authorization: "Bearer nope" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  test("health needs no token", async () => {
    const adapter = await startWebhookServer();
    const res = await fetch(hookUrl(adapter, "/health"));
    expect(res.status).toBe(200);
  });
});

describe("webhook adapter — inbound", () => {
  test("an authorised payload becomes an InboundMessage", async () => {
    const s = sink();
    const adapter = new WebhookAdapter({
      token: "webhook-token-value",
      host: "127.0.0.1",
      port: 0,
    });
    await adapter.start(makeContext(s));
    running.push(serverOf(adapter));

    const res = await fetch(hookUrl(adapter, "/inbound"), {
      method: "POST",
      headers: { ...HOOK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ text: "do the thing", actorId: "svc-1", chatId: "ops" }),
    });
    expect(res.status).toBe(200);
    expect(s.handled).toHaveLength(1);
    expect(s.handled[0]!.text).toBe("do the thing");
    expect(s.handled[0]!.actor.id).toBe("svc-1");
    expect(s.handled[0]!.chat.chatId).toBe("ops");
    expect(s.handled[0]!.platform).toBe("webhook");
    await adapter.stop();
  });

  test("rejects a payload with no text", async () => {
    const adapter = await startWebhookServer();
    for (const body of [{}, { text: "" }, { text: 42 }, null]) {
      const res = await fetch(hookUrl(adapter, "/inbound"), {
        method: "POST",
        headers: { ...HOOK_AUTH, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  test("refuses an oversized payload", async () => {
    const adapter = await startWebhookServer();
    const res = await fetch(hookUrl(adapter, "/inbound"), {
      method: "POST",
      headers: { ...HOOK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(300_000) }),
    });
    expect([400, 413]).toContain(res.status);
  });

  test("sanitises the actor and chat ids before they reach the bridge", async () => {
    // These become allowlist keys and rate-limit keys, so delimiter injection
    // here would forge structure downstream.
    const s = sink();
    const adapter = new WebhookAdapter({
      token: "webhook-token-value",
      host: "127.0.0.1",
      port: 0,
    });
    await adapter.start(makeContext(s));
    running.push(serverOf(adapter));

    await fetch(hookUrl(adapter, "/inbound"), {
      method: "POST",
      headers: { ...HOOK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", actorId: "a[b];\nc", chatId: "chat<script>" }),
    });
    const m = s.handled[0]!;
    expect(m.actor.id).not.toMatch(/[[\]\n]/);
    expect(m.chat.chatId).not.toContain("<");
    await adapter.stop();
  });
});

describe("webhook adapter — permission relay is refused by default", () => {
  test("POST /permission is 403 unless the operator opted in", async () => {
    const adapter = await startWebhookServer({ permissionRelay: false });
    const res = await fetch(hookUrl(adapter, "/permission/abcde"), {
      method: "POST",
      headers: { ...HOOK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ verdict: "once" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cannot authenticate");
  });

  test("even with the opt-in, the verdict is validated", async () => {
    const adapter = await startWebhookServer({ permissionRelay: true });
    const res = await fetch(hookUrl(adapter, "/permission/abcde"), {
      method: "POST",
      headers: { ...HOOK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ verdict: "definitely" }),
    });
    expect(res.status).toBe(400);
  });

  test("with the opt-in, a valid verdict reaches the bridge", async () => {
    const s = sink();
    const adapter = new WebhookAdapter({
      token: "webhook-token-value",
      host: "127.0.0.1",
      port: 0,
      allowPermissionRelay: true,
    });
    await adapter.start(makeContext(s));
    running.push(serverOf(adapter));

    const res = await fetch(hookUrl(adapter, "/permission/abcde"), {
      method: "POST",
      headers: { ...HOOK_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ verdict: "always" }),
    });
    expect(res.status).toBe(200);
    expect(s.claimed).toEqual([["webhook", "abcde", "always"]]);
    await adapter.stop();
  });

  test("permission relay still requires the bearer token", async () => {
    const adapter = await startWebhookServer({ permissionRelay: true });
    const res = await fetch(hookUrl(adapter, "/permission/abcde"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "once" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("bind behaviour", () => {
  test("both adapters bind to loopback by default, never 0.0.0.0", () => {
    // A server bound to every interface on a laptop is a control plane on the
    // public internet wearing a password.
    expect(new ApiAdapter({ password: "x".repeat(12) }).id).toBe("api");
    expect(new WebhookAdapter({ token: "x".repeat(12) }).id).toBe("webhook");
    const api = new ApiAdapter({ password: "x".repeat(12) }) as unknown as { host: string };
    const hook = new WebhookAdapter({ token: "x".repeat(12) }) as unknown as { host: string };
    expect(api.host).toBe("127.0.0.1");
    expect(hook.host).toBe("127.0.0.1");
  });
});

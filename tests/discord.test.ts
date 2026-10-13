/**
 * Discord interactions endpoint tests.
 *
 * The property under test is the one SECURITY.md used to say we lacked:
 * **a forged component interaction cannot reach `answerPermission`.** Discord
 * signs `timestamp || rawBody` with Ed25519; the adapter must verify it before
 * acting. These tests generate a real keypair, sign real payloads, and drive a
 * real HTTP server on loopback — the same standard the Telegram and API suites
 * hold themselves to.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import type { Server } from "bun";

import type {
  AdapterContext,
  BridgeHandle,
  ConversationRef,
  PermissionVerdict,
} from "../packages/core/src/types.ts";
import {
  DISCORD_CAPABILITIES,
  DiscordAdapter,
  parseEd25519PublicKey,
} from "../packages/discord/src/index.ts";

interface Sink {
  answered: [ConversationRef, string, PermissionVerdict][];
}

function makeContext(sink: Sink): AdapterContext {
  const bridge: BridgeHandle = {
    handle: async () => {},
    prompt: async () => "ses_1",
    newSession: async () => "ses_2",
    abort: async () => {},
    deliver: async () => {},
    answerPermission: async (conversation, shortId, verdict) => {
      sink.answered.push([conversation, shortId, verdict]);
      return true;
    },
    sendFile: async () => true,
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

/** A real Ed25519 keypair, as Discord would have generated for the app. */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHexDecoded = Buffer.from(
  (publicKey.export({ format: "jwk" }) as { x: string }).x,
  "base64url",
).toString("hex");

function signBody(body: string, timestamp: string): string {
  return sign(null, new TextEncoder().encode(timestamp + body), privateKey).toString("hex");
}

const running: Server[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.stop(true);
});

async function startAdapter(overrides: { publicKey?: string } = {}) {
  const adapter = new DiscordAdapter({
    token: "discord-test-token",
    publicKey: overrides.publicKey ?? publicKeyHexDecoded,
    interactionsPort: 0,
    interactionsHost: "127.0.0.1",
  });
  await adapter.start(makeContext({ answered: [] }));
  running.push(serverOf(adapter));
  return adapter;
}

function serverOf(adapter: unknown): Server {
  const internal = (adapter as unknown as { interactionsServer: Server }).interactionsServer;
  if (!internal) throw new Error("adapter has no interactions server");
  return internal;
}

function url(adapter: DiscordAdapter): string {
  return `http://127.0.0.1:${serverOf(adapter).port}/`;
}

/** POSTs `body` with a valid signature for the current timestamp. */
async function postSigned(adapter: DiscordAdapter, body: unknown, ts = "1700000000") {
  const raw = JSON.stringify(body);
  return fetch(url(adapter), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Signature-Ed25519": signBody(raw, ts),
      "X-Signature-Timestamp": ts,
    },
    body: raw,
  });
}

describe("discord — the Ed25519 key is required and parsed correctly", () => {
  test("a non-64-byte key is refused", () => {
    expect(parseEd25519PublicKey("")).toBeUndefined();
    expect(parseEd25519PublicKey("abcd")).toBeUndefined();
    expect(parseEd25519PublicKey("zz".repeat(32))).toBeUndefined();
  });

  test("a 32-byte hex key parses", () => {
    expect(parseEd25519PublicKey(publicKeyHexDecoded)).toBeDefined();
  });

  test("the adapter refuses to start with an invalid key", async () => {
    const adapter = new DiscordAdapter({
      token: "t",
      publicKey: "not-a-key",
      interactionsPort: 0,
    });
    await expect(adapter.start(makeContext({ answered: [] }))).rejects.toThrow(
      /RC_DISCORD_PUBLIC_KEY/,
    );
  });
});

describe("discord — the endpoint handshake", () => {
  test("answers a signed PING with { type: 1 }", async () => {
    const adapter = await startAdapter();
    const res = await postSigned(adapter, { type: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });
});

describe("discord — forged interactions never reach answerPermission", () => {
  test("a request with no signature is 401", async () => {
    const adapter = await startAdapter();
    const res = await fetch(url(adapter), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: 3, data: { custom_id: "rcyabcde" } }),
    });
    expect(res.status).toBe(401);
  });

  test("a valid signature over a *different* body is rejected", async () => {
    // The core attack: capture a real signed interaction, swap the custom_id to
    // approve something else. The signature no longer matches.
    const adapter = await startAdapter();
    const ts = "1700000000";
    const realBody = JSON.stringify({
      type: 3,
      id: "i1",
      token: "tok",
      channel_id: "c1",
      member: { user: { id: "42" } },
      data: { custom_id: "rcyabcde" },
    });
    const forged = JSON.stringify({
      type: 3,
      id: "i1",
      token: "tok",
      channel_id: "c1",
      member: { user: { id: "42" } },
      data: { custom_id: "rcyzzzzz" },
    });
    const res = await fetch(url(adapter), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Signature-Ed25519": signBody(realBody, ts),
        "X-Signature-Timestamp": ts,
      },
      body: forged,
    });
    expect(res.status).toBe(401);
  });

  test("a wrong key cannot sign its way in", async () => {
    const adapter = await startAdapter();
    const other = generateKeyPairSync("ed25519");
    const raw = JSON.stringify({ type: 3, data: { custom_id: "rcyabcde" } });
    const ts = "1700000000";
    const badSig = sign(null, new TextEncoder().encode(ts + raw), other.privateKey).toString("hex");
    const res = await fetch(url(adapter), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Signature-Ed25519": badSig,
        "X-Signature-Timestamp": ts,
      },
      body: raw,
    });
    expect(res.status).toBe(401);
  });
});

describe("discord — a genuine tap is relayed", () => {
  test("a correctly signed button tap reaches the bridge and acks", async () => {
    const adapter = new DiscordAdapter({
      token: "discord-test-token",
      publicKey: publicKeyHexDecoded,
      interactionsPort: 0,
      interactionsHost: "127.0.0.1",
    });
    const sink: Sink = { answered: [] };
    await adapter.start(makeContext(sink));
    running.push(serverOf(adapter));

    const res = await postSigned(adapter, {
      type: 3,
      id: "i2",
      token: "tok",
      channel_id: "chan-1",
      member: { user: { id: "42", username: "ada" } },
      data: { custom_id: "rcyabcde" },
    });

    // Deferred ACK, inside the 3-second window.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 5 });

    // Give the background handler a tick to reach the bridge.
    await new Promise((r) => setTimeout(r, 20));
    expect(sink.answered).toHaveLength(1);
    expect(sink.answered[0]![1]).toBe("abcde");
    expect(sink.answered[0]![2]).toBe("once");
    expect(sink.answered[0]![0].chatId).toBe("chan-1");
  });

  test("the capability is still declared as permission relay", () => {
    // It is now backed by signature verification rather than being aspirational.
    expect(DISCORD_CAPABILITIES.permissionRelay).toBe(true);
  });
});

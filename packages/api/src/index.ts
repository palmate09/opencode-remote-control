/**
 * REST + SSE API.
 *
 * This is what any future phone client, watch, or home-automation rule
 * consumes. It binds a TCP port, which is the one exception to the
 * outbound-only rule — bind it to a Tailscale address or loopback and nothing
 * else. §4.2.
 *
 * Authentication is a single shared password (Argon-free by design: the threat
 * is a leaked URL, not an offline attack on your key). The password is compared
 * in constant time and every rejected attempt is audited.
 *
 * The SSE stream re-publishes the same events the chat adapters see. It is
 * **not** a second subscription to opencode — `EventHub` is the single
 * subscriber (§5.5) and this adapter is just another fan-out consumer.
 */

import { timingSafeEqual } from "node:crypto";
import type { Server } from "bun";

import type {
  Adapter,
  AdapterCapabilities,
  AdapterContext,
  Card,
  InboundMessage,
  OutboundMessage,
} from "@opencode-rc/core";
import { safeName, sanitizeText } from "@opencode-rc/core";
import type { BridgeEvent } from "@opencode-rc/core";

export const API_CAPABILITIES: AdapterCapabilities = {
  messaging: true,
  // The API requires the same password as the stream, so the caller is
  // authenticated. That is weaker than a per-user identity but it is a real
  // authentication boundary, so the capability is declared honestly.
  permissionRelay: true,
  threads: true,
  richCards: true,
  // Files reach API clients as base64 in the SSE card payload.
  files: true,
};

const MAX_BODY_BYTES = 128 * 1024;

export interface ApiAdapterOptions {
  readonly password: string;
  readonly host?: string;
  readonly port?: number;
  readonly serve?: (opts: {
    port: number;
    hostname: string;
    fetch: (req: Request, server: Server) => Response | Promise<Response>;
  }) => Server;
}

interface StreamClient {
  readonly id: string;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
}

export class ApiAdapter implements Adapter {
  readonly id = "api";
  readonly displayName = "REST + SSE";
  readonly capabilities = API_CAPABILITIES;

  private readonly password: string;
  private readonly host: string;
  private readonly port: number;
  private readonly serve: NonNullable<ApiAdapterOptions["serve"]>;
  private server: Server | undefined;
  private ctx: AdapterContext | undefined;
  private readonly clients = new Set<StreamClient>();
  private unsubscribe: (() => void) | undefined;
  private counter = 0;

  constructor(opts: ApiAdapterOptions) {
    this.password = opts.password;
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 8787;
    this.serve =
      opts.serve ??
      ((o) =>
        Bun.serve({
          port: o.port,
          hostname: o.hostname,
          fetch: o.fetch,
          // Long-lived SSE connections must not be reaped.
          idleTimeout: 0,
        }));
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.server = this.serve({
      port: this.port,
      hostname: this.host,
      fetch: (req) => this.route(req),
    });
    // Subscribe to the hub, not to opencode. §5.5: EventHub is the single
    // subscriber, and every adapter is a fan-out consumer of it.
    this.unsubscribe = ctx.hub.subscribe((event) => this.publish(event));
    ctx.audit.append({
      event: "adapter.start",
      ns: "api",
      fields: { host: this.host, port: this.port, clients: 0 },
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const client of this.clients) {
      try {
        client.controller.close();
      } catch {
        // Already closed.
      }
    }
    this.clients.clear();
    await this.server?.stop(false);
    this.server = undefined;
    this.ctx?.audit.append({ event: "adapter.stop", ns: "api" });
  }

  private authorised(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/.exec(header);
    const supplied = match?.[1] ?? "";
    const a = new TextEncoder().encode(supplied);
    const b = new TextEncoder().encode(this.password);
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return json({ ok: true, adapter: this.id });

    if (!this.authorised(req)) {
      this.ctx?.audit.append({
        event: "api.unauthorised",
        outcome: "drop",
        ns: "api",
        fields: { path: safeName(url.pathname, 80), method: req.method },
      });
      return json({ error: "unauthorised" }, 401);
    }

    try {
      if (url.pathname === "/events" && req.method === "GET") return this.stream(req);
      if (url.pathname === "/sessions" && req.method === "GET")
        return json(this.ctx?.sessions.list() ?? []);
      if (url.pathname === "/prompt" && req.method === "POST") return this.prompt(req);
      if (url.pathname === "/abort" && req.method === "POST") return this.abort(req);
      if (url.pathname === "/new" && req.method === "POST") return this.newSession(req);
      const permission = /^\/permission\/([a-km-z]{5})$/.exec(url.pathname);
      if (permission && req.method === "POST") return this.permission(req, permission[1] as string);
      return json({ error: "not found" }, 404);
    } catch (err) {
      this.ctx?.logger.error("api handler failed", { error: String(err) });
      return json({ error: "internal" }, 500);
    }
  }

  private async body(req: Request): Promise<Record<string, unknown> | null> {
    const length = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
    return (await req.json().catch(() => null)) as Record<string, unknown> | null;
  }

  private conversationFrom(body: Record<string, unknown>): InboundMessage["chat"] {
    const chatId = safeName(String(body.chat ?? body.conversation ?? "api"), 120) || "api";
    const thread = body.thread ? safeName(String(body.thread), 120) : undefined;
    return { platform: this.id, chatId, ...(thread ? { threadId: thread } : {}) };
  }

  private async prompt(req: Request): Promise<Response> {
    const body = await this.body(req);
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) return json({ error: "text is required" }, 400);
    const conversation = this.conversationFrom(body ?? {});
    const sessionId = await this.ctx?.bridge.prompt(conversation, text);
    return json({ ok: true, sessionId: sessionId ?? null });
  }

  private async abort(req: Request): Promise<Response> {
    const body = await this.body(req);
    await this.ctx?.bridge.abort(this.conversationFrom(body ?? {}));
    return json({ ok: true });
  }

  private async newSession(req: Request): Promise<Response> {
    const body = await this.body(req);
    const sessionId = await this.ctx?.bridge.newSession(
      this.conversationFrom(body ?? {}),
      typeof body?.title === "string" ? sanitizeText(body.title, 120) : undefined,
    );
    return json({ ok: true, sessionId: sessionId ?? null });
  }

  private async permission(req: Request, shortId: string): Promise<Response> {
    const body = await this.body(req);
    const verdict = body?.verdict;
    if (verdict !== "once" && verdict !== "always" && verdict !== "reject") {
      return json({ error: "verdict must be once | always | reject" }, 400);
    }
    const actor = {
      platform: this.id,
      id: safeName(String(body?.actor ?? "api-client"), 80),
    };
    const applied = await this.ctx?.bridge.answerPermission(
      this.conversationFrom(body ?? {}),
      shortId,
      verdict,
      actor,
    );
    return json({ ok: applied === true });
  }

  private stream(req: Request): Response {
    const encoder = new TextEncoder();
    const id = `c${++this.counter}`;

    let client: StreamClient | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = { id, controller };
        this.clients.add(client);
        controller.enqueue(encoder.encode(": connected\nretry: 3000\n\n"));
        this.ctx?.audit.append({
          event: "api.stream_open",
          ns: "api",
          fields: { client: id, total: this.clients.size },
        });
      },
      cancel: () => {
        if (client) this.clients.delete(client);
      },
    });

    req.signal.addEventListener("abort", () => {
      if (client) this.clients.delete(client);
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  /** Called by the runtime for every hub event. */
  publish(event: BridgeEvent): void {
    if (this.clients.size === 0) return;
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    const bytes = new TextEncoder().encode(payload);
    for (const client of this.clients) {
      try {
        client.controller.enqueue(bytes);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    // Cards reach API clients through the SSE stream, not through HTTP POSTs.
    this.publish({
      type: "unknown",
      rawType: "rc.cards",
      properties: { chat: msg.conversation.chatId, cards: msg.cards.map(plainCard) },
    });
  }

  /**
   * §7.4 layer 6 — a file reaches API clients as a base64 attachment on the SSE
   * stream. The bridge has already run the exfiltration guard.
   *
   * There is no size cap here beyond what the process can hold: an API client
   * chose the path, unlike a chat platform with a documented limit. The guard,
   * not a byte ceiling, is what stops `/state/access.json` leaving the machine.
   */
  async sendFile(
    conversation: { platform: string; chatId: string; threadId?: string },
    file: { path: string; name: string; caption?: string },
  ): Promise<void> {
    const bytes = await Bun.file(file.path).arrayBuffer();
    this.publish({
      type: "unknown",
      rawType: "rc.file",
      properties: {
        chat: conversation.chatId,
        name: file.name,
        bytes: bytes.byteLength,
        ...(file.caption ? { caption: sanitizeText(file.caption, 500) } : {}),
        dataBase64: Buffer.from(bytes).toString("base64"),
      },
    });
  }
}

function plainCard(card: Card): Record<string, unknown> {
  switch (card.kind) {
    case "text":
      return { kind: "text", text: sanitizeText(card.markdown) };
    case "status":
      return { kind: "status", label: sanitizeText(card.label, 200) };
    case "notice":
      return { kind: "notice", text: sanitizeText(card.text) };
    case "error":
      return { kind: "error", text: sanitizeText(card.message) };
    case "permission":
      return {
        kind: "permission",
        id: card.id,
        tool: card.tool,
        title: sanitizeText(card.title, 500),
        expiresAt: card.expiresAt,
      };
    case "diff":
      return {
        kind: "diff",
        files: card.files.map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
        })),
      };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function create(env: Record<string, string | undefined>): ApiAdapter {
  const password = env.RC_API_PASSWORD;
  if (!password) throw new Error("RC_API_PASSWORD is not set");
  return new ApiAdapter({
    password,
    ...(env.RC_API_HOST ? { host: env.RC_API_HOST } : {}),
    ...(env.RC_API_PORT ? { port: Number.parseInt(env.RC_API_PORT, 10) } : {}),
  });
}

export const id = "api";

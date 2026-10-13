/**
 * Discord adapter.
 *
 * Transport: Gateway (WebSocket) for inbound, REST for outbound. Channel =
 * project, thread = session — so one channel can run several sessions in
 * parallel without crosstalk (acceptance test 9).
 *
 * No Discord library. Bun ships a native `WebSocket`, and the Gateway is a
 * documented heartbeat/identify/resume protocol. Owning it keeps the dependency
 * tree small and means a breaking SDK release cannot take the adapter down.
 *
 * The one constraint that shapes this file: Discord buttons must be
 * acknowledged inside a **3-second interaction window** or the token expires.
 */

import { createPublicKey, verify as verifyEd25519Sig } from "node:crypto";
import type { Server } from "bun";

import type {
  Adapter,
  AdapterCapabilities,
  AdapterContext,
  Card,
  InboundMessage,
  OutboundMessage,
} from "@opencode-rc/core";
import { chunkText, sanitizeText } from "@opencode-rc/core";

export const DISCORD_CAPABILITIES: AdapterCapabilities = {
  messaging: true,
  // Interaction payloads carry `member.user.id`, so a tap is authenticated.
  permissionRelay: true,
  threads: true,
  richCards: true,
  // Multipart upload to the channel/thread; cap is 25 MB (or 10 MB free tier).
  files: true,
};

/** §10.1 — verified limits. */
export const DISCORD_MESSAGE_LIMIT = 2000;
/** §7.5 — Discord's 3-second interaction response window. */
export const INTERACTION_DEADLINE_MS = 3000;

const GATEWAY_VERSION = 9;
const HEARTBEAT_INTERVAL_MS = 41_250;
const RESUME_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

interface GatewayEvent {
  op: number;
  d: Record<string, unknown>;
  s?: number | null;
  t?: string;
}

export interface DiscordAdapterOptions {
  readonly token: string;
  /** Application id, needed for interactions. */
  readonly applicationId?: string;
  /**
   * Ed25519 public key (hex) for verifying interaction signatures. **Required.**
   *
   * Discord signs every HTTP interaction; without this the endpoint cannot tell
   * a real component tap from a forged one. The adapter refuses to start its
   * interactions endpoint without it — see SECURITY.md.
   */
  readonly publicKey: string;
  readonly apiBase?: string;
  readonly gatewayUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  readonly socketFactory?: (url: string) => WebSocket;
  /**
   * Interactions endpoint. Discord delivers component taps over HTTP, not the
   * Gateway, so without this endpoint permission buttons cannot be answered
   * securely. Binds loopback by default; expose only behind TLS.
   */
  readonly interactionsHost?: string;
  readonly interactionsPort?: number;
  /** Overridable for tests. */
  readonly serve?: (opts: {
    port: number;
    hostname: string;
    fetch: (req: Request, server: Server) => Response | Promise<Response>;
  }) => Server;
}

interface InteractionPayload {
  id: string;
  token: string;
  type: number;
  data?: {
    custom_id?: string;
    name?: string;
    options?: { name: string; value: unknown }[];
  };
  member?: { user?: { id: string; username?: string; global_name?: string } };
  user?: { id: string; username?: string; global_name?: string };
  channel_id?: string;
  guild_id?: string;
  thread_id?: string;
}

export class DiscordAdapter implements Adapter {
  readonly id = "discord";
  readonly displayName = "Discord";
  readonly capabilities = DISCORD_CAPABILITIES;

  private readonly token: string;
  private readonly applicationId?: string;
  private readonly publicKey: string;
  private readonly apiBase: string;
  private readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly interactionsHost: string;
  private readonly interactionsPort: number;
  private readonly serve: NonNullable<DiscordAdapterOptions["serve"]>;
  /** The Ed25519 public key, parsed once; `undefined` when the hex is invalid. */
  private readonly verifyKey: ReturnType<typeof createPublicKey> | undefined;

  private ctx: AdapterContext | undefined;
  private ws: WebSocket | undefined;
  private interactionsServer: Server | undefined;
  private running = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private sequence: number | null = null;
  private sessionId: string | undefined;
  private resumeUrl: string | undefined;
  private attempt = 0;
  /** Interactions, for the 3-second deferred-reply obligation. */
  private readonly pendingInteractions = new Map<string, { token: string; chatId: string }>();
  /** channelId → threadId. */
  private readonly threads = new Map<string, string>();

  constructor(opts: DiscordAdapterOptions) {
    this.token = opts.token;
    this.applicationId = opts.applicationId;
    this.publicKey = opts.publicKey;
    this.apiBase = opts.apiBase ?? "https://discord.com/api/v10";
    this.gatewayUrl =
      opts.gatewayUrl ?? `wss://gateway.discord.gg/?v=${GATEWAY_VERSION}&encoding=json`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.socketFactory = opts.socketFactory ?? ((url) => new WebSocket(url));
    this.interactionsHost = opts.interactionsHost ?? "127.0.0.1";
    this.interactionsPort = opts.interactionsPort ?? 8789;
    this.serve =
      opts.serve ??
      ((o) =>
        Bun.serve({
          port: o.port,
          hostname: o.hostname,
          fetch: o.fetch,
          idleTimeout: 0,
        }));
    this.verifyKey = parseEd25519PublicKey(opts.publicKey);
  }

  // ── REST ─────────────────────────────────────────────────────────────────

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(
        `discord ${method} ${path} → ${res.status}: ${detail.slice(0, 200)}`,
      ) as Error & {
        retryAfterMs?: number;
      };
      // Discord's Retry-After header is in seconds; the outbox wants ms, and the
      // unit is part of the field name so nobody has to guess again.
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      if (Number.isFinite(retryAfter)) err.retryAfterMs = retryAfter * 1000;
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.running = true;

    if (!this.verifyKey) {
      // Fail closed. Without a usable key every interaction is unverifiable, so
      // the permission endpoint would be forgeable. Refusing to start is the
      // honest choice; the operator fixes RC_DISCORD_PUBLIC_KEY.
      throw new Error(
        "discord: RC_DISCORD_PUBLIC_KEY is missing or not a valid 32-byte Ed25519 hex key. " +
          "Permission relay cannot be authenticated without it.",
      );
    }

    // Interactions arrive over HTTP, not the Gateway. This endpoint verifies the
    // Ed25519 signature on every request before it is allowed to answer a
    // permission, which is the whole reason Discord can advertise
    // permissionRelay (§7.4 layer 7).
    this.interactionsServer = this.serve({
      port: this.interactionsPort,
      hostname: this.interactionsHost,
      fetch: (req) => this.routeInteraction(req),
    });
    ctx.logger.info("discord interactions endpoint listening", {
      host: this.interactionsHost,
      port: this.interactionsPort,
    });

    // Resolve our own id so `<@id>` mentions can be stripped and our own
    // messages never come back in as inbound.
    await this.rest<{ id: string; username: string }>("GET", "/users/@me")
      .then((me) => {
        this.botName = me.id;
        ctx.logger.debug("discord bot identity resolved", { id: me.id });
      })
      .catch((err: unknown) =>
        ctx.logger.warn("could not resolve the Discord bot identity; mention stripping disabled", {
          error: String(err),
        }),
      );
    ctx.audit.append({ event: "adapter.start", ns: "discord" });
    void this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.ws?.close();
    this.ws = undefined;
    await this.interactionsServer?.stop(false);
    this.interactionsServer = undefined;
    this.ctx?.audit.append({ event: "adapter.stop", ns: "discord" });
  }

  /** Routes an HTTP interaction: PING, or a signed component tap. */
  private async routeInteraction(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    // The signature covers the *raw* body. Read it once, as text, before any
    // JSON handling — a re-serialised body would not match the signed bytes.
    const raw = await req.text();
    if (!this.verifyInteraction(req, raw)) {
      this.ctx?.audit.append({
        event: "discord.bad_signature",
        outcome: "drop",
        ns: "discord",
        fields: { path: new URL(req.url).pathname },
      });
      return new Response("invalid request signature", { status: 401 });
    }

    let payload: InteractionPayload & { type: number };
    try {
      payload = JSON.parse(raw) as InteractionPayload & { type: number };
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // Discord's endpoint-validation PING. Type 1 must be answered with type 1.
    if (payload.type === 1) return json({ type: 1 });

    // A component (button) tap. Acknowledge first — the 3-second window applies
    // to the HTTP response too.
    if (payload.type === 3) {
      void this.onInteraction(payload).catch((err) => {
        this.ctx?.logger.error("discord interaction handler failed", { error: String(err) });
      });
      return json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    }

    return json({ type: 4, data: { content: "Unsupported interaction." } });
  }

  /**
   * §7.4 layer 7 — verify the Ed25519 signature of a Discord interaction.
   *
   * Discord signs `timestamp || rawBody`. The signature is in
   * `X-Signature-Ed25519`, the timestamp in `X-Signature-Timestamp`. A request
   * that fails this check is discarded and audited; it never reaches
   * `answerPermission`, which is exactly the property SECURITY.md used to say
   * we did not have.
   */
  verifyInteraction(req: Request, rawBody: string): boolean {
    if (!this.verifyKey) return false;
    const signature = req.headers.get("X-Signature-Ed25519");
    const timestamp = req.headers.get("X-Signature-Timestamp");
    if (!signature || !timestamp) {
      this.ctx?.logger.warn("discord interaction missing signature headers");
      return false;
    }
    const sigBuf = hexToBytes(signature);
    if (!sigBuf || sigBuf.length !== 64) return false;
    try {
      return verifyEd25519Sig(
        null,
        new TextEncoder().encode(timestamp + rawBody),
        this.verifyKey,
        sigBuf,
      );
    } catch {
      return false;
    }
  }

  private async connect(): Promise<void> {
    while (this.running) {
      const url =
        this.sessionId && this.resumeUrl
          ? `${this.resumeUrl}?v=${GATEWAY_VERSION}`
          : this.gatewayUrl;
      try {
        await this.openSocket(url);
        this.attempt = 0;
      } catch (err) {
        if (!this.running) return;
        this.ctx?.logger.warn("discord gateway disconnected", { error: String(err) });
      }
      if (!this.running) return;
      const delay =
        RESUME_BACKOFF_MS[Math.min(this.attempt, RESUME_BACKOFF_MS.length - 1)] ?? 30_000;
      this.attempt++;
      await sleep(delay);
    }
  }

  private openSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.socketFactory(url);
      this.ws = ws;

      ws.onopen = () => {
        this.ctx?.logger.info("discord gateway connected", { resumed: !!this.sessionId });
        if (this.sessionId && this.sequence !== null) {
          ws.send(
            JSON.stringify({
              op: 6,
              d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
            }),
          );
        } else {
          ws.send(JSON.stringify({ op: 2, d: this.identifyPayload() }));
        }
      };

      ws.onmessage = (raw) => {
        let event: GatewayEvent;
        try {
          event = JSON.parse(String((raw as MessageEvent).data)) as GatewayEvent;
        } catch {
          return;
        }
        void this.onGatewayEvent(event).catch((err) => {
          this.ctx?.logger.error("discord gateway handler failed", { error: String(err) });
        });
        if (event.s !== null && event.s !== undefined) this.sequence = event.s;
        if (event.op === 0) resolve();
      };

      ws.onerror = (err) => reject(err instanceof Error ? err : new Error("discord socket error"));
      ws.onclose = () => {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        resolve();
      };
    });
  }

  private identifyPayload(): Record<string, unknown> {
    return {
      token: this.token,
      intents: (1 << 9) | (1 << 15) | (1 << 12), // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
      properties: { os: process.platform, browser: "opencode-rc", device: "opencode-rc" },
    };
  }

  private async onGatewayEvent(event: GatewayEvent): Promise<void> {
    switch (event.op) {
      case 10: // HELLO
        this.startHeartbeat(Number(event.d.heartbeat_interval ?? HEARTBEAT_INTERVAL_MS));
        return;
      case 1: // HEARTBEAT request
        this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
        return;
      case 0: {
        if (event.t === "READY") {
          const d = event.d as { session_id?: string; resume_gateway_url?: string };
          this.sessionId = d.session_id;
          this.resumeUrl = d.resume_gateway_url;
          return;
        }
        if (event.t === "RESUMED") {
          this.ctx?.logger.info("discord gateway resumed");
          return;
        }
        if (event.t === "MESSAGE_CREATE") return this.onMessage(event.d);
        // INTERACTION_CREATE is deliberately NOT handled here. It arrives at
        // the HTTP interactions endpoint instead, where the Ed25519 signature is
        // verified. Handling it on the Gateway as well would reintroduce an
        // unauthenticated path to `answerPermission` — the exact forgery the
        // signature check exists to prevent.
        return;
      }
      default:
        return;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
    }, intervalMs);
    this.heartbeat.unref?.();
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private async onMessage(d: Record<string, unknown>): Promise<void> {
    const author = d.author as
      | { id?: string; bot?: boolean; username?: string; global_name?: string }
      | undefined;
    if (!author || author.bot) return;

    const content = String(d.content ?? "");
    if (!content.trim()) return;

    const chatId = String(d.channel_id ?? "");
    const messageId = String(d.id ?? "");
    const inbound: InboundMessage = {
      platform: this.id,
      messageId,
      actor: {
        platform: this.id,
        id: String(author.id ?? ""),
        displayName: author.global_name ?? author.username,
      },
      chat: {
        platform: this.id,
        chatId,
        ...(d.thread_id ? { threadId: String(d.thread_id) } : {}),
      },
      text: content,
      timestamp: Number(d.timestamp ? Date.parse(String(d.timestamp)) : Date.now()),
      isGroup: true, // Discord channels are group conversations by definition.
      mentionsBot: mentionsBot(content, this.botName),
    };

    // Strip the leading mention so the command parser sees a clean body.
    if (inbound.mentionsBot && this.botName) {
      const at = new RegExp(`<@!?${escapeRegExp(this.botName)}>\\s*`, "g");
      const stripped = content.replace(at, "").trim();
      // InboundMessage fields are readonly by contract, so build the adjusted
      // message rather than mutating one we do not own.
      await this.ctx?.bridge.handle({ ...inbound, text: stripped });
      return;
    }

    await this.ctx?.bridge.handle(inbound);
  }

  private botName = "";

  /** Called after identify so `<@123>` mentions can be stripped. */
  setBotId(id: string): void {
    this.botName = id;
  }

  private async onInteraction(payload: InteractionPayload): Promise<void> {
    if (!this.ctx) return;
    const customId = payload.data?.custom_id;
    if (!customId) return;

    const user = payload.member?.user ?? payload.user;
    const actor = {
      platform: this.id,
      id: String(user?.id ?? ""),
      displayName: user?.global_name ?? user?.username,
    };

    const parsed = parseCustomId(customId);
    if (!parsed) {
      // The HTTP layer already returned the deferred ACK; report the outcome by
      // editing the original message rather than sending a second callback.
      await this.editOriginal(payload, "Unknown action.");
      return;
    }

    const chatId = String(payload.thread_id ?? payload.channel_id ?? "");
    // Remember the interaction so the deferred reply can use the same token.
    this.pendingInteractions.set(payload.id, { token: payload.token, chatId });
    this.expireInteraction(payload.id);

    this.ctx.audit.append({
      event: "permission.tap",
      actor,
      ns: "discord",
      fields: { shortId: parsed.shortId, verdict: parsed.verdict },
    });

    const applied = await this.ctx.bridge.answerPermission(
      { platform: this.id, chatId, ...(payload.thread_id ? { threadId: payload.thread_id } : {}) },
      parsed.shortId,
      parsed.verdict,
      actor,
    );

    if (applied) {
      await this.editOriginal(payload, `✓ ${labelFor(parsed.verdict)} \`${parsed.shortId}\``);
    }
    this.pendingInteractions.delete(payload.id);
  }

  private expireInteraction(id: string): void {
    setTimeout(() => this.pendingInteractions.delete(id), INTERACTION_DEADLINE_MS * 4).unref?.();
  }

  private async respond(payload: InteractionPayload, body: unknown): Promise<void> {
    await this.rest("POST", `/interactions/${payload.id}/callback`, body).catch((err) => {
      this.ctx?.logger.warn("interaction callback failed", { error: String(err) });
    });
  }

  private async editOriginal(payload: InteractionPayload, content: string): Promise<void> {
    await this.rest(
      "PATCH",
      `/webhooks/${this.applicationId ?? ""}/${this.token}/messages/@original`,
      {
        content,
      },
    ).catch(() => undefined);
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  async send(msg: OutboundMessage): Promise<void> {
    const chatId = msg.conversation.chatId;
    const threadId = msg.conversation.threadId ?? (await this.ensureThread(chatId));
    for (const card of msg.cards) {
      await this.render(chatId, threadId, card);
    }
  }

  /**
   * Channel = project, thread = session. If we have not yet created a thread for
   * this channel, make one so two conversations in one channel stay isolated
   * (acceptance test 9).
   */
  private async ensureThread(chatId: string): Promise<string> {
    const existing = this.threads.get(chatId);
    if (existing) return existing;
    try {
      const created = await this.rest<{ id: string }>("POST", `/channels/${chatId}/threads`, {
        name: `opencode-${chatId}`,
        auto_archive_duration: 1440,
      });
      this.threads.set(chatId, created.id);
      return created.id;
    } catch (err) {
      // Thread creation can fail on channels without the permission. Fall back
      // to posting in-channel rather than dropping the message, and say so.
      this.ctx?.logger.warn("could not create a Discord thread; posting in-channel", {
        chat: chatId,
        error: String(err),
      });
      return chatId;
    }
  }

  private async render(chatId: string, threadId: string, card: Card): Promise<void> {
    switch (card.kind) {
      case "text":
      case "notice":
      case "error": {
        const text =
          card.kind === "text"
            ? card.markdown
            : card.kind === "notice"
              ? card.text
              : `⚠️ ${card.message}`;
        for (const chunk of chunkText(sanitizeText(text), DISCORD_MESSAGE_LIMIT - 8)) {
          await this.post(chatId, threadId, chunk);
        }
        return;
      }
      case "status": {
        await this.post(chatId, threadId, `· ${sanitizeText(card.label, 200)}`);
        return;
      }
      case "diff": {
        const lines = card.files.map((f) => `\`${f.path}\` +${f.additions} −${f.deletions}`);
        await this.post(chatId, threadId, `Changes:\n${lines.join("\n")}`);
        return;
      }
      case "permission": {
        await this.post(chatId, threadId, card.title, permissionComponents(card.id));
        return;
      }
    }
  }

  /**
   * §7.4 layer 6 — upload a file to the channel/thread. The bridge has already
   * run the exfiltration guard; this only has to build the multipart request.
   */
  async sendFile(
    conversation: { platform: string; chatId: string; threadId?: string },
    file: { path: string; name: string; caption?: string },
  ): Promise<void> {
    const target =
      conversation.threadId && conversation.threadId !== conversation.chatId
        ? conversation.threadId
        : conversation.chatId;
    const bytes = await Bun.file(file.path).arrayBuffer();
    const form = new FormData();
    if (file.caption) form.set("content", file.caption);
    form.set("files[0]", new Blob([bytes]), file.name);
    const res = await this.fetchImpl(`${this.apiBase}/channels/${target}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${this.token}` },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`discord upload → ${res.status}: ${detail.slice(0, 200)}`);
    }
  }

  private async post(
    chatId: string,
    threadId: string,
    content: string,
    components?: unknown[],
  ): Promise<void> {
    const target = threadId && threadId !== chatId ? threadId : chatId;
    await this.rest("POST", `/channels/${target}/messages`, {
      content,
      ...(components ? { components } : {}),
    });
  }
}

function permissionComponents(shortId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "Approve once", custom_id: customId(shortId, "once") },
        { type: 2, style: 3, label: "Always", custom_id: customId(shortId, "always") },
        { type: 2, style: 4, label: "Deny", custom_id: customId(shortId, "reject") },
      ],
    },
  ];
}

/** Discord caps `custom_id` at 100 characters; ours is 8. */
export function customId(shortId: string, verdict: "once" | "always" | "reject"): string {
  const map: Record<string, string> = { once: "y", always: "a", reject: "n" };
  return `rc${map[verdict] ?? "n"}${shortId}`;
}

export function parseCustomId(
  value: string | undefined,
): { verdict: "once" | "always" | "reject"; shortId: string } | null {
  const m = /^rc([yan])([a-km-z]{5})$/.exec(value ?? "");
  if (!m) return null;
  const verdict = m[1] === "y" ? "once" : m[1] === "a" ? "always" : "reject";
  return { verdict, shortId: m[2] as string };
}

function labelFor(verdict: "once" | "always" | "reject"): string {
  return verdict === "reject"
    ? "Denied"
    : verdict === "always"
      ? "Always allowed"
      : "Approved once";
}

function mentionsBot(content: string, botId: string): boolean {
  if (!botId) return true; // Unknown bot id: be permissive and let the gate decide.
  return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Parses Discord's 32-byte raw Ed25519 public key (hex) into a Node `KeyObject`.
 *
 * Node's `verify` does not accept a bare 32-byte key for Ed25519 — that is the
 * "Invalid digest" trap. The raw key must be wrapped in a SubjectPublicKeyInfo
 * DER structure: a fixed 12-byte prefix followed by the key bytes.
 *
 * Returns `undefined` on anything that is not exactly 32 hex-encoded bytes, so
 * the adapter can fail closed rather than start with a key it cannot use.
 */
export function parseEd25519PublicKey(hex: string): ReturnType<typeof createPublicKey> | undefined {
  const trimmed = String(hex ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return undefined;
  // DER prefix for an Ed25519 SPKI: SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING <key> }.
  const prefix = hexToBytes("302a300506032b6570032100");
  const raw = hexToBytes(trimmed);
  if (!prefix || !raw) return undefined;
  const key = new Uint8Array(prefix.length + raw.length);
  key.set(prefix, 0);
  key.set(raw, prefix.length);
  try {
    return createPublicKey({ key, format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

/** Hex → bytes without depending on a Buffer/Node type that Bun re-declares. */
function hexToBytes(hex: string): Uint8Array | undefined {
  const s = String(hex ?? "");
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return undefined;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function create(env: Record<string, string | undefined>): DiscordAdapter {
  const token = env.RC_DISCORD_BOT_TOKEN;
  if (!token) throw new Error("RC_DISCORD_BOT_TOKEN is not set");
  const publicKey = env.RC_DISCORD_PUBLIC_KEY;
  if (!publicKey) throw new Error("RC_DISCORD_PUBLIC_KEY is not set");
  return new DiscordAdapter({
    token,
    publicKey,
    ...(env.RC_DISCORD_APPLICATION_ID ? { applicationId: env.RC_DISCORD_APPLICATION_ID } : {}),
    ...(env.RC_DISCORD_API_BASE ? { apiBase: env.RC_DISCORD_API_BASE } : {}),
    ...(env.RC_DISCORD_INTERACTIONS_HOST
      ? { interactionsHost: env.RC_DISCORD_INTERACTIONS_HOST }
      : {}),
    ...(env.RC_DISCORD_INTERACTIONS_PORT
      ? { interactionsPort: Number.parseInt(env.RC_DISCORD_INTERACTIONS_PORT, 10) }
      : {}),
  });
}

export const id = "discord";

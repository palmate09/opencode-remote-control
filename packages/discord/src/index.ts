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
  /** Application id, needed for the interaction endpoint URL. */
  readonly applicationId?: string;
  readonly apiBase?: string;
  readonly gatewayUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  readonly socketFactory?: (url: string) => WebSocket;
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
  private readonly apiBase: string;
  private readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: (url: string) => WebSocket;

  private ctx: AdapterContext | undefined;
  private ws: WebSocket | undefined;
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
    this.apiBase = opts.apiBase ?? "https://discord.com/api/v10";
    this.gatewayUrl =
      opts.gatewayUrl ?? `wss://gateway.discord.gg/?v=${GATEWAY_VERSION}&encoding=json`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.socketFactory = opts.socketFactory ?? ((url) => new WebSocket(url));
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

    // SECURITY: this adapter does not verify Discord's Ed25519 interaction
    // signature. Interactions arrive on the Gateway, which is authenticated by
    // the bot token — but a self-hosted Gateway does not prove to *us* that a
    // given interaction frame came from Discord rather than from something that
    // observed our connection.
    //
    // The honest position, matching SECURITY.md: permission relay over Discord
    // should be treated as weaker than Telegram's until signature verification
    // exists. We refuse to be silent about it at startup.
    ctx.logger.warn(
      "discord adapter does not verify interaction signatures (Ed25519). Treat permission " +
        "relay as weaker than Telegram's. See SECURITY.md → Untested surface.",
      { botId: this.botName },
    );

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
    this.ctx?.audit.append({ event: "adapter.stop", ns: "discord" });
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
        if (event.t === "INTERACTION_CREATE")
          return this.onInteraction(event.d as unknown as InteractionPayload);
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
      await this.respond(payload, { type: 4, data: { content: "Unknown action." } });
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

    // ACK inside 3s or the token dies.
    await this.respond(payload, { type: 5 });

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

export function create(env: Record<string, string | undefined>): DiscordAdapter {
  const token = env.RC_DISCORD_BOT_TOKEN;
  if (!token) throw new Error("RC_DISCORD_BOT_TOKEN is not set");
  return new DiscordAdapter({
    token,
    ...(env.RC_DISCORD_APPLICATION_ID ? { applicationId: env.RC_DISCORD_APPLICATION_ID } : {}),
    ...(env.RC_DISCORD_API_BASE ? { apiBase: env.RC_DISCORD_API_BASE } : {}),
  });
}

export const id = "discord";

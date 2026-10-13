/**
 * Telegram adapter.
 *
 * Transport: **outbound-only long poll** (§2.2 rule 1). We dial
 * `api.telegram.org` and never bind a port, so there is nothing to port-forward
 * and no TLS certificate to manage.
 *
 * SDK-free on purpose: the Bot API is a handful of JSON endpoints and adding a
 * dependency here would be the least reliable thing in the whole project. Every
 * call goes through `call()`, which is also where MarkdownV2 escaping lives.
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

export const TELEGRAM_CAPABILITIES: AdapterCapabilities = {
  messaging: true,
  // Telegram delivers `callback_query` with the user id attached, so a tap is
  // an authenticated inbound message. §7.4 layer 7.
  permissionRelay: true,
  threads: false,
  richCards: true,
  // sendDocument uploads the file; the Bot API cap is ~20 MB.
  files: true,
};

/** §10.1 — verified platform limits. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_ATTACHMENT_LIMIT = 20 * 1024 * 1024;

const POLL_TIMEOUT_SECONDS = 25;
/** Telegram rejects a getUpdates issued before the previous one resolves. */
const GET_UPDATES_OVERLAP_MS = 1000;

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: TelegramUser;
    chat: TelegramChat;
    text?: string;
    caption?: string;
    date: number;
    reply_to_message?: { message_id: number; from?: TelegramUser };
  };
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: { message_id: number; chat: TelegramChat };
    data?: string;
  };
}

export interface TelegramAdapterOptions {
  readonly token: string;
  readonly botUserId?: number;
  /** Overridable for tests. */
  readonly apiBase?: string;
  readonly pollIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface SentMessage {
  chat_id: number;
  message_id: number;
}

export class TelegramAdapter implements Adapter {
  readonly id = "telegram";
  readonly displayName = "Telegram";
  readonly capabilities = TELEGRAM_CAPABILITIES;

  private readonly token: string;
  private readonly apiBase: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly botUserId: number | undefined;
  private ctx: AdapterContext | undefined;
  private running = false;
  private offset = 0;
  private botId: number | undefined;
  /** chatId → live message id, for streaming edits. */
  private readonly live = new Map<string, SentMessage>();

  constructor(opts: TelegramAdapterOptions) {
    this.token = opts.token;
    this.apiBase = opts.apiBase ?? "https://api.telegram.org";
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.botUserId = opts.botUserId;
  }

  // ── Bot API plumbing ─────────────────────────────────────────────────────

  private async call<T>(
    method: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!res.ok || json.ok === false) {
      // Telegram reports floods as `parameters.retry_after` in seconds. The
      // outbox takes milliseconds, and the unit lives in the field name.
      const err = new Error(
        `telegram ${method} failed: ${json.description ?? res.status}`,
      ) as Error & {
        retryAfterMs?: number;
      };
      const retryAfter = json.parameters?.retry_after;
      if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
        err.retryAfterMs = retryAfter * 1000;
      }
      throw err;
    }
    return json.result as T;
  }

  /** Resolves our own user id so we can ignore our own echoes. */
  async identify(): Promise<{ id: number; username: string }> {
    const me = await this.call<{ id: number; username: string }>("getMe");
    this.botId = me.id;
    this.botUsername = me.username ?? "";
    return me;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    if (!this.botId) await this.identify().catch(() => undefined);

    const me = await this.call<{ id: number }>("getMe").catch(() => ({ id: 0 }));
    this.botId = me.id;
    if (!this.botUsername) await this.identify().catch(() => undefined);
    // Resume from the newest update on a cold start so a restart does not
    // replay an hour of backlog.
    const updates = await this.call<{ update_id: number }[]>("getUpdates", {
      offset: this.offset,
      limit: 1,
      timeout: 0,
    }).catch(() => [] as { update_id: number }[]);
    const newest = updates[updates.length - 1];
    if (newest && this.offset === 0) this.offset = newest.update_id + 1;

    this.running = true;
    ctx.audit.append({ event: "adapter.start", ns: "telegram", fields: { botId: this.botId } });
    void this.pollLoop();
  }

  /**
   * Upload a document. Uses multipart/form-data, which `call()` cannot express
   * (it sends JSON), so this is a separate path.
   *
   * The bridge has already run the exfiltration guard; this only has to make
   * the request. The basename, not the caller-supplied path, names the upload.
   */
  async sendFile(
    conversation: { platform: string; chatId: string },
    file: { path: string; name: string; caption?: string },
  ): Promise<void> {
    const chatId = Number(conversation.chatId);
    if (!Number.isFinite(chatId)) return;
    const bytes = await Bun.file(file.path).arrayBuffer();
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (file.caption) form.set("caption", escapeMarkdownV2(file.caption));
    form.set("document", new Blob([bytes]), file.name);
    const res = await this.fetchImpl(`${this.apiBase}/bot${this.token}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || json.ok === false) {
      throw new Error(`telegram sendDocument failed: ${json.description ?? res.status}`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ctx?.audit.append({ event: "adapter.stop", ns: "telegram" });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.call<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        const e = err as Error & { retryAfterMs?: number };
        if (typeof e.retryAfterMs === "number") {
          await sleep(e.retryAfterMs + GET_UPDATES_OVERLAP_MS);
        } else {
          this.ctx?.logger.warn("telegram poll failed", { error: e.message });
          await sleep(this.pollIntervalMs * 5);
        }
      }
      if (this.running) await sleep(GET_UPDATES_OVERLAP_MS);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update);
    const m = update.message;
    if (!m || !m.chat || !m.from) return;
    if (m.from.is_bot) return;
    if (this.botId && m.from.id === this.botId) return;

    const text = m.text ?? m.caption;
    if (!text) return;

    // `@botname` in a group is addressing, not content.
    const { body, mentionsBot } = stripMention(text, this.botUsername ?? "");

    const inbound: InboundMessage = {
      platform: this.id,
      messageId: String(m.message_id),
      actor: {
        platform: this.id,
        id: String(m.from.id),
        displayName:
          [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username,
      },
      chat: { platform: this.id, chatId: String(m.chat.id) },
      text: body,
      timestamp: m.date * 1000,
      isGroup: m.chat.type === "group" || m.chat.type === "supergroup" || m.chat.type === "channel",
      mentionsBot,
    };
    await this.ctx?.bridge.handle(inbound);
  }

  private botUsername: string | undefined;

  private async handleCallback(update: TelegramUpdate): Promise<void> {
    const q = update.callback_query;
    if (!q || !q.message || !this.ctx) return;
    const data = q.data ?? "";

    // Every tap is acknowledged inside Discord-style bounds; Telegram tokens
    // are valid for ~15 minutes but a spinner is polite and costs nothing.
    await this.call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => undefined);

    const parsed = parseCallbackData(data);
    if (!parsed) return;

    const actor = {
      platform: this.id,
      id: String(q.from.id),
      displayName:
        [q.from.first_name, q.from.last_name].filter(Boolean).join(" ") || q.from.username,
    };

    this.ctx.audit.append({
      event: "permission.tap",
      actor,
      ns: "telegram",
      fields: { shortId: parsed.shortId, verdict: parsed.verdict },
    });

    const applied = await this.ctx.bridge.answerPermission(
      { platform: this.id, chatId: String(q.message.chat.id) },
      parsed.shortId,
      parsed.verdict,
      actor,
    );

    if (applied) {
      await this.call("editMessageText", {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        text: `✓ ${labelFor(parsed.verdict)} \`${escapeMarkdownV2(parsed.shortId)}\``,
        parse_mode: "MarkdownV2",
      }).catch(() => undefined);
    }
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  async send(msg: OutboundMessage): Promise<void> {
    const chatId = Number(msg.conversation.chatId);
    if (!Number.isFinite(chatId)) return;

    for (const card of msg.cards) {
      await this.render(chatId, card);
    }
  }

  private async render(chatId: number, card: Card): Promise<void> {
    switch (card.kind) {
      case "text":
      case "notice": {
        const text = card.kind === "text" ? card.markdown : card.text;
        for (const chunk of chunkText(sanitizeText(text), TELEGRAM_MESSAGE_LIMIT - 32)) {
          await this.sendText(chatId, chunk);
        }
        return;
      }
      case "status": {
        // Status cards are low-signal, so they render as a quiet `·` line rather
        // than a full message. They are not transient — Telegram only supports
        // TTL on newer Bot API versions and we do not want a hard dependency.
        await this.call("sendMessage", {
          chat_id: chatId,
          text: escapeMarkdownV2(`· ${card.label}`),
          parse_mode: "MarkdownV2",
          link_preview_options: { is_disabled: true },
        }).catch(() => undefined);
        return;
      }
      case "error": {
        await this.sendText(chatId, `⚠️ ${card.message}`, true);
        return;
      }
      case "diff": {
        const lines = card.files.map((f) => `${f.path}  +${f.additions} −${f.deletions}`);
        await this.sendText(chatId, `Changes:\n${lines.join("\n")}`);
        return;
      }
      case "permission": {
        await this.sendPermission(chatId, card);
        return;
      }
    }
  }

  private async sendText(chatId: number, text: string, plain = false): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text: plain ? text : escapeMarkdownV2(text),
      ...(plain ? {} : { parse_mode: "MarkdownV2" }),
      link_preview_options: { is_disabled: true },
      disable_web_page_preview: true,
    });
  }

  /**
   * §5.4 — a permission Card becomes three inline buttons. The callback data
   * carries the short id and the verdict, so the bridge never has to remember
   * which button is which.
   */
  private async sendPermission(
    chatId: number,
    card: Extract<Card, { kind: "permission" }>,
  ): Promise<void> {
    const minutes = Math.max(1, Math.round((card.expiresAt - Date.now()) / 60_000));
    const text = [
      "🔐 *Permission required*",
      "",
      `Tool: \`${escapeMarkdownV2(card.tool)}\``,
      `Asks: ${escapeMarkdownV2(card.title)}`,
      "",
      `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    ].join("\n");

    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve once", callback_data: callbackData(card.id, "once") },
            { text: "♾️ Always", callback_data: callbackData(card.id, "always") },
            { text: "⛔️ Deny", callback_data: callbackData(card.id, "reject") },
          ],
        ],
      },
    });
  }

  /** Optional streaming edit. Falls back silently on platforms/versions that refuse. */
  async edit(
    conversation: { platform: string; chatId: string },
    messageId: string,
    cards: readonly Card[],
  ): Promise<void> {
    const chatId = Number(conversation.chatId);
    const text = cards.find((c) => c.kind === "text");
    if (!Number.isFinite(chatId) || !text || text.kind !== "text") return;
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text: escapeMarkdownV2(sanitizeText(text.markdown)),
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  }

  track(conversation: { platform: string; chatId: string }, message: SentMessage): void {
    this.live.set(`${conversation.chatId}`, message);
  }
}

/**
 * Telegram callback data is capped at 64 bytes. Our payload is 8.
 *
 * The `rc` namespace prefix is not strictly required — Telegram only echoes
 * data we set — but every adapter uses one, and a payload that is only valid
 * for this adapter is one forged payload can never be mistaken for.
 */
export function callbackData(shortId: string, verdict: "once" | "always" | "reject"): string {
  const map: Record<string, string> = { once: "y", always: "a", reject: "n" };
  return `rc${map[verdict] ?? "n"}${shortId}`;
}

export function parseCallbackData(
  data: string | undefined,
): { verdict: "once" | "always" | "reject"; shortId: string } | null {
  const m = /^rc([yan])([a-km-z]{5})$/.exec(data ?? "");
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

function stripMention(text: string, botUsername: string): { body: string; mentionsBot: boolean } {
  if (!botUsername) return { body: text, mentionsBot: true };
  const re = new RegExp(`(^|\\s)@${escapeRegExp(botUsername)}\\b`, "i");
  if (!re.test(text)) return { body: text, mentionsBot: false };
  return { body: text.replace(re, " ").trim(), mentionsBot: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * MarkdownV2 escaping. Telegram silently drops messages with unbalanced
 * entities, so this is applied to *every* string we send, including ones that
 * already contain markdown.
 */
export function escapeMarkdownV2(input: string): string {
  const specials = "_*[]()~`>#+-=|{}.!\\";
  let out = "";
  for (const ch of input) {
    if (specials.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Factory used by the CLI adapter loader. It reads the environment itself so
 * the loader stays platform-agnostic.
 */
export function create(env: Record<string, string | undefined>): TelegramAdapter {
  const token = env.RC_TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("RC_TELEGRAM_BOT_TOKEN is not set");
  return new TelegramAdapter({
    token,
    ...(env.RC_TELEGRAM_API_BASE ? { apiBase: env.RC_TELEGRAM_API_BASE } : {}),
  });
}

/** Shape the CLI loader expects. */
export const id = "telegram";

/**
 * Slack adapter.
 *
 * Transport: **Socket Mode**. §2.2 rule 1 — outbound-only. Socket Mode dials
 * `wss://wss-primary.slack.com/link`, so there is no public URL, no ngrok and
 * no inbound port. This is the reason Slack is in scope at all despite §1
 * claiming every bridge is outbound-only; most chat platforms are not.
 *
 * Block Kit, not buttons-as-text: the three verdicts render as a message action
 * row, which is the Slack-native equivalent of Telegram inline keyboards.
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

export const SLACK_CAPABILITIES: AdapterCapabilities = {
  messaging: true,
  // Slack sends `block_actions` with a signed payload and a verified user id.
  permissionRelay: true,
  threads: true,
  richCards: true,
  // files.upload (V2) is available with the bot token.
  files: true,
};

export const SLACK_BLOCK_LIMIT = 3000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];

interface SlackEnvelope {
  envelope_id: string;
  type: "events_api" | "interactive" | "slash_commands";
  accepts_response_payload: boolean;
  payload: Record<string, unknown>;
}

export interface SlackAdapterOptions {
  readonly botToken: string;
  readonly appToken: string;
  readonly apiBase?: string;
  readonly socketUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly socketFactory?: (url: string) => WebSocket;
}

export class SlackAdapter implements Adapter {
  readonly id = "slack";
  readonly displayName = "Slack";
  readonly capabilities = SLACK_CAPABILITIES;

  private readonly botToken: string;
  private readonly appToken: string;
  private readonly apiBase: string;
  private readonly socketUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: (url: string) => WebSocket;

  private ctx: AdapterContext | undefined;
  private ws: WebSocket | undefined;
  private running = false;
  private attempt = 0;
  private botUserId = "";
  /** channel → thread ts. */
  private readonly threads = new Map<string, string>();

  constructor(opts: SlackAdapterOptions) {
    this.botToken = opts.botToken;
    this.appToken = opts.appToken;
    this.apiBase = opts.apiBase ?? "https://slack.com/api";
    this.socketUrl = opts.socketUrl ?? "wss://wss-primary.slack.com/link";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.socketFactory = opts.socketFactory ?? ((url) => new WebSocket(url));
  }

  private async api<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      retry_after?: number;
    } & T;
    if (!json.ok) {
      const err = new Error(`slack ${method}: ${json.error ?? "unknown"}`) as Error & {
        retryAfterMs?: number;
      };
      // Slack's retry_after is in seconds; the outbox wants ms.
      if (typeof json.retry_after === "number") err.retryAfterMs = json.retry_after * 1000;
      throw err;
    }
    return json;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.running = true;
    const auth = await this.api<{ user_id: string }>("auth.test").catch(() => ({ user_id: "" }));
    this.botUserId = auth.user_id;
    ctx.audit.append({
      event: "adapter.start",
      ns: "slack",
      fields: { botUserId: this.botUserId },
    });
    void this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ws?.close();
    this.ws = undefined;
    this.ctx?.audit.append({ event: "adapter.stop", ns: "slack" });
  }

  private async connect(): Promise<void> {
    while (this.running) {
      try {
        // apps.connections.open mints the wss URL. This is the only outbound
        // HTTPS call Slack Socket Mode needs.
        const { url } = await this.api<{ url: string }>("apps.connections.open");
        await this.openSocket(url);
        this.attempt = 0;
      } catch (err) {
        if (!this.running) return;
        this.ctx?.logger.warn("slack socket mode failed", { error: String(err) });
      }
      if (!this.running) return;
      const delay =
        RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)] ?? 30_000;
      this.attempt++;
      await sleep(delay);
    }
  }

  private openSocket(url: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = this.socketFactory(url);
      this.ws = ws;
      ws.onopen = () => this.ctx?.logger.info("slack socket mode connected");
      ws.onmessage = (raw) => {
        let envelope: SlackEnvelope;
        try {
          envelope = JSON.parse(String(raw.data)) as SlackEnvelope;
        } catch {
          return;
        }
        void this.onEnvelope(envelope);
      };
      ws.onerror = () => resolve();
      ws.onclose = () => resolve();
    });
  }

  private async onEnvelope(envelope: SlackEnvelope): Promise<void> {
    // Ack first. Slack retries an un-acked envelope and will disconnect us.
    this.ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));

    if (envelope.type === "events_api") return this.onEvent(envelope.payload);
    if (envelope.type === "interactive") return this.onAction(envelope.payload);
  }

  private async onEvent(payload: Record<string, unknown>): Promise<void> {
    const event = payload.event as Record<string, unknown> | undefined;
    if (!event) return;
    // The bot's own messages are echoed; ignore them.
    if (event.bot_id || event.subtype === "bot_message") return;

    const user = String(event.user ?? "");
    if (!user || user === this.botUserId) return;

    const text = String(event.text ?? "");
    if (!text.trim()) return;

    const channel = String(event.channel ?? "");
    const threadTs = event.thread_ts ? String(event.thread_ts) : undefined;

    const inbound: InboundMessage = {
      platform: this.id,
      messageId: String(event.client_msg_id ?? event.ts ?? ""),
      actor: { platform: this.id, id: user },
      chat: {
        platform: this.id,
        chatId: channel,
        ...(threadTs ? { threadId: threadTs } : {}),
      },
      // Slack has no mention marker in the event, so a top-level channel message
      // counts as addressing the bot and a thread reply always does.
      text: text.replace(/<@[A-Z0-9]+>/g, "").trim(),
      timestamp: event.ts ? Number(event.ts) * 1000 : Date.now(),
      isGroup: String(event.channel_type ?? "channel") !== "im",
      mentionsBot: true,
    };

    await this.ctx?.bridge.handle(inbound);
  }

  private async onAction(payload: Record<string, unknown>): Promise<void> {
    const actions = payload.actions as { action_id?: string; value?: string }[] | undefined;
    const user = payload.user as { id?: string; name?: string } | undefined;
    const channel = payload.channel as { id?: string } | undefined;
    const message = payload.message as { ts?: string } | undefined;
    const messageTs = message?.ts;

    const parsed = parseActionId(actions?.[0]?.action_id);
    if (!parsed) return;

    const actor = { platform: this.id, id: String(user?.id ?? ""), displayName: user?.name };
    this.ctx?.audit.append({
      event: "permission.tap",
      actor,
      ns: "slack",
      fields: { shortId: parsed.shortId, verdict: parsed.verdict },
    });

    const applied = (await this.ctx?.bridge.answerPermission(
      { platform: this.id, chatId: String(channel?.id ?? "") },
      parsed.shortId,
      parsed.verdict,
      actor,
    )) as boolean | undefined;

    if (applied && channel?.id) {
      await this.api("chat.update", {
        channel: channel.id,
        ts: messageTs,
        text: `✓ ${labelFor(parsed.verdict)} — ${parsed.shortId}`,
      }).catch(() => undefined);
    }
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  async send(msg: OutboundMessage): Promise<void> {
    const channel = msg.conversation.chatId;
    for (const card of msg.cards) {
      await this.render(channel, msg.conversation.threadId ?? this.threads.get(channel), card);
    }
  }

  /**
   * §7.4 layer 6 — upload a file. Slack's modern flow is two HTTPS calls:
   * `files.getUploadURLExternal` mints a URL, we PUT the bytes, then
   * `files.completeUploadExternal` shares it. The bridge has already run the
   * exfiltration guard.
   */
  async sendFile(
    conversation: { platform: string; chatId: string; threadId?: string },
    file: { path: string; name: string; caption?: string },
  ): Promise<void> {
    const bytes = await Bun.file(file.path).arrayBuffer();
    const urlResp = await this.api<{ upload_url: string; file_id: string }>(
      "files.getUploadURLExternal",
      { filename: file.name, length: bytes.byteLength },
    );
    const put = await this.fetchImpl(urlResp.upload_url, {
      method: "POST",
      body: bytes,
    });
    if (!put.ok) throw new Error(`slack upload PUT → ${put.status}`);
    await this.api("files.completeUploadExternal", {
      files: [{ id: urlResp.file_id, title: file.name }],
      channel_id: conversation.chatId,
      ...(conversation.threadId ? { thread_ts: conversation.threadId } : {}),
      ...(file.caption ? { initial_comment: file.caption } : {}),
    });
  }

  private async render(channel: string, threadTs: string | undefined, card: Card): Promise<void> {
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
        for (const chunk of chunkText(sanitizeText(text), SLACK_BLOCK_LIMIT)) {
          await this.post(channel, threadTs, chunk);
        }
        return;
      }
      case "status":
        await this.post(channel, threadTs, `· ${sanitizeText(card.label, 200)}`);
        return;
      case "diff": {
        const lines = card.files.map((f) => `\`${f.path}\` +${f.additions} −${f.deletions}`);
        await this.post(channel, threadTs, `Changes:\n${lines.join("\n")}`);
        return;
      }
      case "permission": {
        await this.post(
          channel,
          threadTs,
          `🔐 *Permission required* — \`${card.id}\`\n${sanitizeText(card.title, 600)}`,
          permissionBlocks(card.id),
        );
        return;
      }
    }
  }

  private async post(
    channel: string,
    threadTs: string | undefined,
    text: string,
    blocks?: unknown[],
  ): Promise<void> {
    await this.api("chat.postMessage", {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(blocks ? { blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

function permissionBlocks(shortId: string): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Choose a verdict for this request." },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve once" },
          action_id: actionId(shortId, "once"),
          value: shortId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Always" },
          action_id: actionId(shortId, "always"),
          value: shortId,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          action_id: actionId(shortId, "reject"),
          value: shortId,
        },
      ],
    },
  ];
}

export function actionId(shortId: string, verdict: "once" | "always" | "reject"): string {
  const map: Record<string, string> = { once: "y", always: "a", reject: "n" };
  return `rc_${map[verdict] ?? "n"}_${shortId}`;
}

export function parseActionId(
  value: string | undefined,
): { verdict: "once" | "always" | "reject"; shortId: string } | null {
  const m = /^rc_([yan])_([a-km-z]{5})$/.exec(value ?? "");
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function create(env: Record<string, string | undefined>): SlackAdapter {
  const botToken = env.RC_SLACK_BOT_TOKEN;
  const appToken = env.RC_SLACK_APP_TOKEN;
  if (!botToken || !appToken)
    throw new Error("RC_SLACK_BOT_TOKEN and RC_SLACK_APP_TOKEN are both required");
  return new SlackAdapter({
    botToken,
    appToken,
    ...(env.RC_SLACK_API_BASE ? { apiBase: env.RC_SLACK_API_BASE } : {}),
  });
}

export const id = "slack";

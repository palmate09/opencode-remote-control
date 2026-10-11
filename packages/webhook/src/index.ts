/**
 * Generic webhook adapter — the escape hatch.
 *
 * Anything that cannot justify a first-party adapter becomes a webhook:
 *
 *   POST /inbound   → text becomes a prompt
 *   POST /permission/<shortId>  → answers a pending permission
 *   POST /outbound  → an external system pushes a message in
 *   GET  /health    → liveness
 *
 * **This adapter cannot authenticate the person tapping a button**, because
 * there is no person and no identity provider behind a webhook URL. So
 * `permissionRelay` is `false` (§7.4 layer 7) and the `POST /permission`
 * endpoint is refused unless the operator explicitly opted in. The declaration
 * is the security assertion: an adapter that cannot authenticate the replier
 * must not advertise permission-relay capability.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
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

export const WEBHOOK_CAPABILITIES: AdapterCapabilities = {
  messaging: true,
  permissionRelay: false,
  threads: false,
  richCards: true,
};

const MAX_BODY_BYTES = 256 * 1024;

export interface WebhookAdapterOptions {
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  /**
   * Opt-in escape hatch for `POST /permission/<shortId>`. Off by default; see
   * the file header.
   *
   * Enabling it means asserting that you control every caller of this endpoint.
   * A bearer token proves the caller holds a shared secret; it does not prove
   * they are a person. That is why this is not merely a constant and why the
   * capability stays `false` regardless.
   */
  readonly allowPermissionRelay?: boolean;
  /** Overridable for tests. */
  readonly serve?: (opts: {
    port: number;
    hostname: string;
    fetch: (req: Request, server: Server) => Response | Promise<Response>;
  }) => Server;
}

export class WebhookAdapter implements Adapter {
  readonly id = "webhook";
  readonly displayName = "Webhooks";
  readonly capabilities = WEBHOOK_CAPABILITIES;

  private readonly token: string;
  private readonly host: string;
  private readonly port: number;
  private readonly allowPermissionRelay: boolean;
  private readonly serve: NonNullable<WebhookAdapterOptions["serve"]>;
  private server: Server | undefined;
  private ctx: AdapterContext | undefined;

  constructor(opts: WebhookAdapterOptions) {
    this.token = opts.token;
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 8788;
    this.allowPermissionRelay = opts.allowPermissionRelay === true;
    this.serve =
      opts.serve ??
      ((o) =>
        Bun.serve({
          port: o.port,
          hostname: o.hostname,
          fetch: o.fetch,
        }));
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.server = this.serve({
      port: this.port,
      hostname: this.host,
      fetch: (req) => this.route(req),
    });
    ctx.audit.append({
      event: "adapter.start",
      ns: "webhook",
      fields: { host: this.host, port: this.port, permissionRelay: this.allowPermissionRelay },
    });
    ctx.logger.warn(
      "webhook adapter binds a TCP port. Keep it on a private interface (Tailscale, loopback) — it has no origin protection beyond the shared token.",
    );
  }

  async stop(): Promise<void> {
    await this.server?.stop(false);
    this.server = undefined;
    this.ctx?.audit.append({ event: "adapter.stop", ns: "webhook" });
  }

  /** Constant-time bearer-token comparison. */
  private authorised(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    const expected = `Bearer ${this.token}`;
    const a = new TextEncoder().encode(header);
    const b = new TextEncoder().encode(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return json({ ok: true, adapter: this.id });
    }

    if (!this.authorised(req)) {
      this.ctx?.audit.append({
        event: "webhook.unauthorised",
        outcome: "drop",
        ns: "webhook",
        fields: { path: safeName(url.pathname, 80), method: req.method },
      });
      return json({ error: "unauthorised" }, 401);
    }

    const length = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return json({ error: "payload too large" }, 413);
    }

    try {
      if (url.pathname === "/inbound" && req.method === "POST") return this.inbound(req, url);
      const permission = /^\/permission\/([a-km-z]{5})$/.exec(url.pathname);
      if (permission && req.method === "POST") return this.permission(req, permission[1] as string);
      return json({ error: "not found" }, 404);
    } catch (err) {
      this.ctx?.logger.error("webhook handler failed", { error: String(err) });
      return json({ error: "internal" }, 500);
    }
  }

  private async inbound(req: Request, url: URL): Promise<Response> {
    const body = (await req.json().catch(() => null)) as {
      text?: string;
      actorId?: string;
      chatId?: string;
      isGroup?: boolean;
      mentionsBot?: boolean;
    } | null;
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return json({ error: "text is required" }, 400);
    }

    const actorId = safeName(body.actorId ?? "webhook", 80) || "webhook";
    const chatId = safeName(body.chatId ?? url.searchParams.get("chat") ?? actorId, 120) || actorId;

    const message: InboundMessage = {
      platform: this.id,
      messageId: req.headers.get("x-request-id") ?? randomUUID(),
      actor: { platform: this.id, id: actorId },
      chat: { platform: this.id, chatId },
      text: body.text,
      timestamp: Date.now(),
      isGroup: body.isGroup === true,
      // A webhook has no mention concept; the gate still applies, and the
      // operator's allowlist is what actually authorises this.
      mentionsBot: body.mentionsBot !== false,
    };

    await this.ctx?.bridge.handle(message);
    return json({ ok: true });
  }

  private async permission(req: Request, shortId: string): Promise<Response> {
    if (!this.allowPermissionRelay) {
      this.ctx?.audit.append({
        event: "permission.relay_refused",
        outcome: "drop",
        ns: "webhook",
        fields: { shortId, reason: "permissionRelay capability not declared" },
      });
      return json(
        {
          error:
            "permission relay is disabled for the webhook adapter. It cannot authenticate the replier, so it does not advertise the capability (SECURITY.md §anti-injection layer 7). Enable RC_WEBHOOK_PERMISSION_RELAY only if you control every caller.",
        },
        403,
      );
    }

    const body = (await req.json().catch(() => null)) as {
      verdict?: string;
      actorId?: string;
    } | null;
    const verdict = body?.verdict;
    if (verdict !== "once" && verdict !== "always" && verdict !== "reject") {
      return json({ error: "verdict must be once | always | reject" }, 400);
    }

    const chatId = safeName(body?.actorId ?? "webhook", 80) || "webhook";
    const applied = await this.ctx?.bridge.answerPermission(
      { platform: this.id, chatId },
      shortId,
      verdict,
      { platform: this.id, id: body?.actorId ?? "webhook" },
    );
    return json({ ok: applied === true });
  }

  async send(msg: OutboundMessage): Promise<void> {
    // Outbound delivery is opt-in and configured entirely by the operator.
    const url = process.env.RC_WEBHOOK_OUTBOUND_URL;
    if (!url) {
      this.ctx?.logger.debug("no RC_WEBHOOK_OUTBOUND_URL; webhook adapter is inbound-only", {
        chat: msg.conversation.chatId,
      });
      return;
    }
    const payload = {
      chat: msg.conversation.chatId,
      thread: msg.conversation.threadId ?? null,
      session: msg.sessionId ?? null,
      cards: msg.cards.map(plainCard),
    };
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        "x-opencode-rc-cards": String(payload.cards.length),
      },
      body: JSON.stringify(payload),
    });
  }
}

/** Cards travel to the webhook consumer as plain JSON — no platform markup. */
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

export function create(env: Record<string, string | undefined>): WebhookAdapter {
  const token = env.RC_WEBHOOK_TOKEN;
  if (!token) throw new Error("RC_WEBHOOK_TOKEN is not set");
  return new WebhookAdapter({
    token,
    ...(env.RC_WEBHOOK_HOST ? { host: env.RC_WEBHOOK_HOST } : {}),
    ...(env.RC_WEBHOOK_PORT ? { port: Number.parseInt(env.RC_WEBHOOK_PORT, 10) } : {}),
    allowPermissionRelay: env.RC_WEBHOOK_PERMISSION_RELAY === "true",
  });
}

export const id = "webhook";

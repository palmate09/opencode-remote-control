/**
 * The bridge: the object that owns the pipeline and implements
 * {@link BridgeHandle}. Adapters never see any of this — they call
 * `bridge.handle(message)` and `bridge.deliver(...)`.
 *
 * The pipeline for one inbound message:
 *
 *   gate → router → (permission | command | btw | prompt) → transport → renderer
 *        → outbox → adapter
 *
 * Everything interesting happens between those arrows, and every step writes an
 * audit record. Message *bodies* never do.
 */

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import { loadAccess } from "./config.js";
import { EventHub } from "./events.js";
import type { AuditLog, Logger } from "./logger.js";
import { createClassicTransport } from "./opencode.js";
import { Outbox } from "./outbox.js";
import { Gate, PairingManager } from "./pairing.js";
import { PermissionRegistry, parsePermissionReply } from "./permissions.js";
import { PrivacyService } from "./privacy.js";
import { Renderer } from "./renderer.js";
import { Retention } from "./retention.js";
import { Router } from "./router.js";
import {
  RefusingToSendError,
  assertSendable,
  inlineFrameSafe,
  safeName,
  sanitizeText,
} from "./sanitize.js";
import { SessionStore } from "./sessions.js";
import { ANTI_INJECTION_SYSTEM } from "./transport.js";
import type { BridgeEvent, OpencodeTransport } from "./transport.js";
import type {
  Adapter,
  AdapterContext,
  BridgeHandle,
  Card,
  InboundMessage,
  OutboundMessage,
  PermissionVerdict,
  PromptOptions,
  ResolvedRuntimeConfig,
} from "./types.js";
import { conversationKey } from "./types.js";

export interface BridgeOptions {
  readonly config: ResolvedRuntimeConfig;
  readonly logger: Logger;
  readonly salt: string;
  readonly transport?: OpencodeTransport;
  readonly now?: () => number;
  readonly adapter?: Adapter;
  /** Platform-specific chat limit, used for chunking. */
  readonly platformCharLimit?: number;
  readonly permissionTtlMs?: number;
  /** Per-platform minimum send gaps. The CLI has no flood limit. */
  readonly gapsByPlatform?: Readonly<Record<string, number>>;
  /** Override the global minimum gap. Tests set this to 0. */
  readonly minGapMs?: number;
}

const PERMISSION_TTL_MS = 15 * 60_000;

/** §7.6 — circuit breaker on chained follow-ups. */
const MAX_CHAIN_DEPTH = 8;

export class Bridge implements BridgeHandle {
  readonly config: ResolvedRuntimeConfig;
  readonly logger: Logger;
  readonly transport: OpencodeTransport;
  readonly sessions: SessionStore;
  readonly permissions: PermissionRegistry;
  readonly pairing: PairingManager;
  readonly gate: Gate;
  readonly router: Router;
  readonly renderer: Renderer;
  readonly events: EventHub;
  readonly outbox: Outbox;
  readonly privacy: PrivacyService;
  readonly retention: Retention;
  readonly audit: AuditLog;

  private adapter: Adapter | undefined;
  private adapterContext: AdapterContext | undefined;
  private readonly now: () => number;
  private readonly platformCharLimit: number;
  private readonly permissionTtlMs: number;
  /** conversationKey → queued `btw` follow-ups. */
  private readonly followUps = new Map<string, string[]>();
  private readonly chainDepth = new Map<string, number>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly notificationsThisRun = new Map<string, number>();
  private readonly capNoticeSent = new Set<string>();
  private readonly shutdown = new AbortController();

  constructor(opts: BridgeOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.platformCharLimit = opts.platformCharLimit ?? 4096;
    this.permissionTtlMs = opts.permissionTtlMs ?? PERMISSION_TTL_MS;
    this.adapter = opts.adapter;

    this.audit = opts.logger.auditLog;

    this.transport =
      opts.transport ??
      createClassicTransport(
        {
          baseUrl: opts.config.opencodeUrl,
          ...(opts.config.opencodeUsername ? { username: opts.config.opencodeUsername } : {}),
          ...(opts.config.opencodePassword ? { password: opts.config.opencodePassword } : {}),
          ...(opts.config.projectDir ? { directory: opts.config.projectDir } : {}),
        },
        { logger: opts.logger },
      );

    this.sessions = new SessionStore({
      stateDir: opts.config.stateDir,
      now: this.now,
      maxConcurrent: opts.config.maxConcurrentSessions,
    });
    this.permissions = new PermissionRegistry({
      audit: this.audit,
      ttlMs: this.permissionTtlMs,
      now: this.now,
    });
    this.pairing = new PairingManager(opts.config.stateDir, this.audit, this.now);
    this.router = new Router();
    this.renderer = new Renderer();
    this.events = new EventHub({ transport: this.transport, logger: opts.logger });
    this.outbox = new Outbox((msg) => this.dispatchOutbound(msg), {
      logger: opts.logger,
      gapsByPlatform: opts.gapsByPlatform ?? { cli: 0, mcp: 0 },
      ...(opts.minGapMs !== undefined ? { minGapMs: opts.minGapMs } : {}),
    });
    this.gate = new Gate(this.pairing, this.audit, () => loadAccess(opts.config.stateDir));
    this.privacy = new PrivacyService({
      stateDir: opts.config.stateDir,
      audit: this.audit,
      sessions: this.sessions,
      permissions: this.permissions,
      access: { allowFrom: loadAccess(opts.config.stateDir).allowFrom },
      retentionDays: {
        debug: opts.config.logRetentionDays,
        audit: opts.config.auditRetentionDays,
      },
      // §8.5 — erasure must actually erase. Without this callback `/forget`
      // removed session mappings but left every audit record for the actor on
      // disk, so the export still returned them and the erasure was a lie.
      purgeAuditForActor: (hashedId) => this.audit.purgeActor(hashedId),
    });
    this.retention = new Retention({
      logger: opts.logger.child("retention"),
      logDir: opts.config.logDir,
      auditPath: join(opts.config.logDir, "audit.jsonl"),
      logRetentionDays: opts.config.logRetentionDays,
      auditRetentionDays: opts.config.auditRetentionDays,
      pairing: this.pairing,
      permissions: this.permissions,
      // Let retention re-seat the live chain tail rather than rewrite the file
      // underneath it. §8.6.
      audit: this.audit,
      now: this.now,
    });
  }

  attach(adapter: Adapter): void {
    this.adapter = adapter;
  }

  /** The context handed to every adapter. Valid once `start()` has resolved. */
  context(): AdapterContext {
    if (!this.adapterContext) {
      throw new Error("Bridge.start() must be awaited before adapters start");
    }
    return this.adapterContext;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * §2.4 — the global-flag carry-over guard. Claude refuses to start if a
   * session would inherit a flag that changes what it can do. If opencode's
   * permission mode is not `ask`, we refuse to start and name the setting.
   *
   * **Fail closed.** "Could not determine the mode" is not "the mode is ask" —
   * if we cannot prove the agent will ask before acting, we do not start. The
   * two failure modes are distinguished in the message, because they have
   * different fixes:
   *
   *   - mode is a real value that is not "ask"  → fix the opencode config
   *   - mode is unreadable or absent            → set RC_PROJECT_DIR so we can
   *                                              read the right project's config
   *
   * `RC_REQUIRE_PERMISSION_ASK=false` is the documented escape hatch for an
   * operator who has deliberately accepted the risk.
   */
  async verifyPreconditions(): Promise<void> {
    if (!this.config.requirePermissionAsk) {
      this.logger.warn("permission-mode guard disabled by RC_REQUIRE_PERMISSION_ASK");
      return;
    }

    const mode = await this.transport.permissionMode(this.config.projectDir);

    if (mode === undefined) {
      const remedy = this.config.projectDir
        ? `Check that opencode is serving ${this.config.projectDir} and that its config contains a "permission" setting. Set RC_PROJECT_DIR to the project you intend to drive.`
        : "Set RC_PROJECT_DIR to the project you intend to drive, so the correct config is read. If you have deliberately accepted the risk, set RC_REQUIRE_PERMISSION_ASK=false.";
      throw new PreconditionError(
        "Could not determine opencode's permission mode, so opencode-rc cannot confirm that it will ask before acting.",
        remedy,
      );
    }

    if (mode !== "ask") {
      throw new PreconditionError(
        `opencode's permission mode is "${mode}", but opencode-rc requires "ask". ` +
          `With "${mode}" the agent can act without your approval, which defeats the point of a remote control.`,
        'Set `permission = "ask"` (or `permission = { "*": "ask" }`) in your opencode config — ' +
          "opencode.json in the project directory, or ~/.config/opencode/opencode.json.",
      );
    }

    this.logger.info("permission mode verified", { mode });
  }

  async start(): Promise<void> {
    this.retention.purge();
    this.retention.start();
    await this.events.start();
    this.adapterContext = {
      config: this.config,
      logger: this.logger,
      audit: this.audit,
      sessions: this.sessions,
      permissions: this.permissions,
      bridge: this,
      hub: this.events,
      outbox: this.outbox,
    };
    this.events.subscribe((event) => this.onBridgeEvent(event));
    this.audit.append({
      event: "bridge.started",
      ns: "bridge",
      fields: {
        opencode: this.transport.baseUrl,
        surface: this.transport.surface,
        adapters: this.adapter ? [this.adapter.id] : [],
        disabled: this.config.access.disabled,
      },
    });
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    this.events.stop();
    this.retention.stop();
    await this.outbox.stop();
    for (const c of this.abortControllers.values()) c.abort();
    this.transport.close();
    this.audit.append({ event: "bridge.stopped", ns: "bridge" });
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  private async dispatchOutbound(msg: OutboundMessage): Promise<void> {
    if (!this.adapter) {
      this.logger.debug("no adapter attached, dropping outbound", {
        chat: conversationKey(msg.conversation),
      });
      return;
    }
    await this.adapter.send(msg);
  }

  async deliver(
    conversation: { platform: string; chatId: string; threadId?: string },
    cards: readonly Card[],
    correlation?: string,
  ): Promise<void> {
    const key = conversationKey(conversation);
    // §7.6 — cap notifications per run. Once the cap is hit we say so exactly
    // once and then stay silent, so a runaway run cannot keep filling the
    // phone with "limit reached" messages.
    const sent = this.notificationsThisRun.get(key) ?? 0;
    if (sent >= this.config.maxNotificationsPerRun) {
      if (this.capNoticeSent.has(key)) return;
      this.capNoticeSent.add(key);
      this.logger.warn("notification cap reached", {
        chat: key,
        cap: this.config.maxNotificationsPerRun,
      });
      this.outbox.push({
        conversation,
        cards: [
          {
            kind: "notice",
            text: "Notification limit reached for this run. Use `/status` for the full picture.",
          },
        ],
        ...(correlation ? { correlation } : {}),
      });
      return;
    }
    this.notificationsThisRun.set(key, sent + 1);
    this.outbox.push({ conversation, cards, ...(correlation ? { correlation } : {}) });
  }

  /**
   * §7.4 layer 6 — relay a file, subject to the state-exfiltration guard.
   *
   * The guard is the reason this is a bridge method and not something an adapter
   * does itself: it must run before *any* adapter sees the path, so no adapter
   * can be the weak link. `access.json`, `.env`, the audit salt and everything
   * else under the state directory are refused here or nowhere.
   */
  async sendFile(
    conversation: { platform: string; chatId: string; threadId?: string },
    path: string,
    caption?: string,
  ): Promise<boolean> {
    const adapter = this.adapter;
    if (!adapter?.capabilities.files || !adapter.sendFile) {
      await this.deliver(conversation, [
        {
          kind: "notice",
          text: "Sending files is not supported by this adapter.",
        },
      ]);
      return false;
    }

    let real: string;
    try {
      await assertSendable(path, this.config.stateDir, { mustExist: true });
      // Adapters open the file themselves, so hand them an absolute, symlink-
      // resolved path — the same one the guard just approved.
      real = await realpath(path).catch(() => resolve(path));
    } catch (err) {
      const reason = err instanceof RefusingToSendError ? err.message : String(err);
      this.audit.append({
        event: "file.send_refused",
        outcome: "drop",
        ns: "sanitize",
        fields: { reason, path: safeName(path, 200) },
      });
      await this.deliver(conversation, [
        {
          kind: "notice",
          text: "Refused to send that file: it is inside the state directory, which holds credentials and the audit log. Put files to share in the state `inbox/` directory.",
        },
      ]);
      return false;
    }

    const name = safeName(basename(real), 120) || "file";
    this.audit.append({
      event: "file.sent",
      outcome: "allow",
      ns: "bridge",
      fields: { name, path: safeName(real, 200) },
    });
    try {
      await adapter.sendFile(conversation, {
        path: real,
        name,
        ...(caption ? { caption: sanitizeText(caption, 500) } : {}),
      });
      return true;
    } catch (err) {
      this.audit.append({
        event: "file.send_failed",
        outcome: "error",
        ns: "bridge",
        fields: { name, error: sanitizeText(String(err), 300) },
      });
      await this.deliver(conversation, [
        { kind: "error", message: `Could not send the file: ${sanitizeText(String(err), 300)}` },
      ]);
      return false;
    }
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  async handle(message: InboundMessage): Promise<void> {
    const verdict = this.gate.check(message);

    switch (verdict.action) {
      case "drop":
        return;
      case "pair": {
        await this.deliverPairingPrompt(message, verdict.code, verdict.expiresAt, verdict.budget);
        return;
      }
      case "deliver":
        break;
    }

    // The gate let it through; from here we trust the sender but still treat
    // the text as untrusted input.
    const intent = this.router.route(message);
    this.audit.append({
      event: "message.received",
      actor: message.actor,
      session: this.sessions.get(message.chat)?.sessionId,
      ns: "router",
      fields: {
        intent: intent.kind,
        length: Array.from(message.text ?? "").length,
        correlation: newCorrelationId(),
      },
    });

    switch (intent.kind) {
      case "ignore":
        return;
      case "permission":
        await this.answerPermission(message.chat, intent.shortId, intent.verdict, message.actor);
        return;
      case "command":
        await this.runCommand(message, intent.name, intent.args);
        return;
      case "btw":
        this.queueFollowUp(message, intent.text);
        return;
      case "prompt":
        await this.runPrompt(message, intent.text);
        return;
    }
  }

  private async deliverPairingPrompt(
    message: InboundMessage,
    code: string,
    expiresAt: number,
    budget: number,
  ): Promise<void> {
    if (budget <= 0) {
      this.logger.debug("pairing reply budget exhausted, staying silent", {
        platform: message.platform,
      });
      return;
    }
    this.pairing.recordReply(code);
    const minutes = Math.max(1, Math.round((expiresAt - this.now()) / 60_000));
    await this.deliver(message.chat, [
      {
        kind: "notice",
        text: sanitizeText(
          `This conversation is not authorised yet.\n\nTo pair, run this at the terminal on the machine running opencode-rc:\n\n    rc access allow ${code}\n\nThe code expires in ${minutes} minute${minutes === 1 ? "" : "s"}. A bot cannot approve itself — this step is the security boundary.`,
        ),
      },
    ]);
  }

  private queueFollowUp(message: InboundMessage, text: string): void {
    const key = conversationKey(message.chat);
    const queue = this.followUps.get(key) ?? [];
    queue.push(text);
    this.followUps.set(key, queue);
    this.audit.append({
      event: "followup.queued",
      actor: message.actor,
      ns: "bridge",
      fields: { depth: queue.length },
    });
    this.deliver(message.chat, [
      {
        kind: "notice",
        text: `Queued (${queue.length} pending). It will run when the current work finishes.`,
      },
    ]);
  }

  // ── the run loop ─────────────────────────────────────────────────────────

  async prompt(
    conversation: { platform: string; chatId: string; threadId?: string },
    text: string,
    opts: PromptOptions = {},
  ): Promise<string> {
    const key = conversationKey(conversation);
    const correlation = opts.correlation ?? newCorrelationId();

    let binding = this.sessions.get(conversation);
    if (!binding) {
      const created = await this.transport.createSession({
        title: conversation.chatId.slice(0, 80),
        ...(this.config.projectDir ? { directory: this.config.projectDir } : {}),
      });
      binding = this.sessions.bind(
        conversation,
        created.id,
        created.title || created.id,
        this.config.projectDir,
      );
      this.audit.append({
        event: "session.created",
        session: created.id,
        correlation,
        ns: "sessions",
        fields: { reason: "first prompt" },
      });
    }

    const controller = new AbortController();
    this.abortControllers.set(binding.sessionId, controller);
    this.sessions.setBusy(conversation, true, correlation);
    this.notificationsThisRun.set(key, 0);
    this.capNoticeSent.delete(key);

    this.audit.append({
      event: "prompt.sent",
      session: binding.sessionId,
      correlation,
      ns: "bridge",
      fields: {
        length: Array.from(text).length,
        model: opts.model ? `${opts.model.providerID}/${opts.model.modelID}` : undefined,
      },
    });

    try {
      await this.transport.prompt({
        sessionId: binding.sessionId,
        text,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.agent ? { agent: opts.agent } : {}),
        // §7.4 layer 1 — every relayed session carries the anti-injection rule.
        system: ANTI_INJECTION_SYSTEM,
        signal: controller.signal,
      });
      return binding.sessionId;
    } catch (err) {
      this.sessions.setBusy(conversation, false);
      this.audit.append({
        event: "prompt.failed",
        session: binding.sessionId,
        correlation,
        outcome: "error",
        ns: "bridge",
        fields: { error: String(err) },
      });
      await this.deliver(
        conversation,
        [{ kind: "error", message: `Could not send: ${String(err)}` }],
        correlation,
      );
      throw err;
    } finally {
      this.abortControllers.delete(binding.sessionId);
    }
  }

  async newSession(
    conversation: { platform: string; chatId: string; threadId?: string },
    title?: string,
  ): Promise<string> {
    const key = conversationKey(conversation);
    const existing = this.sessions.get(conversation);
    if (existing) {
      await this.abort(conversation).catch(() => {});
      this.sessions.forget(conversation);
      this.permissions.forgetSession(existing.sessionId);
    }

    const session = await this.transport.createSession({
      ...(title ? { title } : {}),
      ...(this.config.projectDir ? { directory: this.config.projectDir } : {}),
    });
    this.sessions.bind(
      conversation,
      session.id,
      session.title || session.id,
      this.config.projectDir,
    );
    this.audit.append({
      event: "session.created",
      session: session.id,
      ns: "sessions",
      fields: { reason: "explicit /new", previous: existing?.sessionId ?? null, key },
    });
    return session.id;
  }

  /** `/abort` always works, regardless of the cost-control breaker. §7.6. */
  async abort(conversation: {
    platform: string;
    chatId: string;
    threadId?: string;
  }): Promise<void> {
    const binding = this.sessions.get(conversation);
    if (!binding) {
      await this.deliver(conversation, [{ kind: "notice", text: "No session here to abort." }]);
      return;
    }
    this.abortControllers.get(binding.sessionId)?.abort();
    await this.transport.abort(binding.sessionId);
    this.sessions.setBusy(conversation, false);
    this.renderer.discard(binding.sessionId);
    this.audit.append({
      event: "run.aborted",
      session: binding.sessionId,
      ns: "bridge",
      fields: { chat: conversationKey(conversation) },
    });
    await this.deliver(conversation, [{ kind: "notice", text: "Stopped." }]);
  }

  async answerPermission(
    conversation: { platform: string; chatId: string; threadId?: string },
    shortId: string,
    verdict: PermissionVerdict,
    actor?: { platform: string; id: string },
  ): Promise<boolean> {
    const entry = this.permissions.claim(
      shortId,
      actor ? `${actor.platform}:${actor.id}` : "unknown",
    );
    if (!entry) {
      await this.deliver(conversation, [
        { kind: "notice", text: "That permission request is no longer open — nothing changed." },
      ]);
      return false;
    }

    const binding = this.sessions.get(conversation);
    const chat = binding?.conversation ?? conversation;

    try {
      await this.transport.answerPermission(entry.sessionId, entry.permissionId, verdict);
      this.permissions.markAnswered(shortId, verdict);
      this.audit.append({
        event: "permission.answered",
        ...(actor ? { actor } : {}),
        session: entry.sessionId,
        outcome: verdict === "reject" ? "deny" : "allow",
        ns: "permissions",
        fields: { shortId, tool: entry.tool, verdict },
      });
      await this.deliver(chat, [
        {
          kind: "notice",
          text:
            verdict === "reject"
              ? "Denied."
              : verdict === "always"
                ? "Approved, and remembered."
                : "Approved once.",
        },
      ]);
      return true;
    } catch (err) {
      this.permissions.release(shortId);
      this.audit.append({
        event: "permission.answer_failed",
        ...(actor ? { actor } : {}),
        session: entry.sessionId,
        outcome: "error",
        ns: "permissions",
        fields: { shortId, error: String(err) },
      });
      await this.deliver(chat, [
        { kind: "error", message: "Could not deliver that answer to opencode." },
      ]);
      return false;
    }
  }

  // ── commands ─────────────────────────────────────────────────────────────

  private async runCommand(message: InboundMessage, name: string, args: string[]): Promise<void> {
    const chat = message.chat;
    const binding = this.sessions.get(chat);

    switch (name) {
      case "new":
        await this.newSession(chat, args.join(" ") || undefined);
        await this.deliver(chat, [{ kind: "notice", text: "New session started." }]);
        return;

      case "sessions": {
        const list = this.sessions
          .list()
          .filter((b) => b.conversation.platform === message.platform);
        if (list.length === 0) {
          await this.deliver(chat, [
            { kind: "notice", text: "No sessions yet. Send /new to start one." },
          ]);
          return;
        }
        // §7.4 layer 4 — the title comes from `/new <title>`, so it is attacker-
        // controlled. `sanitizeText` folds whitespace but preserves `\n`, so a
        // title could forge an adjacent row; `inlineFrameSafe` collapses the
        // newline to a visible ⏎ marker instead.
        const lines = list
          .slice(0, 20)
          .map(
            (b) =>
              `${b.busy ? "●" : "○"} \`${inlineFrameSafe(b.sessionId, 40)}\` ${inlineFrameSafe(b.title, 60)}` +
              ` — ${inlineFrameSafe(b.conversation.chatId, 40)}`,
          );
        await this.deliver(chat, [{ kind: "text", markdown: `Sessions:\n${lines.join("\n")}` }]);
        return;
      }

      case "status": {
        if (!binding) {
          await this.deliver(chat, [{ kind: "notice", text: "No session in this chat yet." }]);
          return;
        }
        const pending = this.permissions.listForSession(binding.sessionId);
        await this.deliver(chat, [
          this.renderer.sessionStatus({
            sessionId: binding.sessionId,
            state: binding.busy ? "busy" : "idle",
            title: binding.title,
          }),
          {
            kind: "notice",
            text: `pending permissions: ${pending.length} · queued follow-ups: ${(this.followUps.get(conversationKey(chat)) ?? []).length}`,
          },
        ]);
        return;
      }

      case "diff": {
        if (!binding) {
          await this.deliver(chat, [{ kind: "notice", text: "No session in this chat yet." }]);
          return;
        }
        try {
          const files = await this.transport.diff(binding.sessionId);
          await this.deliver(chat, [{ kind: "text", markdown: this.renderer.diffSummary(files) }]);
        } catch (err) {
          await this.deliver(chat, [
            { kind: "error", message: `Could not read the diff: ${String(err)}` },
          ]);
        }
        return;
      }

      case "abort":
        await this.abort(chat);
        return;

      case "model": {
        if (args.length === 0) {
          const models = await this.transport.models().catch(() => []);
          const lines = models
            .slice(0, 30)
            .map((m) => `\`${sanitizeText(`${m.providerID}/${m.modelID}`, 80)}\``);
          await this.deliver(chat, [
            {
              kind: "text",
              markdown: `Models you can use (${models.length}):\n${lines.join("\n") || "(none reported)"}`,
            },
            { kind: "notice", text: "Pick one with `/model <provider>/<model>`." },
          ]);
          return;
        }

        const combined = args.join(" ");
        const parsed = parseModelRef(combined, this.pendingModel.get(conversationKey(chat)));
        if (!parsed.ok) {
          await this.deliver(chat, [{ kind: "notice", text: parsed.error }]);
          return;
        }
        this.pendingModel.set(conversationKey(chat), {
          providerID: parsed.value.providerID,
          modelID: parsed.value.modelID,
        });
        await this.deliver(chat, [
          {
            kind: "notice",
            text: `Model set to \`${sanitizeText(`${parsed.value.providerID}/${parsed.value.modelID}`, 80)}\` for the next prompt.`,
          },
        ]);
        return;
      }

      case "projects": {
        await this.deliver(chat, [
          { kind: "notice", text: `opencode is serving ${this.config.opencodeUrl}` },
        ]);
        if (this.config.projectDir) {
          await this.deliver(chat, [
            { kind: "notice", text: `project: ${sanitizeText(this.config.projectDir, 200)}` },
          ]);
        }
        return;
      }

      case "privacy":
        await this.deliver(chat, [
          { kind: "text", markdown: `\`\`\`\n${this.privacy.notice()}\n\`\`\`` },
        ]);
        return;

      case "export": {
        const format =
          args.includes("--format") && args[args.indexOf("--format") + 1] === "ndjson"
            ? "ndjson"
            : "json";
        const data = this.privacy.exportData(message.actor, format);
        this.audit.append({
          event: "privacy.export",
          actor: message.actor,
          outcome: "allow",
          ns: "privacy",
          fields: { format },
        });
        await this.deliver(chat, [{ kind: "text", markdown: `\`\`\`json\n${data}\n\`\`\`` }]);
        return;
      }

      case "forget": {
        const purgeOnly = args.includes("--purge-only");
        const all = args.includes("--all");
        const sessionIdx = args.indexOf("--session");
        const session = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;
        const result = this.privacy.forget(message.actor, {
          ...(session ? { session } : {}),
          purgeOnly,
          all,
        });
        await this.deliver(chat, [
          {
            kind: "notice",
            text: `Forgotten: ${result.sessionsRemoved} session mapping(s), ${result.auditRemoved} audit record(s).${result.consentWithdrawn ? " Consent withdrawn." : ""}`,
          },
        ]);
        return;
      }

      case "cancel": {
        const key = conversationKey(chat);
        const dropped = this.followUps.get(key)?.length ?? 0;
        this.followUps.delete(key);
        await this.deliver(chat, [
          {
            kind: "notice",
            text: dropped ? `Dropped ${dropped} queued message(s).` : "Nothing queued.",
          },
        ]);
        return;
      }

      case "send": {
        const raw = args.join(" ").trim();
        if (!raw) {
          await this.deliver(chat, [
            {
              kind: "notice",
              text: "Usage: `/send <path>`. A relative path is resolved against the state `inbox/` directory. Files elsewhere are refused unless they exist and are outside the state directory.",
            },
          ]);
          return;
        }
        // A relative path is relative to inbox/, which is the one part of the
        // state directory the guard permits.
        const path = isAbsolute(raw) ? raw : join(this.config.stateDir, "inbox", raw);
        await this.sendFile(chat, path);
        return;
      }

      case "help":
      case "start": {
        const lines = this.router.help().map((h) => `${h.usage}\n    ${h.summary}`);
        await this.deliver(chat, [
          { kind: "text", markdown: lines.join("\n") },
          {
            kind: "notice",
            text: "Everything except message bodies is logged. `rc audit verify` checks the chain.",
          },
        ]);
        return;
      }

      default:
        await this.deliver(chat, [
          { kind: "notice", text: `Unknown command /${name}. Try /help.` },
        ]);
    }
  }

  private readonly pendingModel = new Map<string, { providerID: string; modelID: string }>();

  private async runPrompt(message: InboundMessage, text: string): Promise<void> {
    const key = conversationKey(message.chat);
    const binding = this.sessions.get(message.chat);

    if (binding?.busy) {
      // §7.5: a second prompt while busy is queued, not dropped.
      this.queueFollowUp(message, text);
      return;
    }

    const model = this.pendingModel.get(key);
    if (model) this.pendingModel.delete(key);

    await this.prompt(message.chat, text, model ? { model } : {});
  }

  // ── event handling ───────────────────────────────────────────────────────

  private onBridgeEvent(event: BridgeEvent): void {
    void this.handleBridgeEvent(event).catch((err) => {
      this.logger.error("event handling failed", { error: String(err) });
    });
  }

  private async handleBridgeEvent(event: BridgeEvent): Promise<void> {
    switch (event.type) {
      case "message.part": {
        const binding = this.sessions.getBySessionId(event.sessionId);
        if (!binding) return;

        // opencode echoes the user's own prompt back on the same event that
        // carries the reply. Relaying that would make the bot answer the user
        // with their own words.
        if (event.part.role === "user") return;

        const toolCard = this.renderer.toolStatus(event.sessionId, event.part);
        if (toolCard) {
          await this.deliver(binding.conversation, [toolCard], binding.correlation);
          return;
        }
        const card = this.renderer.pushDelta(event.sessionId, event.part, event.delta);
        if (card) await this.deliver(binding.conversation, [card], binding.correlation);
        return;
      }

      case "permission.asked": {
        const binding = this.sessions.getBySessionId(event.request.sessionId);
        if (!binding) {
          this.logger.warn("permission for an unknown session", {
            session: event.request.sessionId,
          });
          return;
        }
        const entry = this.permissions.register({
          permissionId: event.request.id,
          sessionId: event.request.sessionId,
          title: event.request.title,
          tool: event.request.type,
        });
        await this.deliver(
          binding.conversation,
          [this.renderer.permission(event.request, entry.shortId, this.permissionTtlMs)],
          binding.correlation,
        );
        return;
      }

      case "permission.replied": {
        // Guard against double-tap: opencode already resolved it.
        const entry = this.permissions.byOpencode(event.reply.permissionId);
        if (entry) {
          this.permissions.markAnswered(entry.shortId, normaliseVerdict(event.reply.response));
          this.audit.append({
            event: "permission.confirmed",
            session: entry.sessionId,
            outcome: event.reply.response === "reject" ? "deny" : "allow",
            ns: "permissions",
            fields: { shortId: entry.shortId, response: event.reply.response },
          });
        }
        return;
      }

      case "session.idle": {
        const binding = this.sessions.getBySessionId(event.sessionId);
        if (!binding) return;
        const final = this.renderer.flush(event.sessionId);
        if (final) await this.deliver(binding.conversation, [final], binding.correlation);
        this.sessions.setBusy(binding.conversation, false);
        this.audit.append({
          event: "run.completed",
          session: event.sessionId,
          correlation: binding.correlation,
          outcome: "allow",
          ns: "bridge",
          fields: { chat: conversationKey(binding.conversation) },
        });
        await this.drainFollowUps(
          binding.conversation,
          this.chainDepth.get(conversationKey(binding.conversation)) ?? 0,
        );
        return;
      }

      case "session.error": {
        const binding = this.sessions.getBySessionId(event.sessionId);
        const chat = binding?.conversation;
        this.audit.append({
          event: "run.failed",
          session: event.sessionId,
          outcome: "error",
          ns: "bridge",
          fields: { error: sanitizeText(event.message, 300) },
        });
        if (chat) {
          this.sessions.setBusy(chat, false);
          await this.deliver(
            chat,
            [{ kind: "error", message: event.message }],
            binding?.correlation,
          );
        }
        return;
      }

      case "session.deleted":
        this.sessions.forgetSession(event.sessionId);
        this.permissions.forgetSession(event.sessionId);
        this.audit.append({ event: "session.deleted", session: event.sessionId, ns: "sessions" });
        return;

      default:
        return;
    }
  }

  private async drainFollowUps(
    conversation: { platform: string; chatId: string; threadId?: string },
    depth = 0,
  ): Promise<void> {
    const key = conversationKey(conversation);
    const queued = this.followUps.get(key);
    if (!queued || queued.length === 0) return;
    if (depth >= MAX_CHAIN_DEPTH) {
      this.followUps.delete(key);
      this.audit.append({
        event: "followup.chain_aborted",
        outcome: "drop",
        ns: "bridge",
        fields: { depth, reason: "circuit breaker" },
      });
      await this.deliver(conversation, [
        { kind: "notice", text: "Stopped chaining follow-ups to avoid an agent loop." },
      ]);
      return;
    }
    const next = queued.shift();
    if (queued.length === 0) this.followUps.delete(key);
    if (!next) return;

    this.audit.append({
      event: "followup.dispatched",
      ns: "bridge",
      fields: { remaining: queued.length },
    });
    // Wait for this one to complete before draining the next, so an agent loop
    // cannot run away. The chain breaker above bounds the total.
    this.chainDepth.set(key, depth + 1);
    await this.prompt(conversation, next).catch((err) => {
      this.logger.error("follow-up dispatch failed", { error: String(err) });
    });
  }
}

/**
 * Parses a `/model` argument into a provider and model id.
 *
 * The naive `split("/")` is wrong, and being wrong here means sending a model
 * that does not exist: opencode model ids themselves contain slashes, e.g.
 * `openrouter/anthropic/claude-haiku-4-5`. Splitting that gives provider
 * `openrouter` and model `anthropic`, which opencode rejects at prompt time
 * with an error the user cannot connect to their input.
 *
 * Resolution:
 *   - exact match against a known provider+model wins;
 *   - otherwise take the first segment as the provider and the rest as the
 *     model, which handles the common `provider/model` case;
 *   - otherwise the model may contain a slash and the provider must be inferred
 *     from the current selection.
 */
export function parseModelRef(
  input: string,
  current?: { providerID: string; modelID: string },
  known?: readonly { providerID: string; modelID: string }[],
): { ok: true; value: { providerID: string; modelID: string } } | { ok: false; error: string } {
  const ref = String(input ?? "")
    .trim()
    .replace(/^`|`$/g, "");
  if (!ref) return { ok: false, error: "Use `/model <provider>/<model>`." };

  if (known && known.length > 0) {
    const exact = known.find((m) => `${m.providerID}/${m.modelID}` === ref);
    if (exact) return { ok: true, value: { providerID: exact.providerID, modelID: exact.modelID } };
  }

  const slash = ref.indexOf("/");
  if (slash > 0 && slash < ref.length - 1) {
    return {
      ok: true,
      value: { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) },
    };
  }

  // No slash at all: the whole thing is a model id under the current provider.
  if (current?.providerID) {
    return { ok: true, value: { providerID: current.providerID, modelID: ref } };
  }
  return {
    ok: false,
    error: `Could not tell which provider "${ref}" belongs to. Use \`/model <provider>/<model>\`.`,
  };
}

export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(`${message}\n  ${remedy}`);
  }
}

function normaliseVerdict(response: string): PermissionVerdict {
  const r = response.toLowerCase();
  if (r === "always") return "always";
  if (r === "once" || r === "allow") return "once";
  return "reject";
}

export function newCorrelationId(): string {
  return randomBytes(4).toString("hex");
}

export { parsePermissionReply };

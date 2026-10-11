/**
 * Shared types for opencode-rc.
 *
 * RULE 2 (§5.2): nothing in core may reference a concrete platform. Adapters
 * translate between their own wire format and these types. `platform` is an
 * opaque string owned by the adapter — core only ever compares it for equality
 * and for building the per-chat rate-limit keys.
 */

export type PlatformId = string;

export type Outcome = "allow" | "deny" | "drop" | "error";

export interface Actor {
  /** Adapter-defined platform identifier, e.g. "telegram". */
  readonly platform: PlatformId;
  /** Raw platform user id. Hashed before it is written to the audit log. */
  readonly id: string;
  /** Optional display name. Sanitised and never written to the audit log. */
  readonly displayName?: string;
}

/**
 * Identifies the conversation an inbound message came from and an outbound
 * message must go back to. `threadId` is optional so a platform without threads
 * simply omits it.
 */
export interface ConversationRef {
  readonly platform: PlatformId;
  readonly chatId: string;
  readonly threadId?: string;
}

export function conversationKey(ref: ConversationRef): string {
  return `${ref.platform}:${ref.chatId}${ref.threadId ? `:${ref.threadId}` : ""}`;
}

export interface InboundMessage {
  readonly platform: PlatformId;
  /** Platform message id. Used for idempotency: a redelivered update is ignored. */
  readonly messageId: string;
  readonly actor: Actor;
  readonly chat: ConversationRef;
  /** Raw, unsanitised user text. `sanitize.sanitizeText()` runs before relay. */
  readonly text: string;
  /** Epoch millis as reported by the platform. */
  readonly timestamp: number;
  /** True for group/supergroup/channel chats, false for DMs. */
  readonly isGroup: boolean;
  /** True when the bot itself was @mentioned. Required by the mention gate. */
  readonly mentionsBot: boolean;
  /** Optional handle the adapter wants replies threaded under. */
  readonly replyTo?: string;
  /** Escape hatch for adapter-specific metadata. Core never reads it. */
  readonly raw?: unknown;
}

export interface FileDiff {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** Unified diff text, already sanitised and capped. */
  readonly patch?: string;
}

/**
 * The single rendering currency of the system (§5.4). Adapters turn a Card
 * into their native format and never learn anything about opencode.
 */
export type Card =
  | { readonly kind: "text"; readonly markdown: string }
  | { readonly kind: "status"; readonly label: string }
  | {
      readonly kind: "permission";
      readonly id: string;
      readonly title: string;
      readonly tool: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "diff"; readonly files: readonly FileDiff[] }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "notice"; readonly text: string };

/** A rendered message on its way out. */
export interface OutboundMessage {
  readonly conversation: ConversationRef;
  readonly cards: readonly Card[];
  /** Correlation id tying this back to a user action in the audit log. */
  readonly correlation?: string;
  /** Opencode session this originated from, if any. */
  readonly sessionId?: string;
}

/**
 * Capability declaration (§7.4 layer 7).
 *
 * An adapter that cannot positively authenticate the person tapping a button
 * MUST NOT set `permissionRelay: true`. The declaration is the security
 * assertion — a false positive here is a remote code execution bug.
 */
export interface AdapterCapabilities {
  /** Inbound + outbound messaging. */
  readonly messaging: boolean;
  /** Buttons whose taps arrive as authenticated inbound messages. */
  readonly permissionRelay: boolean;
  /** Multiple concurrent conversations. */
  readonly threads: boolean;
  /** Rich card rendering (diff, status, markdown). */
  readonly richCards: boolean;
}

export interface AdapterContext {
  readonly config: ResolvedRuntimeConfig;
  readonly logger: import("./logger.js").Logger;
  readonly audit: import("./logger.js").AuditLog;
  readonly sessions: import("./sessions.js").SessionStore;
  readonly permissions: import("./permissions.js").PermissionRegistry;
  readonly bridge: BridgeHandle;
  /**
   * The single opencode event subscriber. Adapters that want to observe events
   * subscribe here — never to `/event` directly, or every adapter would see
   * every event and duplicate the processing (§5.5).
   */
  readonly hub: import("./events.js").EventHub;
  readonly outbox: import("./outbox.js").Outbox;
}

export interface Adapter {
  readonly id: PlatformId;
  readonly capabilities: AdapterCapabilities;
  /** Human-readable name for `/status` and the docs. */
  readonly displayName: string;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  /** Deliver a rendered message. Must respect the outbox rate limit contract. */
  send(msg: OutboundMessage): Promise<void>;
  /** Edit or replace a previously sent "live" message, if the platform allows. */
  edit?(conversation: ConversationRef, messageId: string, cards: readonly Card[]): Promise<void>;
  /** Optional low-level access used by tests and the CLI adapter. */
  handle?(message: InboundMessage): Promise<void>;
}

export interface BridgeHandle {
  /** The full inbound pipeline: gate → router → command/prompt → transport. */
  handle(message: InboundMessage): Promise<void>;
  /** Forward a user's prompt into an opencode session. */
  prompt(conversation: ConversationRef, text: string, opts?: PromptOptions): Promise<string>;
  /** Create a fresh opencode session bound to a conversation. */
  newSession(conversation: ConversationRef, title?: string): Promise<string>;
  /** Stop whatever is running in a session. Always works, regardless of limits. */
  abort(conversation: ConversationRef): Promise<void>;
  /** Relay a rendered card set into a conversation. */
  deliver(
    conversation: ConversationRef,
    cards: readonly Card[],
    correlation?: string,
  ): Promise<void>;
  /**
   * Resolve a pending permission by the platform-visible id.
   *
   * `actor` is optional and exists so the audit log can record *who* answered
   * — the gate has already authenticated them by the time this is called.
   */
  answerPermission(
    conversation: ConversationRef,
    shortId: string,
    verdict: PermissionVerdict,
    actor?: Actor,
  ): Promise<boolean>;
}

export interface PromptOptions {
  readonly correlation?: string;
  readonly model?: { readonly providerID: string; readonly modelID: string };
  readonly agent?: string;
}

/** The three values opencode accepts (§3.1). */
export type PermissionVerdict = "once" | "always" | "reject";

/** Mapping from adapter vocabulary to opencode's. */
export function verdictFromChoice(choice: "approve" | "always" | "deny"): PermissionVerdict {
  switch (choice) {
    case "approve":
      return "once";
    case "always":
      return "always";
    case "deny":
      return "reject";
  }
}

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

export const LOG_LEVELS: readonly LogLevel[] = [
  "silent",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

export interface GroupPolicy {
  /** If non-empty, only these actor ids may use this group. */
  readonly allowFrom?: readonly string[];
  /** Default true. A message that does not mention the bot is dropped. */
  readonly requireMention?: boolean;
  readonly label?: string;
}

export interface AccessConfig {
  /** Master kill switch. Checked before the allowlist (§7.1). */
  readonly disabled: boolean;
  /** `"<platform>:<id>"` entries that may DM the bot freely. */
  readonly allowFrom: readonly string[];
  /** chatId -> policy. Groups are off until an entry exists here. */
  readonly groups: Readonly<Record<string, GroupPolicy>>;
  readonly requireMention: boolean;
}

/** Normalised config surface handed to adapters. */
export interface ResolvedRuntimeConfig {
  readonly stateDir: string;
  readonly logDir: string;
  readonly opencodeUrl: string;
  readonly opencodeUsername?: string;
  readonly opencodePassword?: string;
  readonly projectDir?: string;
  readonly access: AccessConfig;
  readonly logLevel: LogLevel;
  readonly debugFilter: readonly string[];
  readonly logRotateMaxBytes: number;
  readonly logRotateMaxFiles: number;
  readonly logRetentionDays: number;
  readonly auditRetentionDays: number;
  readonly actorMode: "hash" | "raw";
  readonly maxTurnsPerPrompt: number;
  readonly maxNotificationsPerRun: number;
  readonly maxConcurrentSessions: number;
  readonly requirePermissionAsk: boolean;
}

export function actorKey(actor: Pick<Actor, "platform" | "id">): string {
  return `${actor.platform}:${actor.id}`;
}

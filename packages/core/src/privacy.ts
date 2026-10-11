/**
 * Data subject rights (§8.5).
 *
 * Every GDPR/DPDP right maps to a working command here, because "contact us"
 * is not an implementation. Rights requests are themselves audited —
 * Art. 5(2) accountability requires you can prove you handled them.
 */

import type { ConsentRecord } from "./config.js";
import { readConsent, withdrawConsent } from "./config.js";
import type { AuditLog } from "./logger.js";
import type { PermissionRegistry } from "./permissions.js";
import type { SessionStore } from "./sessions.js";
import type { Actor, ConversationRef } from "./types.js";
import { actorKey } from "./types.js";

export interface ExportedSession {
  sessionId: string;
  platform: string;
  chatId: string;
  threadId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExportedAuditRecord {
  ts: string;
  event: string;
  session: string | null;
  outcome: string | null;
  ns: string;
  fields: Record<string, unknown> | null;
}

export interface ExportBundle {
  readonly version: 1;
  readonly exportedAt: string;
  readonly actor: { platform: string; id: string; hashedId: string };
  readonly allowlistEntry: string | null;
  readonly sessions: ExportedSession[];
  readonly audit: ExportedAuditRecord[];
  readonly consent: ConsentRecord | null;
  readonly retention: {
    readonly debugLogsDays: number;
    readonly auditDays: number;
    readonly pairingTtlHours: number;
  };
}

export interface ForgetOptions {
  /** Erase one conversation's mapping rather than everything. */
  readonly session?: string;
  /** Drop audit records for this actor but keep the session mapping. */
  readonly purgeOnly?: boolean;
  /** Include the consent record. Irreversible. */
  readonly all?: boolean;
  /** Opencode session ids bound to this actor, resolved by the caller. */
  readonly sessionIds?: readonly string[];
}

export interface ForgetResult {
  readonly sessionsRemoved: number;
  readonly auditRemoved: number;
  readonly permissionsRemoved: number;
  readonly consentWithdrawn: boolean;
}

export interface PrivacyDeps {
  readonly stateDir: string;
  readonly audit: AuditLog;
  readonly sessions: SessionStore;
  readonly permissions: PermissionRegistry;
  readonly access: { allowFrom: readonly string[] };
  readonly retentionDays: { debug: number; audit: number };
  /** Rewrites the audit log dropping records for one actor. */
  readonly purgeAuditForActor?: (hashedId: string) => number;
}

export class PrivacyService {
  constructor(private readonly deps: PrivacyDeps) {}

  /**
   * §8.5 — access + portability. Produces everything associated with a platform
   * identity: allowlist entry, session mappings, audit records, consent record
   * and the retention policy in force.
   */
  exportData(actor: Actor, format: "json" | "ndjson" = "json"): string {
    const key = actorKey(actor);
    const hashed = this.deps.audit.hashActor(actor);
    const sessions = this.deps.sessions
      .list()
      .filter((b) => b.conversation.platform === actor.platform && matchesConversation(b, actor));

    const bundle: ExportBundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      actor: { platform: actor.platform, id: actor.id, hashedId: hashed },
      allowlistEntry: this.deps.access.allowFrom.includes(key) ? key : null,
      sessions: sessions.map(
        (b): ExportedSession => ({
          sessionId: b.sessionId,
          platform: b.conversation.platform,
          chatId: b.conversation.chatId,
          threadId: b.conversation.threadId ?? null,
          title: b.title,
          createdAt: new Date(b.createdAt).toISOString(),
          updatedAt: new Date(b.updatedAt).toISOString(),
        }),
      ),
      audit: this.deps.audit.read({ actor: hashed }).map(
        (r): ExportedAuditRecord => ({
          ts: r.ts,
          event: r.event,
          session: r.session ?? null,
          outcome: r.outcome ?? null,
          ns: r.ns,
          fields: r.fields ?? null,
        }),
      ),
      consent: readConsent(this.deps.stateDir),
      retention: {
        debugLogsDays: this.deps.retentionDays.debug,
        auditDays: this.deps.retentionDays.audit,
        pairingTtlHours: 1,
      },
    };

    if (format === "ndjson") {
      // Portability format: one JSON object per line, so a subject can pipe it
      // straight into `jq` or any other tool without parsing the whole bundle.
      return [
        JSON.stringify({
          record: "meta",
          version: bundle.version,
          exportedAt: bundle.exportedAt,
          actor: bundle.actor,
          allowlistEntry: bundle.allowlistEntry,
          consent: bundle.consent,
          retention: bundle.retention,
          sessionCount: bundle.sessions.length,
          auditCount: bundle.audit.length,
        }),
        ...bundle.sessions.map((s) => JSON.stringify({ record: "session", ...s })),
        ...bundle.audit.map((a) => JSON.stringify({ record: "audit", ...a })),
      ].join("\n");
    }
    return JSON.stringify(bundle, null, 2);
  }

  /**
   * §8.5 — erasure / rectification / restriction. Removes session mappings,
   * purges this actor's audit records and rotates the session out of the router.
   */
  forget(actor: Actor, opts: ForgetOptions = {}): ForgetResult {
    const hashed = this.deps.audit.hashActor(actor);
    const key = actorKey(actor);

    let sessionsRemoved = 0;
    let permissionsRemoved = 0;

    if (!opts.purgeOnly) {
      for (const binding of this.deps.sessions.list()) {
        if (binding.conversation.platform !== actor.platform) continue;
        if (opts.session && binding.sessionId !== opts.session) {
          if (!matchesConversation(binding, actor)) continue;
        }
        if (!matchesConversation(binding, actor)) continue;
        this.deps.sessions.forget(binding.conversation);
        this.deps.permissions.forgetSession(binding.sessionId);
        sessionsRemoved++;
      }
      for (const sessionId of opts.sessionIds ?? []) {
        this.deps.sessions.forgetSession(sessionId);
        this.deps.permissions.forgetSession(sessionId);
      }
      permissionsRemoved = this.deps.permissions
        .list()
        .filter((p) =>
          [...this.deps.sessions.list()].some(
            (b) => b.sessionId === p.sessionId && matchesConversation(b, actor),
          ),
        ).length;
    }

    const auditRemoved = this.deps.purgeAuditForActor?.(hashed) ?? 0;

    let consentWithdrawn = false;
    if (opts.all) {
      withdrawConsent(this.deps.stateDir);
      consentWithdrawn = true;
    }

    // §8.5 — the rights request itself is audited, before the hash chain moves on.
    this.deps.audit.append({
      event: "privacy.forget",
      actor,
      outcome: "allow",
      ns: "privacy",
      fields: {
        sessionsRemoved,
        auditRemoved,
        purgeOnly: opts.purgeOnly === true,
        consentWithdrawn,
        allowlistEntry: key,
      },
    });

    return { sessionsRemoved, auditRemoved, permissionsRemoved, consentWithdrawn };
  }

  /** §8.5 — the notice. Short, factual, and honest about who is the controller. */
  notice(): string {
    return [
      "opencode-rc — what is held about you",
      "",
      "Who is responsible: you, the person running this instance, are the controller.",
      "opencode-rc is software and makes no claims on your behalf. There is no",
      "account, no cloud service, and no telemetry of any kind.",
      "",
      "Held about you:",
      "  • your platform user id, in the allowlist (state/access.json, mode 0600)",
      "  • your platform user id, hashed with a per-install salt, in the audit log",
      "  • the mapping from your chat to an opencode session id",
      "",
      "Never held by us:",
      "  • the content of your messages. Message bodies are never written to our",
      "    logs. They live in opencode's transcript and in the chat platform's.",
      "",
      "Retention:",
      `  • debug logs ${this.deps.retentionDays.debug} days`,
      `  • audit log ${this.deps.retentionDays.audit} days`,
      "  • pending pairing codes 1 hour",
      "",
      "Your rights:",
      "  /export          everything associated with you, machine-readable",
      "  /export --format ndjson   same, line-delimited",
      "  /forget          erase your session mappings and audit records",
      "  /forget --purge-only     drop audit records, keep sessions",
      "  rc consent withdraw       stop all processing",
      "",
      "Rights requests are themselves recorded, so you can prove they were handled.",
      "See PRIVACY.md and docs/DATA_PROTECTION.md.",
    ].join("\n");
  }
}

/**
 * A binding belongs to an actor when the conversation is that actor's DM.
 *
 * Adapters put the actor id into the chat id (`dm:<id>`), and the router's
 * conversation key wraps it once more (`<platform>:dm:<id>`), so both shapes
 * occur in stored data and both must match.
 */
function matchesConversation(binding: { conversation: ConversationRef }, actor: Actor): boolean {
  const { chatId } = binding.conversation;
  if (chatId === actor.id) return true;
  const parts = chatId.split(":");
  if (parts[0] === "dm") return parts[1] === actor.id;
  if (parts[1] === "dm") return parts[2] === actor.id;
  return false;
}

export function conversationForActor(actor: Actor): ConversationRef {
  return { platform: actor.platform, chatId: `dm:${actor.id}` };
}

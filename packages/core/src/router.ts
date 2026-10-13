/**
 * Message → conversation routing.
 *
 * The router's job is to turn an inbound message into the *decision* about
 * what should happen to it, without any platform knowledge and without any
 * opencode knowledge. It is the piece adapters call before touching a session.
 */

import { parsePermissionReply } from "./permissions.js";
import type { ConversationRef, InboundMessage, PermissionVerdict } from "./types.js";

export type Intent =
  | {
      readonly kind: "command";
      readonly name: string;
      readonly args: string[];
      readonly raw: string;
    }
  | { readonly kind: "permission"; readonly shortId: string; readonly verdict: PermissionVerdict }
  | { readonly kind: "btw"; readonly text: string }
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "ignore"; readonly reason: string };

/**
 * §2.3 — the strict permission reply grammar. Bare `yes` is rejected: a loose
 * `/yes/i` would swallow the user's ordinary conversation and approve something.
 * `always` is included so all three verdicts are typeable; the five-letter code
 * is still mandatory either way.
 */
const PERMISSION_REPLY = /^\s*(y|yes|always|a|n|no)\s+([a-km-z]{5})\s*$/i;

/** Platform-agnostic commands. Adapters map their own prefixes onto these. */
export const COMMANDS = [
  "new",
  "sessions",
  "projects",
  "status",
  "model",
  "diff",
  "abort",
  "help",
  "privacy",
  "export",
  "forget",
  "btw",
  "cancel",
  "start",
  "send",
] as const;

export type CommandName = (typeof COMMANDS)[number];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `prefix + name + optional args`, with the prefix escaped rather than assumed. */
function commandRegex(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}([a-z]+)\\s*([\\s\\S]*)$`, "i");
}

export interface RouteOptions {
  /** Command prefix the adapter uses. Telegram/Discord use `/`, Slack uses `!`. */
  readonly commandPrefix?: string;
  /** True when the bot's own messages appear in the inbound stream. */
  readonly ignoreSelf?: boolean;
  readonly botUserId?: string;
}

export class Router {
  private readonly prefix: string;
  private readonly commandRe: RegExp;
  private readonly botUserId?: string;

  constructor(opts: RouteOptions = {}) {
    this.prefix = opts.commandPrefix ?? "/";
    this.commandRe = commandRegex(this.prefix);
    this.botUserId = opts.botUserId;
  }

  /** Resolves the conversation an event's reply button belongs to. */
  conversationFor(message: InboundMessage): ConversationRef {
    return message.chat;
  }

  route(message: InboundMessage): Intent {
    // Never act on our own messages, whichever platform echoes them back.
    if (this.botUserId && message.actor.id === this.botUserId) {
      return { kind: "ignore", reason: "self" };
    }

    const text = message.text ?? "";

    // Permission replies are checked BEFORE commands: "yes abcde" is a verdict,
    // and a command list that swallowed it would be a security bug.
    if (PERMISSION_REPLY.test(text)) {
      const parsed = parsePermissionReply(text);
      if (parsed) {
        return { kind: "permission", shortId: parsed.shortId, verdict: parsed.verdict };
      }
    }

    if (text.startsWith(this.prefix)) {
      const m = this.commandRe.exec(text);
      if (m) {
        const name = (m[1] ?? "").toLowerCase();
        if ((COMMANDS as readonly string[]).includes(name)) {
          const args = (m[2] ?? "").trim();
          return {
            kind: "command",
            name,
            args: args ? args.split(/\s+/).filter(Boolean) : [],
            raw: text,
          };
        }
        return { kind: "command", name, args: [], raw: text };
      }
    }

    // `btw` is a prefix, not a command: "btw also bump the version" queues a
    // follow-up while the current run continues.
    const btw = /^\s*btw\s+(.+)$/is.exec(text);
    if (btw) {
      return { kind: "btw", text: (btw[1] ?? "").trim() };
    }

    if (!text.trim()) return { kind: "ignore", reason: "empty" };

    return { kind: "prompt", text };
  }

  /** Every adapter needs the same help text. Returns Cards, not a string. */
  help(): readonly { name: string; usage: string; summary: string }[] {
    return [
      { name: "new", usage: `${this.prefix}new [title]`, summary: "Start a new session" },
      { name: "sessions", usage: `${this.prefix}sessions`, summary: "List your sessions" },
      {
        name: "status",
        usage: `${this.prefix}status`,
        summary: "Is the agent busy? What is it doing?",
      },
      { name: "diff", usage: `${this.prefix}diff`, summary: "Files changed in this session" },
      { name: "abort", usage: `${this.prefix}abort`, summary: "Stop the current run" },
      { name: "model", usage: `${this.prefix}model <provider/model>`, summary: "Pick a model" },
      { name: "projects", usage: `${this.prefix}projects`, summary: "List opencode projects" },
      {
        name: "btw",
        usage: "btw <text>",
        summary: "Queue a follow-up for when the current run finishes",
      },
      { name: "cancel", usage: `${this.prefix}cancel`, summary: "Drop the queued follow-up" },
      {
        name: "send",
        usage: `${this.prefix}send <path>`,
        summary: "Relay a file from inbox/ to this chat",
      },
      { name: "privacy", usage: `${this.prefix}privacy`, summary: "What data is held about you" },
      {
        name: "export",
        usage: `${this.prefix}export [--format ndjson]`,
        summary: "Export your data",
      },
      {
        name: "forget",
        usage: `${this.prefix}forget [--session <id>] [--purge-only]`,
        summary: "Erase data",
      },
      { name: "help", usage: `${this.prefix}help`, summary: "This list" },
      {
        name: "(permission)",
        usage: "yes <code> | always <code> | no <code>",
        summary: "Answer a permission request. Bare yes/no is ignored on purpose.",
      },
    ];
  }
}

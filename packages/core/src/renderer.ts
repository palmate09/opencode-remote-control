/**
 * opencode events → platform-neutral {@link Card}s (§5.4).
 *
 * The renderer is where the "keep the logs like Claude Code does" requirement
 * meets the "never leak secrets to a chat" requirement. Every string that
 * becomes a Card passes through `sanitizeText` first.
 *
 * It also implements the streaming-throttle policy: deltas accumulate into a
 * "live" card that is edited, not spammed as new messages, because a token per
 * message would trip every rate limit on earth.
 */

import { chunkText } from "./sanitize.js";
import { elide, safeName, safePath, sanitizeText } from "./sanitize.js";
import type { BridgeEvent, MessagePart, PermissionRequest } from "./transport.js";
import type { FileDiff } from "./types.js";
import type { Card } from "./types.js";

export interface RenderOptions {
  /** Code-point cap for a single rendered message. §10.2. */
  readonly cap?: number;
}

/**
 * Below this many characters a partial reply is not worth a message. At ~40
 * characters that is roughly one short clause, so the user sees progress rather
 * than a flicker of single tokens.
 */
export const MIN_STREAM_CHARS = 40;

export class Renderer {
  private readonly cap: number;
  /** sessionId → in-flight text buffer. */
  /**
   * Streaming buffers, keyed by `sessionId`, holding the text part currently
   * being assembled and the text accumulated so far.
   *
   * Only *text* parts ever enter this. opencode interleaves `step-start` and
   * `step-finish` parts between text parts, so a buffer that reset on "a new
   * part id arrived" would be wiped by every one of them and the whole reply
   * would be lost before `session.idle` ever fires.
   */
  private readonly buffers = new Map<string, { partId: string; text: string }>();
  private readonly toolLabels = new Map<string, string>();

  constructor(opts: RenderOptions = {}) {
    this.cap = opts.cap ?? 3500;
  }

  /** Converts a completed assistant text part into a Card. */
  text(raw: string): Card {
    return { kind: "text", markdown: sanitizeText(raw, this.cap) };
  }

  status(label: string): Card {
    return { kind: "status", label: sanitizeText(label, 200) };
  }

  notice(text: string): Card {
    return { kind: "notice", text: sanitizeText(text, this.cap) };
  }

  error(message: string): Card {
    return { kind: "error", message: sanitizeText(message, this.cap) };
  }

  permission(request: PermissionRequest, shortId: string, ttlMs: number): Card {
    return {
      kind: "permission",
      id: shortId,
      title: sanitizeText(request.title || `Allow ${safeName(request.type)}?`, 500),
      tool: safeName(request.type, 40),
      expiresAt: request.createdAt + ttlMs,
    };
  }

  diff(files: readonly FileDiff[]): Card {
    return {
      kind: "diff",
      files: files.map((f) => ({
        path: safePath(f.path),
        additions: f.additions,
        deletions: f.deletions,
        ...(f.patch ? { patch: sanitizeText(f.patch, this.cap) } : {}),
      })),
    };
  }

  /**
   * Streams a text delta. Returns `null` while the message is still too short
   * to be worth sending, so the caller can throttle edits instead of emitting
   * one message per token.
   *
   * Non-text parts (`step-start`, `step-finish`, reasoning) are ignored: they
   * carry no relayable text, and letting them into the buffer would discard the
   * reply in progress.
   */
  pushDelta(
    sessionId: string,
    part: MessagePart,
    delta: string | undefined,
    force = false,
  ): Card | null {
    if (part.type !== "text") return null;

    const existing = this.buffers.get(sessionId);
    if (!existing || existing.partId !== part.id) {
      // A new text part starts a new buffer. When the server sends a snapshot
      // in `part.text` it is authoritative, so start from it rather than "".
      this.buffers.set(sessionId, { partId: part.id, text: part.text ?? "" });
      if (!force && !delta) return null;
    }
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return null;
    if (delta) buffer.text += delta;
    const text = sanitizeText(buffer.text, this.cap);
    if (!force && text.length < MIN_STREAM_CHARS) return null;
    return { kind: "text", markdown: text };
  }

  /** Called on `session.idle`. Flushes whatever was buffered as the final Card. */
  flush(sessionId: string): Card | null {
    const buffer = this.buffers.get(sessionId);
    if (!buffer || !buffer.text.trim()) {
      this.buffers.delete(sessionId);
      return null;
    }
    this.buffers.delete(sessionId);
    return { kind: "text", markdown: sanitizeText(buffer.text, this.cap) };
  }

  discard(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  /** A short human label for a tool part, used in status cards. */
  toolStatus(sessionId: string, part: MessagePart): Card | null {
    if (part.type !== "tool") return null;
    const tool = safeName(part.tool ?? "tool", 40);
    const status = part.state?.status ?? "running";
    const title = part.state?.title ? sanitizeText(part.state.title, 200) : undefined;
    this.toolLabels.set(`${sessionId}:${part.id}`, tool);

    if (status === "completed") {
      const summary = elide(part.state?.output ?? part.state?.title ?? "", 160);
      return {
        kind: "status",
        label: `✓ ${tool}${summary ? ` — ${sanitizeText(summary, 160)}` : ""}`,
      };
    }
    if (status === "error") {
      return {
        kind: "error",
        message: `${tool}: ${sanitizeText(part.state?.error ?? "failed", 500)}`,
      };
    }
    return { kind: "status", label: title ? `${tool} — ${sanitizeText(title, 160)}` : `${tool}…` };
  }

  /**
   * Renders an opencode session status into a card. Used by `/status`.
   */
  sessionStatus(input: {
    sessionId: string;
    state: "idle" | "busy" | "retry";
    title?: string;
    message?: string;
  }): Card {
    const bits = [`session ${sanitizeText(input.sessionId, 40)}`];
    if (input.title) bits.push(sanitizeText(input.title, 120));
    if (input.state === "busy") bits.push("busy");
    if (input.state === "retry" && input.message)
      bits.push(`retrying: ${sanitizeText(input.message, 200)}`);
    return { kind: "status", label: bits.join(" — ") };
  }

  /**
   * Renders a session diff summary. Files are listed as *metadata*, never
   * inline inside the body text (§7.4 layer 5) — an inline annotation is
   * forgeable by any allowlisted sender typing the same string.
   */
  diffSummary(files: readonly FileDiff[]): string {
    if (files.length === 0) return "No file changes.";
    const lines = files.slice(0, 40).map((f) => {
      const path = safePath(f.path, 200);
      return `\`${path}\` +${f.additions} −${f.deletions}`;
    });
    const totalAdd = files.reduce((n, f) => n + f.additions, 0);
    const totalDel = files.reduce((n, f) => n + f.deletions, 0);
    const header = `${files.length} file${files.length === 1 ? "" : "s"} changed, +${totalAdd} −${totalDel}`;
    return sanitizeText([header, ...lines].join("\n"), this.cap);
  }
}

/** Renders a transcript into reply chunks that fit a platform limit. */
export function renderChunks(text: string, platformLimit: number): string[] {
  return chunkText(sanitizeText(text), Math.max(64, platformLimit - 16));
}

/**
 * Turns a run of BridgeEvents into a summary Card list, for the CLI adapter's
 * plain-text output and for `/status`.
 */
export function summariseEvents(events: readonly BridgeEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case "permission.asked":
        lines.push(`permission asked: ${e.request.title}`);
        break;
      case "session.error":
        lines.push(`error: ${e.message}`);
        break;
      case "message.part":
        if (e.part.type === "tool") lines.push(`tool: ${e.part.tool ?? e.part.type}`);
        break;
      case "file.edited":
        lines.push(`edited: ${e.file}`);
        break;
      default:
        break;
    }
  }
  return sanitizeText(lines.join("\n"));
}

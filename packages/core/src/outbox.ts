/**
 * Per-chat rate-limited send queue (§7.5).
 *
 * Platform limits that drive the constants:
 *   Telegram  ~1 msg/s per chat, 4096 chars
 *   Discord   2000 chars, burst 5 / 5 s, 3-second interaction window
 *   Slack     40,000 chars per block, burst ~1/s
 *
 * A naive `await send()` in a loop gets you rate-limited within a minute and
 * the bot stops responding. Everything outbound goes through here.
 *
 * Also enforces §7.6: a hard cap on queued messages, with overflow collapsing
 * into a single summary rather than an unbounded backlog that floods the phone
 * at 3am.
 */

import type { Logger } from "./logger.js";
import type { OutboundMessage } from "./types.js";
import { conversationKey } from "./types.js";

export const MIN_GAP_MS = 1100;
export const EDIT_THROTTLE_MS = 1000;
export const DEFAULT_QUEUE_CAP = 25;

export interface OutboxDeps {
  readonly logger: Logger;
  /** Called when the platform says "come back later". */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Default minimum gap between messages to one chat. §10.1. */
  readonly minGapMs?: number;
  /**
   * Per-platform overrides. The CLI and MCP surfaces have no flood limit, so
   * they must not inherit Telegram's 1.1s floor — otherwise a terminal reply
   * arrives visibly late for no reason.
   */
  readonly gapsByPlatform?: Readonly<Record<string, number>>;
  readonly queueCap?: number;
}

export type SendFn = (msg: OutboundMessage) => Promise<void>;

interface ChatQueue {
  readonly messages: OutboundMessage[];
  timer: ReturnType<typeof setTimeout> | undefined;
  lastSentAt: number;
  inFlight: boolean;
  lastEditAt: number;
  /** Set when the platform told us to back off. */
  cooldownUntil: number;
}

export class Outbox {
  private readonly queues = new Map<string, ChatQueue>();
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minGapMs: number;
  private readonly gapsByPlatform: Readonly<Record<string, number>>;
  private readonly queueCap: number;
  private readonly sender: SendFn;
  private stopped = false;

  constructor(send: SendFn, deps: OutboxDeps) {
    this.sender = send;
    this.logger = deps.logger.child("outbox");
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minGapMs = deps.minGapMs ?? MIN_GAP_MS;
    this.gapsByPlatform = deps.gapsByPlatform ?? {};
    this.queueCap = deps.queueCap ?? DEFAULT_QUEUE_CAP;
  }

  /** The conversation key is `<platform>:<chatId>[:<threadId>]`. */
  private gapFor(key: string): number {
    const platform = key.split(":")[0] ?? "";
    return this.gapsByPlatform[platform] ?? this.minGapMs;
  }

  private queue(key: string): ChatQueue {
    let q = this.queues.get(key);
    if (!q) {
      q = {
        messages: [],
        timer: undefined,
        lastSentAt: 0,
        inFlight: false,
        lastEditAt: 0,
        cooldownUntil: 0,
      };
      this.queues.set(key, q);
    }
    return q;
  }

  /** Enqueues without waiting. Fire-and-forget is the correct default here. */
  push(msg: OutboundMessage): void {
    if (this.stopped) return;
    const key = conversationKey(msg.conversation);
    const q = this.queue(key);

    if (q.messages.length >= this.queueCap) {
      // Collapse rather than grow. §7.6.
      const dropped = q.messages.length - this.queueCap + 1;
      q.messages.splice(0, dropped);
      q.messages.push({
        ...msg,
        cards: [
          {
            kind: "notice",
            text: `${dropped} earlier message${dropped === 1 ? "" : "s"} collapsed to stay under the queue limit.`,
          },
        ],
      });
      this.logger.warn("outbox overflow, collapsed", { chat: key, dropped });
    } else {
      q.messages.push(msg);
    }
    this.pump(key);
  }

  /** Enqueues and resolves once this message has actually been delivered. */
  async send(msg: OutboundMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const wrapped: OutboundMessage = {
        ...msg,
        cards: msg.cards,
      };
      const tracker = this.trackerFor(conversationKey(msg.conversation));
      tracker.push({ resolve, reject });
      this.push(wrapped);
    });
  }

  private readonly trackers = new Map<string, { resolve(): void; reject(e: Error): void }[]>();

  private trackerFor(key: string): { resolve(): void; reject(e: Error): void }[] {
    let t = this.trackers.get(key);
    if (!t) {
      t = [];
      this.trackers.set(key, t);
    }
    return t;
  }

  private pump(key: string): void {
    const q = this.queue(key);
    if (this.stopped || q.inFlight || q.timer !== undefined) return;
    if (q.messages.length === 0) return;

    const now = Date.now();
    const wait = Math.max(q.cooldownUntil - now, q.lastSentAt + this.gapFor(key) - now);
    if (wait > 0) {
      q.timer = setTimeout(() => {
        q.timer = undefined;
        this.pump(key);
      }, wait);
      return;
    }

    const msg = q.messages.shift();
    if (!msg) return;
    q.inFlight = true;
    q.lastSentAt = Date.now();

    void this.sender(msg)
      .catch((err) => {
        this.logger.warn("send failed", { chat: key, error: String(err) });
        const retryAfter = parseRetryAfter(err);
        if (retryAfter !== undefined) {
          q.cooldownUntil = Date.now() + retryAfter;
          this.logger.info("honouring platform retry_after", { chat: key, retryAfter });
        }
      })
      .finally(() => {
        q.inFlight = false;
        const waiting = this.trackers.get(key);
        waiting?.shift()?.resolve();
        this.pump(key);
      });
  }

  /** §7.5 — edits to the live message are throttled to 1/s. */
  canEdit(conversationKeyStr: string): boolean {
    const q = this.queues.get(conversationKeyStr);
    if (!q) return true;
    return Date.now() - q.lastEditAt >= EDIT_THROTTLE_MS;
  }

  markEdited(conversationKeyStr: string): void {
    this.queue(conversationKeyStr).lastEditAt = Date.now();
  }

  pending(conversation?: string): number {
    if (conversation) return this.queue(conversation).messages.length;
    let n = 0;
    for (const q of this.queues.values()) n += q.messages.length;
    return n;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const q of this.queues.values()) {
      if (q.timer) clearTimeout(q.timer);
      q.timer = undefined;
      q.messages.length = 0;
    }
    this.queues.clear();
  }
}

/**
 * Extracts a platform retry hint from an error, in milliseconds.
 *
 * Naming is explicit because the two platforms disagree:
 *   - `retryAfterMs`   milliseconds (what our own adapters attach)
 *   - `retry_after`    seconds      (Telegram, Discord REST, Slack)
 *   - `Retry-After`    seconds      (HTTP header, per RFC 9110)
 */
export function parseRetryAfter(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;

  const ms = e.retryAfterMs;
  if (typeof ms === "number" && Number.isFinite(ms)) {
    return clampRetry(ms);
  }

  const seconds =
    e.retry_after ?? (e.parameters as Record<string, unknown> | undefined)?.retry_after;
  if (typeof seconds === "number" && Number.isFinite(seconds)) {
    return clampRetry(seconds * 1000);
  }

  const headers = e.headers as Record<string, string> | undefined;
  const header = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (header) {
    const n = Number.parseInt(header, 10);
    if (Number.isFinite(n)) return clampRetry(n * 1000);
  }

  const response = e.response as Response | undefined;
  if (response?.headers) {
    const n = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    if (Number.isFinite(n)) return clampRetry(n * 1000);
  }
  return undefined;
}

/**
 * A hostile or buggy platform must not be able to stall the queue forever.
 * One minute is longer than any legitimate backoff we have seen.
 */
function clampRetry(ms: number): number {
  return Math.max(0, Math.min(ms, 60_000));
}

/**
 * The event hub (§5.5).
 *
 * **Critical:** this is the single subscriber to opencode's `/event` stream.
 * If each adapter opened its own connection, every adapter would see every
 * event and duplicate the processing. Adapters subscribe here instead.
 *
 * Also responsible for:
 *   - deduplication (opencode re-sends the last frame on reconnect)
 *   - ordering per session (a text delta must never overtake a permission ask)
 *   - a bounded subscriber set that cannot leak on adapter restart
 */

import type { Logger } from "./logger.js";
import type { BridgeEvent, EventStreamHandle, OpencodeTransport } from "./transport.js";

/** §10.3 — dedupe set cap. */
const DEDUPE_CAP = 1000;

export interface EventHubOptions {
  readonly transport: OpencodeTransport;
  readonly logger: Logger;
  readonly now?: () => number;
}

export type EventSubscriber = (event: BridgeEvent) => void;

export class EventHub {
  private readonly transport: OpencodeTransport;
  private readonly logger: Logger;
  private readonly subscribers = new Set<EventSubscriber>();
  private handle: EventStreamHandle | undefined;
  private readonly seen = new Map<string, number>();
  private readonly abort = new AbortController();
  private started = false;

  constructor(opts: EventHubOptions) {
    this.transport = opts.transport;
    this.logger = opts.logger.child("events");
  }

  get isRunning(): boolean {
    return this.started;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  subscribe(fn: EventSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.handle = await this.transport.streamEvents(
      {
        onOpen: () => this.logger.info("subscribed to opencode event stream"),
        onClose: () => this.logger.warn("event stream closed"),
        onError: (err) => this.logger.warn("event stream error", { error: err.message }),
        onEvent: (event) => this.dispatch(event),
      },
      this.abort.signal,
    );
  }

  /**
   * Dedupe key. opencode replays the most recent frames when an SSE connection
   * drops, so a reconnect can deliver a permission ask we have already rendered.
   */
  private key(event: BridgeEvent): string {
    switch (event.type) {
      case "message.part":
        return `mp:${event.sessionId}:${event.part.id}:${event.delta ?? event.part.text?.length ?? ""}`;
      case "permission.asked":
        // Session-scoped: two sessions can legitimately both hold an open
        // request with the same provider-side id.
        return `pa:${event.request.sessionId}:${event.request.id}`;
      case "permission.replied":
        return `pr:${event.reply.sessionId}:${event.reply.permissionId}:${event.reply.response}`;
      case "session.idle":
      case "session.busy":
        // Each idle/busy is distinct; a tick keeps the dedupe key unique
        // without hiding a genuine repeat.
        return `${event.type}:${event.sessionId}:${this.tick}`;
      case "session.created":
      case "session.updated":
        return `${event.type}:${event.session.id}`;
      case "session.deleted":
        return `sd:${event.sessionId}`;
      case "session.error":
        return `se:${event.sessionId}:${event.message}`;
      case "file.edited":
        return `fe:${event.file}`;
      case "unknown":
        return `u:${event.rawType}`;
    }
  }

  private tick = 0;

  dispatch(event: BridgeEvent): void {
    this.tick++;
    const key = this.key(event);
    if (this.seen.has(key)) {
      this.logger.trace("dropping duplicate event", { key });
      return;
    }
    this.seen.set(key, this.tick);
    if (this.seen.size > DEDUPE_CAP) {
      // Drop the oldest half in one pass rather than paying O(n) per insert.
      const cutoff = this.tick - Math.floor(DEDUPE_CAP / 2);
      for (const [k, v] of this.seen) {
        if (v < cutoff) this.seen.delete(k);
      }
    }

    for (const fn of [...this.subscribers]) {
      try {
        fn(event);
      } catch (err) {
        // One bad subscriber must never stop the others.
        this.logger.error("event subscriber threw", { error: String(err) });
      }
    }
  }

  stop(): void {
    this.started = false;
    this.abort.abort();
    this.handle?.close();
    this.handle = undefined;
    this.subscribers.clear();
    this.seen.clear();
  }
}

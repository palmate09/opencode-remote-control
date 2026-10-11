/**
 * Session ↔ conversation mapping, persisted atomically.
 *
 * A session mapping is what makes acceptance test 7 pass: after a bridge
 * restart, `/sessions` resumes the *same* opencode session rather than starting
 * a new one. It is also what makes test 8 pass: two chats get two sessions and
 * never cross-talk.
 *
 * Every write is tmp+rename. A half-written `sessions.json` that maps a chat to
 * the wrong session is a correctness bug and a small security bug.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./config.js";
import type { ConversationRef } from "./types.js";
import { conversationKey } from "./types.js";

export interface SessionBinding {
  /** opencode session id. */
  readonly sessionId: string;
  /** The conversation this session belongs to. */
  readonly conversation: ConversationRef;
  readonly title: string;
  readonly directory?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Set while a run is in flight, so `/abort` knows where to send it. */
  busy?: boolean;
  /** Notified on completion, so `session.idle` knows where to send the reply. */
  correlation?: string;
}

interface PersistedShape {
  version: 1;
  bindings: Record<string, SessionBinding>;
}

export interface SessionStoreOptions {
  readonly stateDir: string;
  readonly now?: () => number;
  /** §7.6 — cap on concurrent live sessions. */
  readonly maxConcurrent?: number;
}

export class SessionStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private bindings = new Map<string, SessionBinding>();

  constructor(opts: SessionStoreOptions) {
    this.file = join(opts.stateDir, "sessions.json");
    this.now = opts.now ?? Date.now;
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as PersistedShape;
      if (parsed?.version !== 1 || typeof parsed.bindings !== "object") return;
      for (const [key, binding] of Object.entries(parsed.bindings)) {
        if (binding?.sessionId) this.bindings.set(key, { ...binding, busy: false });
      }
    } catch {
      // A corrupt file means we start fresh; opencode still holds the real
      // sessions, so `/sessions` can recover them via the transport.
    }
  }

  private persist(): void {
    const bindings: Record<string, SessionBinding> = {};
    for (const [k, v] of this.bindings) bindings[k] = { ...v, busy: false };
    writeJsonAtomic(this.file, { version: 1, bindings } satisfies PersistedShape);
  }

  key(conversation: ConversationRef): string {
    return conversationKey(conversation);
  }

  get(conversation: ConversationRef): SessionBinding | undefined {
    return this.bindings.get(conversationKey(conversation));
  }

  getBySessionId(sessionId: string): SessionBinding | undefined {
    for (const binding of this.bindings.values())
      if (binding.sessionId === sessionId) return binding;
    return undefined;
  }

  /** Number of conversations with a live session — used by the §7.6 breaker. */
  get concurrent(): number {
    return this.bindings.size;
  }

  get atCapacity(): boolean {
    return this.bindings.size >= this.maxConcurrent;
  }

  bind(
    conversation: ConversationRef,
    sessionId: string,
    title: string,
    directory?: string,
  ): SessionBinding {
    const key = conversationKey(conversation);
    const now = this.now();
    const existing = this.bindings.get(key);
    const binding: SessionBinding = {
      sessionId,
      conversation,
      title,
      ...(directory ? { directory } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.busy ? { busy: true } : {}),
      ...(existing?.correlation ? { correlation: existing.correlation } : {}),
    };
    this.bindings.set(key, binding);
    this.persist();
    return binding;
  }

  setBusy(conversation: ConversationRef, busy: boolean, correlation?: string): void {
    const key = conversationKey(conversation);
    const existing = this.bindings.get(key);
    if (!existing) return;
    this.bindings.set(key, {
      ...existing,
      busy,
      updatedAt: this.now(),
      ...(correlation
        ? { correlation }
        : existing.correlation
          ? { correlation: existing.correlation }
          : {}),
    });
    this.persist();
  }

  touch(conversation: ConversationRef): void {
    const key = conversationKey(conversation);
    const existing = this.bindings.get(key);
    if (!existing) return;
    this.bindings.set(key, { ...existing, updatedAt: this.now() });
    this.persist();
  }

  /** Removes a single conversation mapping — the core of `/forget`. */
  forget(conversation: ConversationRef): SessionBinding | undefined {
    const key = conversationKey(conversation);
    const existing = this.bindings.get(key);
    if (!existing) return undefined;
    this.bindings.delete(key);
    this.persist();
    return existing;
  }

  /** Removes every mapping belonging to one opencode session. */
  forgetSession(sessionId: string): number {
    let n = 0;
    for (const [key, binding] of [...this.bindings]) {
      if (binding.sessionId !== sessionId) continue;
      this.bindings.delete(key);
      n++;
    }
    if (n > 0) this.persist();
    return n;
  }

  list(): SessionBinding[] {
    return [...this.bindings.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  busySessions(): SessionBinding[] {
    return this.list().filter((b) => b.busy);
  }

  clear(): void {
    this.bindings.clear();
    this.persist();
  }
}

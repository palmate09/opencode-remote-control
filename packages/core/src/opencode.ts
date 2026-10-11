/**
 * The ONLY file in the repository that imports `@opencode-ai/sdk` (§5.2
 * Rule 1). Every other module speaks `OpencodeTransport`.
 *
 * Verified against `@opencode-ai/sdk@1.18.35`. See PLAN.md §3.1.
 */

import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk/client";

import type { Logger } from "./logger.js";
import type {
  BridgeEvent,
  EventStreamHandle,
  EventStreamHandlers,
  FileDiff,
  MessagePart,
  OpencodeTransport,
  PermissionRequest,
  PromptInput,
  SessionStatusEntry,
  SessionSummary,
  TransportOptions,
} from "./transport.js";

export class OpencodeError extends Error {
  override readonly name = "OpencodeError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface ClassicTransportDeps {
  readonly logger: Logger;
  /** Constants from §10.3, injectable so tests can use short backoffs. */
  readonly timings?: Partial<BridgeTimings>;
}

export interface BridgeTimings {
  readonly fastBackoffMs: readonly number[];
  readonly connectBackoffMs: readonly number[];
  readonly giveUpAfterMs: number;
  readonly keepaliveMs: number;
  readonly livenessMs: number;
  readonly sleepThresholdMs: number;
}

/**
 * Resolves opencode's `permission` config into a single comparable mode.
 *
 * Accepts `"ask"`, `{"*": "ask"}` and `{bash: "ask"}`. Returns `undefined` when
 * the shape is not recognisable — see {@link ClassicTransport.permissionMode}
 * for why guessing would be worse than admitting ignorance.
 */
export function resolvePermissionMode(permission: unknown): string | undefined {
  if (typeof permission === "string") return permission;
  if (permission && typeof permission === "object" && !Array.isArray(permission)) {
    const obj = permission as Record<string, unknown>;
    const wildcard = obj["*"];
    if (typeof wildcard === "string") return wildcard;
    // A single named pattern is unambiguous enough to act on.
    const values = Object.values(obj).filter((v): v is string => typeof v === "string");
    if (values.length === 1) return values[0];
    if (values.length > 1 && new Set(values).size === 1) return values[0];
  }
  return undefined;
}

/**
 * Picks a human-readable label out of a permission request.
 *
 * The live payload carries `patterns` (an array) and sometimes a singular
 * `pattern`. A permission card with an empty title is unactionable — the whole
 * point is showing the operator *what* they are approving.
 */
function firstPattern(patterns: unknown, pattern: unknown): string | undefined {
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];

  const fromArray = asStrings(patterns);
  if (fromArray.length > 0) return fromArray.join(", ");

  if (typeof pattern === "string" && pattern) return pattern;
  const fromSingular = asStrings(pattern);
  if (fromSingular.length > 0) return fromSingular.join(", ");

  return undefined;
}

interface ProviderEntry {
  readonly id: string;
  readonly models: unknown;
}

/**
 * Normalises `/provider`'s provider list, which 1.18.x returns as an array.
 * Older shapes (an object keyed by id, or `{ providers: [...] }`) are accepted
 * too, because the adapter surface is versioned independently of opencode.
 */
export function providerEntries(raw: unknown): ProviderEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        const id = String(o.id ?? o.providerID ?? o.name ?? "");
        return id ? { id, models: o.models } : undefined;
      })
      .filter((p): p is ProviderEntry => p !== undefined);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([id, value]) => ({
      id,
      models: (value as { models?: unknown })?.models,
    }));
  }
  return [];
}

/** Model ids for one provider, whether they arrive as an array or a map. */
export function modelIdsOf(models: unknown): string[] {
  if (Array.isArray(models)) {
    return models
      .map((m) => (typeof m === "string" ? m : String((m as { id?: unknown })?.id ?? "")))
      .filter(Boolean);
  }
  if (models && typeof models === "object") return Object.keys(models);
  return [];
}

/**
 * §6.3 — the numbers, in one place, cited to the plan.
 */
export const DEFAULT_TIMINGS: BridgeTimings = {
  fastBackoffMs: [500, 1000, 2000, 4000, 8000, 15_000, 30_000],
  connectBackoffMs: [2000, 5000, 10_000, 30_000, 60_000, 120_000],
  giveUpAfterMs: 600_000,
  keepaliveMs: 15_000,
  livenessMs: 45_000,
  sleepThresholdMs: 240_000,
};

export function createClassicTransport(
  opts: TransportOptions,
  deps: ClassicTransportDeps,
): OpencodeTransport {
  return new ClassicTransport(opts, deps);
}

class ClassicTransport implements OpencodeTransport {
  readonly surface = "classic";
  readonly baseUrl: string;

  private readonly client: OpencodeClient;
  private readonly logger: Logger;
  private readonly timings: BridgeTimings;
  private readonly directory?: string;
  private readonly authorization?: string;
  /** messageID → role, correlated from `message.updated`. See toBridgeEvent. */
  private readonly messageRoles = new Map<string, MessagePart["role"]>();
  private stream: EventStreamHandle | undefined;

  constructor(opts: TransportOptions, deps: ClassicTransportDeps) {
    this.baseUrl = opts.baseUrl;
    this.logger = deps.logger.child("opencode");
    this.timings = { ...DEFAULT_TIMINGS, ...(deps.timings ?? {}) };
    this.directory = opts.directory;

    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.username || opts.password) {
      const raw = `${opts.username ?? ""}:${opts.password ?? ""}`;
      this.authorization = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
      headers.Authorization = this.authorization;
    }

    this.client = createOpencodeClient({ baseUrl: opts.baseUrl, headers });
  }

  private q(directory?: string): { directory?: string } {
    const dir = directory ?? this.directory;
    return dir ? { directory: dir } : {};
  }

  private async unwrap<T>(
    p: Promise<{ data?: T; error?: unknown; response?: Response }>,
  ): Promise<T> {
    const res = await p;
    if (res.error) {
      const status = res.response?.status;
      const detail =
        typeof res.error === "object" && res.error && "message" in (res.error as object)
          ? String((res.error as { message: unknown }).message)
          : String(res.error);
      throw new OpencodeError(`opencode request failed: ${detail}`, status);
    }
    return res.data as T;
  }

  async createSession(
    opts: { title?: string; parentId?: string; directory?: string } = {},
  ): Promise<SessionSummary> {
    const data = await this.unwrap(
      this.client.session.create({
        ...(opts.title
          ? { body: { title: opts.title, ...(opts.parentId ? { parentID: opts.parentId } : {}) } }
          : opts.parentId
            ? { body: { parentID: opts.parentId } }
            : {}),
        query: this.q(opts.directory),
      }) as Promise<{ data?: unknown; error?: unknown; response?: Response }>,
    );
    return toSummary(data as Record<string, unknown>);
  }

  async listSessions(directory?: string): Promise<SessionSummary[]> {
    const data = await this.unwrap(
      this.client.session.list({ query: this.q(directory) }) as Promise<{
        data?: unknown;
        error?: unknown;
        response?: Response;
      }>,
    );
    return ((data as unknown[]) ?? []).map((s) => toSummary(s as Record<string, unknown>));
  }

  async getSession(sessionId: string): Promise<SessionSummary | undefined> {
    try {
      const data = await this.unwrap(
        this.client.session.get({ path: { id: sessionId } }) as Promise<{
          data?: unknown;
          error?: unknown;
          response?: Response;
        }>,
      );
      return toSummary(data as Record<string, unknown>);
    } catch (err) {
      if (err instanceof OpencodeError && err.status === 404) return undefined;
      throw err;
    }
  }

  async prompt(input: PromptInput): Promise<void> {
    const body = {
      parts: [{ type: "text" as const, text: input.text }],
      ...(input.model
        ? { model: { providerID: input.model.providerID, modelID: input.model.modelID } }
        : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.system ? { system: input.system } : {}),
    };
    await this.unwrap(
      this.client.session.promptAsync({
        path: { id: input.sessionId },
        body,
        query: this.q(),
        ...(input.signal ? { signal: input.signal } : {}),
      }) as Promise<{ data?: unknown; error?: unknown; response?: Response }>,
    );
  }

  async abort(sessionId: string): Promise<void> {
    await this.unwrap(
      this.client.session.abort({ path: { id: sessionId } }) as Promise<{
        data?: unknown;
        error?: unknown;
        response?: Response;
      }>,
    );
  }

  async status(directory?: string): Promise<SessionStatusEntry[]> {
    const data = await this.unwrap(
      this.client.session.status({ query: this.q(directory) }) as Promise<{
        data?: unknown;
        error?: unknown;
        response?: Response;
      }>,
    );
    const raw = (data ?? {}) as Record<string, Record<string, unknown>>;
    return Object.entries(raw).map(([sessionId, value]) => {
      const type = String(value.type ?? "idle");
      return {
        sessionId,
        state:
          type === "busy"
            ? ("busy" as const)
            : type === "retry"
              ? ("retry" as const)
              : ("idle" as const),
        ...(typeof value.message === "string" ? { message: value.message } : {}),
      };
    });
  }

  async diff(sessionId: string): Promise<FileDiff[]> {
    const data = await this.unwrap(
      this.client.session.diff({ path: { id: sessionId } }) as Promise<{
        data?: unknown;
        error?: unknown;
        response?: Response;
      }>,
    );
    const files = (data as { files?: unknown[] } | undefined)?.files ?? [];
    return (files as Record<string, unknown>[]).map((f) => ({
      path: String(f.file ?? f.path ?? ""),
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
    }));
  }

  async messages(sessionId: string): Promise<MessagePart[]> {
    const data = await this.unwrap(
      this.client.session.messages({ path: { id: sessionId } }) as Promise<{
        data?: unknown;
        error?: unknown;
        response?: Response;
      }>,
    );
    const messages = (data as unknown[]) ?? [];
    const out: MessagePart[] = [];
    for (const m of messages as Record<string, unknown>[]) {
      const role = String(m.role ?? "assistant") as MessagePart["role"];
      const parts = (m.parts as Record<string, unknown>[]) ?? [];
      for (const p of parts) {
        out.push(toPart(p, String(m.sessionID ?? sessionId), String(m.id ?? ""), role));
      }
    }
    return out;
  }

  async answerPermission(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    await this.unwrap(
      this.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response },
      }) as Promise<{ data?: unknown; error?: unknown; response?: Response }>,
    );
  }

  /**
   * Lists the models you can actually use.
   *
   * Verified against a live 1.18.35 server. Three things about `/provider` that
   * are easy to get wrong and that made this return nothing at all:
   *
   *   1. The payload is `{ all, connected, default }` — **not** `providers`.
   *   2. `all` is an **array**, not an object keyed by provider id. Treating it
   *      as an object yields `["0","1","2",…]` and nothing resolves.
   *   3. `all` is the whole catalogue — 226 providers, a 6.7 MB response on a
   *      machine with several credentials. Only `connected` providers can be
   *      used, so only those are returned; relaying the catalogue to a chat app
   *      would blow past every message limit and list providers you cannot call.
   *
   * Model ids contain slashes (`anthropic/claude-haiku-4-5` under `openrouter`),
   * so ids are passed through whole rather than split.
   */
  async models(): Promise<{ providerID: string; modelID: string }[]> {
    const data = await this.unwrap(
      this.client.provider.list({ query: this.q() }) as Promise<{
        data?: unknown;
        error?: unknown;
        response?: Response;
      }>,
    );
    const body = (data ?? {}) as {
      connected?: string[];
      all?: unknown;
      providers?: unknown;
    };

    const entries = providerEntries(body.all ?? body.providers);
    const connected = new Set(body.connected ?? []);
    // With no `connected` key, fall back to the whole catalogue rather than
    // reporting nothing: an empty list is indistinguishable from a broken bridge.
    const usable = connected.size > 0 ? entries.filter((e) => connected.has(e.id)) : entries;

    const out: { providerID: string; modelID: string }[] = [];
    for (const provider of usable) {
      for (const modelID of modelIdsOf(provider.models)) {
        out.push({ providerID: provider.id, modelID });
      }
    }
    return out;
  }

  /**
   * Reads the effective permission mode for the §2.4 carry-over guard.
   *
   * opencode accepts two shapes, both observed on a live 1.18.35 server:
   *   "permission": "ask"                      — a bare default
   *   "permission": { "*": "ask", bash: "…" }  — a per-pattern policy
   *
   * We resolve the wildcard entry when present, because that is the baseline
   * every other pattern inherits from. When the shape is neither a string nor
   * has a wildcard, we return `undefined`: "could not determine" is honest,
   * and the caller decides what to do about it. Guessing "ask" would turn the
   * guard into decoration.
   */
  async permissionMode(directory?: string): Promise<string | undefined> {
    try {
      const data = await this.unwrap(
        this.client.config.get({ query: this.q(directory) }) as Promise<{
          data?: unknown;
          error?: unknown;
          response?: Response;
        }>,
      );
      return resolvePermissionMode((data as Record<string, unknown> | undefined)?.permission);
    } catch (err) {
      this.logger.debug("config.permission unavailable", { error: String(err) });
      return undefined;
    }
  }

  /**
   * §10.3 — one SSE connection with two backoff tracks.
   *
   * Connection errors back off slowly (2s → 120s) because retrying a dead
   * server harder just wastes battery. Non-connection errors back off fast
   * (500ms → 30s) because they usually clear immediately. Jitter of ±25%
   * avoids a thundering herd when several bridges restart at once.
   *
   * Sleep detection: if the gap between events exceeds 240s we know the laptop
   * slept, we reset the error budget and the attempt counter, so "close the lid
   * and come back" does not permanently degrade the connection.
   */
  async streamEvents(
    handlers: EventStreamHandlers,
    signal?: AbortSignal,
  ): Promise<EventStreamHandle> {
    const url = new URL("/event", this.baseUrl);
    if (this.directory) url.searchParams.set("directory", this.directory);

    let stopped = false;
    let attempt = 0;
    let lastEventAt = Date.now();
    let lastError: unknown;

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.authHeader) headers.Authorization = this.authHeader;

    const run = async (): Promise<void> => {
      while (!stopped && !abort.signal.aborted) {
        const startedAt = Date.now();
        lastEventAt = startedAt;
        try {
          const res = await fetch(url, { headers, signal: abort.signal });
          if (!res.ok || !res.body) {
            throw new OpencodeError(`event stream rejected: ${res.status}`, res.status);
          }
          handlers.onOpen?.();
          attempt = 0;
          this.logger.info("event stream connected", { url: url.origin + url.pathname });

          for await (const chunk of sseParse(res.body, abort.signal)) {
            if (stopped || abort.signal.aborted) break;
            lastEventAt = Date.now();
            let event: BridgeEvent;
            try {
              event = toBridgeEvent(
                JSON.parse(chunk) as Record<string, unknown>,
                this.messageRoles,
              );
            } catch {
              continue;
            }
            handlers.onEvent(event);
          }
          if (stopped || abort.signal.aborted) break;
          lastError = new OpencodeError("event stream closed");
          handlers.onError(lastError as Error);
        } catch (err) {
          if (stopped || abort.signal.aborted) break;
          lastError = err;
          handlers.onError(err instanceof Error ? err : new Error(String(err)));
        }

        if (stopped || abort.signal.aborted) break;

        const now = Date.now();
        if (now - lastEventAt >= this.timings.sleepThresholdMs) {
          this.logger.info("event stream idle past sleep threshold — resetting backoff");
          attempt = 0;
          lastEventAt = now;
        }

        const track = isConnectionError(lastError)
          ? this.timings.connectBackoffMs
          : this.timings.fastBackoffMs;
        const base = track[Math.min(attempt, track.length - 1)] ?? 30_000;
        const delay = jitter(base);
        if (now - startedAt >= this.timings.giveUpAfterMs) {
          this.logger.error("event stream gave up after 10 minutes");
          return;
        }
        attempt++;
        this.logger.debug("event stream reconnecting", { attempt, delay });
        await sleep(delay);
      }
    };

    void run()
      .catch((err) => {
        this.logger.error("event stream loop crashed", { error: String(err) });
      })
      .finally(() => {
        handlers.onClose?.();
      });

    const handle: EventStreamHandle = {
      close: () => {
        stopped = true;
        abort.abort();
        signal?.removeEventListener("abort", onAbort);
      },
    };
    this.stream = handle;
    return handle;
  }

  private get authHeader(): string | undefined {
    return this.authorization;
  }

  close(): void {
    this.stream?.close();
    this.stream = undefined;
  }
}

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|fetch failed|aborted/i.test(msg);
}

function jitter(ms: number): number {
  const delta = ms * 0.25;
  return Math.max(0, Math.round(ms - delta + Math.random() * delta * 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toSummary(raw: Record<string, unknown>): SessionSummary {
  const time = (raw.time ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    ...(raw.directory ? { directory: String(raw.directory) } : {}),
    ...(raw.parentID ? { parentId: String(raw.parentID) } : {}),
    ...(typeof time.created === "number" ? { createdAt: time.created } : {}),
    ...(typeof time.updated === "number" ? { updatedAt: time.updated } : {}),
  };
}

function toPart(
  p: Record<string, unknown>,
  sessionId: string,
  messageId: string,
  role: MessagePart["role"],
): MessagePart {
  const state = (p.state ?? undefined) as Record<string, unknown> | undefined;
  return {
    id: String(p.id ?? ""),
    sessionId: String(p.sessionID ?? sessionId),
    messageId: String(p.messageID ?? messageId),
    type: String(p.type ?? "text"),
    role,
    ...(typeof p.text === "string" ? { text: p.text } : {}),
    ...(typeof p.tool === "string" ? { tool: p.tool } : {}),
    ...(state
      ? {
          state: {
            ...(typeof state.status === "string" ? { status: state.status } : {}),
            ...(state.input !== undefined ? { input: state.input } : {}),
            ...(typeof state.title === "string" ? { title: state.title } : {}),
            ...(typeof state.output === "string" ? { output: state.output } : {}),
            ...(typeof state.error === "string" ? { error: state.error } : {}),
          },
        }
      : {}),
  };
}

/**
 * Maps opencode's event union onto our narrower {@link BridgeEvent}.
 *
 * `message.part.updated` does not carry the message's role; that arrives
 * separately on `message.updated`. We correlate the two by `messageID` so the
 * renderer can tell the user's prompt from the assistant's reply. Without this
 * the bot would echo your own message back at you as though it were the answer.
 *
 * When a part arrives for a message we have never seen a role for, we assume
 * assistant. That is the safe direction to be wrong in: showing an extra
 * message is a cosmetic bug, while dropping the reply is a broken product.
 */
export function toBridgeEvent(
  raw: Record<string, unknown>,
  roles: Map<string, MessagePart["role"]>,
): BridgeEvent {
  const type = String(raw.type ?? "");
  const props = (raw.properties ?? {}) as Record<string, unknown>;
  switch (type) {
    case "message.updated": {
      const info = (props.info ?? {}) as Record<string, unknown>;
      const id = String(info.id ?? "");
      const role = String(info.role ?? "");
      if (id && (role === "user" || role === "assistant" || role === "system")) {
        roles.set(id, role);
      }
      return { type: "unknown", rawType: "message.updated", properties: {} };
    }
    case "message.part.updated": {
      const part = toPart(
        (props.part ?? {}) as Record<string, unknown>,
        String((props.part as Record<string, unknown>)?.sessionID ?? ""),
        String((props.part as Record<string, unknown>)?.messageID ?? ""),
        "assistant",
      );
      const role = roles.get(part.messageId) ?? "assistant";
      return {
        type: "message.part",
        sessionId: part.sessionId,
        part: { ...part, role },
        ...(typeof props.delta === "string" ? { delta: props.delta } : {}),
      };
    }
    case "permission.asked":
    case "permission.updated": {
      // Both names exist in the wild: 1.18.35's `/event` emits `permission.asked`,
      // and older docs/SDK typings describe `permission.updated`. Accepting both
      // costs nothing and a missing variant means approvals never arrive.
      const time = (props.time ?? {}) as Record<string, unknown>;
      const tool = props.tool as Record<string, unknown> | undefined;
      const request: PermissionRequest = {
        id: String(props.id ?? ""),
        sessionId: String(props.sessionID ?? ""),
        // Live payload uses `permission` for the tool name and `title` is
        // absent; fall back so the card always has something to show.
        type: String(props.type ?? props.permission ?? "unknown"),
        title: String(
          props.title ??
            firstPattern(props.patterns, props.pattern) ??
            "Opencode is requesting permission",
        ),
        ...(props.messageID || tool?.messageID
          ? { messageId: String(props.messageID ?? tool?.messageID) }
          : {}),
        createdAt: typeof time.created === "number" ? time.created : Date.now(),
      };
      return { type: "permission.asked", request };
    }
    case "permission.replied":
      return {
        type: "permission.replied",
        reply: {
          sessionId: String(props.sessionID ?? ""),
          permissionId: String(props.permissionID ?? ""),
          response: String(props.response ?? ""),
        },
      };
    case "session.idle":
      return { type: "session.idle", sessionId: String(props.sessionID ?? "") };
    case "session.status":
      return props.status && (props.status as Record<string, unknown>).type === "busy"
        ? { type: "session.busy", sessionId: String(props.sessionID ?? "") }
        : { type: "session.idle", sessionId: String(props.sessionID ?? "") };
    case "session.error":
      return {
        type: "session.error",
        sessionId: String(props.sessionID ?? ""),
        message: errorMessage(props.error),
      };
    case "session.created":
    case "session.updated": {
      // Verified against a live 1.18.35 server: the session object arrives
      // nested under `properties.info`, not at the top level.
      const info = (props.info ?? props) as Record<string, unknown>;
      return {
        type: type === "session.created" ? "session.created" : "session.updated",
        session: toSummary(info),
      };
    }
    case "session.deleted":
      return { type: "session.deleted", sessionId: String(props.sessionID ?? props.id ?? "") };
    case "message.part.delta": {
      // Verified against a live 1.18.35 server: token-level deltas arrive as a
      // separate event, not as a `delta` field on `message.part.updated`.
      // Without this the user watches nothing stream and only sees the reply
      // once it is complete.
      const sessionId = String(props.sessionID ?? "");
      const messageId = String(props.messageID ?? "");
      const part: MessagePart = {
        id: String(props.partID ?? ""),
        sessionId,
        messageId,
        type: "text",
        role: roles.get(messageId) ?? "assistant",
      };
      return {
        type: "message.part",
        sessionId,
        part,
        delta: String(props.delta ?? ""),
      };
    }
    case "file.edited":
      return { type: "file.edited", file: String(props.file ?? props.path ?? "") };
    default:
      return { type: "unknown", rawType: type, properties: props };
  }
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "unknown error";
}

/**
 * Minimal SSE frame reader. The SDK ships its own, but using `fetch` directly
 * here means we control abort semantics, and it keeps the `authHeader` path
 * explicit rather than depending on client internals.
 */
export async function* sseParse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line. Drain every complete frame in
      // the buffer, then keep the remainder for the next chunk — a partial
      // frame must not be yielded as if it were complete.
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data) yield data;
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * §3.2 — v2 placeholder. The surface exists (`@opencode-ai/sdk/v2`) with a
 * richer event vocabulary, but it is newer and thinly documented, so it stays
 * unimplemented until opencode 2.x. This class is what a v2 implementation
 * would replace; nothing outside `opencode.ts` changes when it lands.
 */
export function createV2Transport(
  _opts: TransportOptions,
  _deps: ClassicTransportDeps,
): OpencodeTransport {
  throw new OpencodeError("the opencode v2 surface is not enabled in this build; see PLAN.md §3.2");
}

/**
 * Shared test helpers: a temporary state directory and a stub transport that
 * speaks the `OpencodeTransport` interface without touching the network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog, createLogger } from "../packages/core/src/logger.ts";
import type {
  BridgeEvent,
  EventStreamHandle,
  EventStreamHandlers,
  FileDiff,
  MessagePart,
  OpencodeTransport,
  PromptInput,
  SessionStatusEntry,
  SessionSummary,
} from "../packages/core/src/transport.ts";
import type { ResolvedRuntimeConfig } from "../packages/core/src/types.ts";

export function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-rc-test-"));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function testLogger(stateDir: string) {
  return createLogger({
    logDir: join(stateDir, "logs"),
    level: "debug",
    stateDir,
    salt: "test-salt-0000000000000000",
    maxBytes: 1024 * 1024,
  });
}

export function testAudit(stateDir: string): AuditLog {
  return new AuditLog({
    path: join(stateDir, "logs", "audit.jsonl"),
    salt: "test-salt-0000000000000000",
    stateDir,
  });
}

export function testConfig(
  stateDir: string,
  overrides: Partial<ResolvedRuntimeConfig> = {},
): ResolvedRuntimeConfig {
  return {
    stateDir,
    logDir: join(stateDir, "logs"),
    opencodeUrl: "http://127.0.0.1:4096",
    access: { disabled: false, allowFrom: [], groups: {}, requireMention: true },
    logLevel: "debug",
    debugFilter: [],
    logRotateMaxBytes: 1024 * 1024,
    logRotateMaxFiles: 3,
    logRetentionDays: 7,
    auditRetentionDays: 90,
    actorMode: "hash",
    maxTurnsPerPrompt: 50,
    maxNotificationsPerRun: 20,
    maxConcurrentSessions: 4,
    requirePermissionAsk: true,
    ...overrides,
  };
}

export class FakeTransport implements OpencodeTransport {
  readonly surface = "fake";
  readonly baseUrl = "http://127.0.0.1:4096";

  readonly prompts: PromptInput[] = [];
  readonly aborts: string[] = [];
  readonly answers: { sessionId: string; permissionId: string; response: string }[] = [];
  readonly created: SessionSummary[] = [];
  permissionModeValue: string | undefined = "ask";
  private counter = 0;
  private handlers: EventStreamHandlers | undefined;

  async createSession(opts: { title?: string } = {}): Promise<SessionSummary> {
    this.counter++;
    const session: SessionSummary = {
      id: `ses_${String(this.counter).padStart(4, "0")}`,
      title: opts.title ?? "fake",
    };
    this.created.push(session);
    return session;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.created;
  }

  async getSession(id: string): Promise<SessionSummary | undefined> {
    return this.created.find((s) => s.id === id);
  }

  async prompt(input: PromptInput): Promise<void> {
    this.prompts.push(input);
  }

  async abort(sessionId: string): Promise<void> {
    this.aborts.push(sessionId);
  }

  async status(): Promise<SessionStatusEntry[]> {
    return [];
  }

  async diff(): Promise<FileDiff[]> {
    return [];
  }

  async messages(): Promise<MessagePart[]> {
    return [];
  }

  async answerPermission(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    this.answers.push({ sessionId, permissionId, response });
  }

  async models(): Promise<{ providerID: string; modelID: string }[]> {
    return [{ providerID: "anthropic", modelID: "claude-sonnet-4" }];
  }

  async permissionMode(): Promise<string | undefined> {
    return this.permissionModeValue;
  }

  async streamEvents(handlers: EventStreamHandlers): Promise<EventStreamHandle> {
    this.handlers = handlers;
    return {
      close: () => {
        this.handlers = undefined;
      },
    };
  }

  /** Test hook: push an event as if opencode had sent it. */
  emit(event: BridgeEvent): void {
    this.handlers?.onEvent(event);
  }

  close(): void {}
}

export function part(overrides: Partial<MessagePart> = {}): MessagePart {
  return {
    id: "prt_1",
    sessionId: "ses_0001",
    messageId: "msg_1",
    type: "text",
    role: "assistant",
    text: "",
    ...overrides,
  };
}

export function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

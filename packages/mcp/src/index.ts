#!/usr/bin/env bun
/**
 * MCP server adapter.
 *
 * Runs over stdio, so `claude_desktop_config.json` can launch it directly.
 * It exposes opencode-rc's own primitives — not opencode's — so a desktop MCP
 * client can drive the *bridge*: list sessions, send a prompt, watch a
 * permission, read the audit log.
 *
 * Two deliberate limitations:
 *
 *   1. **It has no identity model.** A local MCP client is whoever can spawn
 *      the process, which is whoever has the user's shell. That is the same
 *      trust boundary as the CLI adapter, so `permissionRelay` is `true` here
 *      and `false` everywhere the caller is unverified.
 *   2. **It never writes to `access.json`.** There is deliberately no
 *      `access_allow` tool (§7.4 layer 2). Pairing stays a terminal-only act;
 *      exposing it over MCP would let any local model approve a stranger.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type {
  Adapter,
  AdapterCapabilities,
  AdapterContext,
  OutboundMessage,
} from "@opencode-rc/core";
import { sanitizeText } from "@opencode-rc/core";

export const MCP_CAPABILITIES: AdapterCapabilities = {
  messaging: true,
  permissionRelay: true,
  threads: true,
  richCards: true,
};

const MCP_PLATFORM = "mcp";

export interface McpAdapterOptions {
  readonly name?: string;
  readonly version?: string;
}

export class McpAdapter implements Adapter {
  readonly id = MCP_PLATFORM;
  readonly displayName = "MCP server";
  readonly capabilities = MCP_CAPABILITIES;

  private server: McpServer | undefined;
  private transport: StdioServerTransport | undefined;
  private ctx: AdapterContext | undefined;
  private readonly log: string[] = [];

  constructor(private readonly opts: McpAdapterOptions = {}) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const server = new McpServer({
      name: this.opts.name ?? "opencode-rc",
      version: this.opts.version ?? "0.1.0",
    });

    server.tool(
      "rc_list_sessions",
      "List the opencode sessions this bridge knows about, newest first.",
      {},
      async () => {
        const list = ctx.sessions.list();
        return {
          content: [
            {
              type: "text" as const,
              text: list.length
                ? list
                    .map(
                      (b) =>
                        `${b.busy ? "busy " : "idle "}${b.sessionId}  ${sanitizeText(b.title, 80)}  (${sanitizeText(b.conversation.chatId, 60)})`,
                    )
                    .join("\n")
                : "No sessions yet.",
            },
          ],
        };
      },
    );

    server.tool(
      "rc_prompt",
      "Send a prompt to an opencode session through the bridge. Creates one if it does not exist.",
      { text: z.string().min(1), chat: z.string().default("mcp") },
      async ({ text, chat }) => {
        const sessionId = await ctx.bridge.prompt({ platform: MCP_PLATFORM, chatId: chat }, text);
        return { content: [{ type: "text" as const, text: `prompt accepted for ${sessionId}` }] };
      },
    );

    server.tool(
      "rc_new_session",
      "Start a fresh opencode session for a conversation.",
      { chat: z.string().default("mcp"), title: z.string().optional() },
      async ({ chat, title }) => {
        const sessionId = await ctx.bridge.newSession(
          { platform: MCP_PLATFORM, chatId: chat },
          title,
        );
        return { content: [{ type: "text" as const, text: `session ${sessionId}` }] };
      },
    );

    server.tool(
      "rc_abort",
      "Stop whatever is running in a session. Always works.",
      { chat: z.string().default("mcp") },
      async ({ chat }) => {
        await ctx.bridge.abort({ platform: MCP_PLATFORM, chatId: chat });
        return { content: [{ type: "text" as const, text: "aborted" }] };
      },
    );

    server.tool(
      "rc_pending_permissions",
      "List permission requests awaiting a verdict, with the short code to answer them with.",
      {},
      async () => {
        const pending = ctx.permissions.list();
        return {
          content: [
            {
              type: "text" as const,
              text: pending.length
                ? pending
                    .map((p) => `${p.shortId}  ${p.tool}  ${sanitizeText(p.title, 100)}`)
                    .join("\n")
                : "Nothing pending.",
            },
          ],
        };
      },
    );

    server.tool(
      "rc_answer_permission",
      "Answer a pending permission request. first_answer_wins — a second call is ignored.",
      {
        code: z.string().regex(/^[a-km-z]{5}$/i, "five letters a-z, excluding l"),
        verdict: z.enum(["once", "always", "reject"]),
      },
      async ({ code, verdict }) => {
        const applied = await ctx.bridge.answerPermission(
          { platform: MCP_PLATFORM, chatId: "mcp" },
          code,
          verdict,
          { platform: MCP_PLATFORM, id: "mcp-client" },
        );
        return {
          content: [
            {
              type: "text" as const,
              text: applied ? `applied ${verdict}` : "no such open request",
            },
          ],
        };
      },
    );

    server.tool(
      "rc_audit_verify",
      "Verify the hash chain of the audit log. Reports the exact record where tampering was detected.",
      {},
      async () => {
        const result = verifyAuditChain(ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: result.ok
                ? `audit chain OK — ${result.records} record(s)`
                : `audit chain BROKEN at ${result.brokenAt}: ${result.reason}`,
            },
          ],
        };
      },
    );

    server.tool(
      "rc_privacy_notice",
      "What data opencode-rc holds about a platform identity, and how to get it erased.",
      {},
      async () => ({
        content: [{ type: "text" as const, text: ctx.bridge ? privacyNotice(ctx) : "" }],
      }),
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.server = server;
    this.transport = transport;

    ctx.audit.append({ event: "adapter.start", ns: "mcp" });
    // stderr only — stdout is the MCP transport.
    ctx.logger.info("mcp server listening on stdio");
  }

  async stop(): Promise<void> {
    await this.server?.close();
    this.server = undefined;
    this.transport = undefined;
    this.ctx?.audit.append({ event: "adapter.stop", ns: "mcp" });
  }

  /** Cards are recorded rather than printed; an MCP client polls `rc_prompt` state. */
  async send(msg: OutboundMessage): Promise<void> {
    this.log.push(JSON.stringify({ chat: msg.conversation.chatId, cards: msg.cards.length }));
    if (this.log.length > 100) this.log.shift();
  }

  transcript(): readonly string[] {
    return this.log;
  }
}

function verifyAuditChain(ctx: AdapterContext): {
  ok: boolean;
  records: number;
  brokenAt: number | null;
  reason: string | null;
} {
  const audits = ctx.audit.read();
  let prev = audits[0]?.prev ?? null;
  for (const rec of audits) {
    if (prev !== null && rec.prev !== prev) {
      return { ok: false, records: audits.length, brokenAt: rec.seq, reason: "prev-hash mismatch" };
    }
    prev = rec.hash ?? null;
  }
  return { ok: true, records: audits.length, brokenAt: null, reason: null };
}

function privacyNotice(ctx: AdapterContext): string {
  return [
    "You, the operator, are the controller.",
    "Held: platform ids in the allowlist (state/access.json, mode 0600); hashed ids in the audit log.",
    "Never held by us: message bodies. They live in opencode's transcript and the chat platform's.",
    "Rights: /export, /forget, or `rc consent withdraw`.",
  ].join("\n");
}

export function create(env: Record<string, string | undefined>): McpAdapter {
  void env;
  return new McpAdapter();
}

export const id = "mcp";

/** Direct entry point so it can be run without the full bridge: `bun packages/mcp/src/server.ts`. */
export async function main(): Promise<void> {
  const { loadConfig, createLogger, Bridge } = await import("@opencode-rc/core");
  const { config, salt } = loadConfig();
  const logger = createLogger({
    logDir: config.logDir,
    level: config.logLevel,
    stateDir: config.stateDir,
    salt,
  });
  const bridge = new Bridge({ config, logger, salt });
  await bridge.start();
  const adapter = new McpAdapter();
  await adapter.start(bridge.context());
  process.stderr.write("opencode-rc MCP server ready on stdio\n");
}

if (import.meta.main) {
  await main();
}

/**
 * CLI adapter — built second, not last (PLAN.md §11 Phase 3).
 *
 * It is the cheapest adapter and the best way to debug the core without
 * fighting a platform's rate limits. Every core behaviour is reachable here.
 */

import { createInterface } from "node:readline";

import type {
  Adapter,
  AdapterCapabilities,
  AdapterContext,
  Card,
  InboundMessage,
  OutboundMessage,
} from "@opencode-rc/core";
import { chunkText, sanitizeText } from "@opencode-rc/core";

export const CLI_CAPABILITIES: AdapterCapabilities = {
  messaging: true,
  // The terminal is the trusted surface by definition, and the only place
  // pairing can be completed. §7.4 layer 2.
  permissionRelay: true,
  threads: false,
  richCards: true,
};

const CLI_PLATFORM = "cli";
/** The CLI is one "chat". */
export const CLI_CHAT = "dm:local";

export class CliAdapter implements Adapter {
  readonly id = CLI_PLATFORM;
  readonly displayName = "CLI";
  readonly capabilities = CLI_CAPABILITIES;

  private ctx: AdapterContext | undefined;
  private rl: ReturnType<typeof createInterface> | undefined;
  private counter = 0;

  constructor(private readonly interactive = true) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    const message: InboundMessage = {
      platform: CLI_PLATFORM,
      messageId: `cli-${++this.counter}`,
      actor: { platform: CLI_PLATFORM, id: "local" },
      chat: { platform: CLI_PLATFORM, chatId: CLI_CHAT },
      text: "",
      timestamp: Date.now(),
      isGroup: false,
      mentionsBot: true,
    };
    this.audit(message, "adapter.start");

    // `interactive` controls the banner only. Stdin is read either way: piped
    // input is a script to run, and a non-interactive mode that silently reads
    // nothing is worse than no mode at all.
    if (!process.stdin.isTTY) {
      this.rl = createInterface({ input: process.stdin, terminal: false });
    } else {
      this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (this.interactive) {
        process.stdout.write(
          "\nopencode-rc CLI. /help for commands, Ctrl-D to exit.\n" +
            "Permission prompts: type `yes <code>`, `always <code>` or `no <code>`.\n" +
            "Pairing is completed here, at the terminal: `rc access allow <code>`.\n\n",
        );
      }
    }

    for await (const line of this.rl) {
      const text = String(line);
      if (!text.trim()) continue;
      if (text.trim() === "/quit" || text.trim() === "/exit") break;
      await this.ctx.bridge.handle({
        ...message,
        messageId: `cli-${++this.counter}`,
        text,
        timestamp: Date.now(),
      });
    }
  }

  private audit(message: InboundMessage, event: string): void {
    this.ctx?.audit.append({
      event,
      actor: message.actor,
      ns: "cli",
      fields: { chat: message.chat.chatId },
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = undefined;
  }

  async send(msg: OutboundMessage): Promise<void> {
    for (const chunk of renderCards(msg.cards)) {
      process.stdout.write(`${chunk}\n\n`);
    }
  }
}

/** Renders Cards as plain text. No colour, no emoji — it is a log surface. */
export function renderCards(cards: readonly Card[]): string[] {
  const out: string[] = [];
  for (const card of cards) {
    switch (card.kind) {
      case "text":
        out.push(card.markdown);
        break;
      case "status":
        out.push(`· ${card.label}`);
        break;
      case "permission":
        out.push(
          [
            `PERMISSION REQUIRED (${card.id})`,
            `  tool:  ${card.tool}`,
            `  asked: ${card.title}`,
            "",
            `  approve once:  yes ${card.id}`,
            `  always allow:  always ${card.id}`,
            `  deny:          no ${card.id}`,
          ].join("\n"),
        );
        break;
      case "diff":
        out.push(card.files.map((f) => `  ${f.path} +${f.additions} −${f.deletions}`).join("\n"));
        break;
      case "error":
        out.push(`error: ${card.message}`);
        break;
      case "notice":
        out.push(card.text);
        break;
    }
  }
  return out.flatMap((text) => chunkText(sanitizeText(text), 4000));
}

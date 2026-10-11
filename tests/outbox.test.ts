/**
 * §7.5 rate limiting and §7.6 overflow collapse.
 */

import { describe, expect, test } from "bun:test";

import { createLogger } from "../packages/core/src/logger.ts";
import {
  DEFAULT_QUEUE_CAP,
  EDIT_THROTTLE_MS,
  MIN_GAP_MS,
  Outbox,
  parseRetryAfter,
} from "../packages/core/src/outbox.ts";
import type { Card, OutboundMessage } from "../packages/core/src/types.ts";
import { cleanup, tempStateDir } from "./helpers.ts";

function quietLogger() {
  const dir = tempStateDir();
  return { logger: createLogger({ logDir: `${dir}/logs`, level: "silent", salt: "s" }), dir };
}

function msg(text: string, chatId = "c1"): OutboundMessage {
  return {
    conversation: { platform: "test", chatId },
    cards: [{ kind: "text", markdown: text } as Card],
  };
}

describe("constants", () => {
  test("match §10.1 — Telegram's practical flood floor", () => {
    expect(MIN_GAP_MS).toBe(1100);
    expect(EDIT_THROTTLE_MS).toBe(1000);
  });
});

describe("pacing", () => {
  test("enforces the minimum gap between messages to one chat", async () => {
    const { logger, dir } = quietLogger();
    try {
      const times: number[] = [];
      const outbox = new Outbox(
        async () => {
          times.push(Date.now());
        },
        { logger, minGapMs: 50 },
      );

      const start = Date.now();
      for (let i = 0; i < 4; i++) outbox.push(msg(`m${i}`));
      await new Promise((r) => setTimeout(r, 400));

      expect(times).toHaveLength(4);
      for (let i = 1; i < times.length; i++) {
        expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(45);
      }
      void start;
      await outbox.stop();
    } finally {
      cleanup(dir);
    }
  });

  test("different chats do not block each other", async () => {
    const { logger, dir } = quietLogger();
    try {
      let sent = 0;
      const outbox = new Outbox(
        async () => {
          sent++;
        },
        { logger, minGapMs: 500 },
      );
      outbox.push(msg("a", "chat-a"));
      outbox.push(msg("b", "chat-b"));
      await new Promise((r) => setTimeout(r, 60));
      expect(sent).toBe(2);
      await outbox.stop();
    } finally {
      cleanup(dir);
    }
  });

  test("honours a platform retry_after", async () => {
    const { logger, dir } = quietLogger();
    try {
      const times: number[] = [];
      let first = true;
      const outbox = new Outbox(
        async () => {
          times.push(Date.now());
          if (first) {
            first = false;
            const err = new Error("flood") as Error & { retry_after?: number };
            err.retry_after = 0.2;
            throw err;
          }
        },
        { logger, minGapMs: 0 },
      );

      outbox.push(msg("a"));
      outbox.push(msg("b"));
      // retry_after is 200ms, so give the queue room to retry.
      await new Promise((r) => setTimeout(r, 400));
      expect(times).toHaveLength(2);
      expect((times[1] as number) - (times[0] as number)).toBeGreaterThanOrEqual(180);
      await outbox.stop();
    } finally {
      cleanup(dir);
    }
  });

  test("a failed send does not lose the rest of the queue", async () => {
    const { logger, dir } = quietLogger();
    try {
      const sent: string[] = [];
      let n = 0;
      const outbox = new Outbox(
        async () => {
          n++;
          if (n === 1) throw new Error("transient");
          sent.push(String(n));
        },
        { logger, minGapMs: 0 },
      );
      for (let i = 0; i < 3; i++) outbox.push(msg(`m${i}`));
      await new Promise((r) => setTimeout(r, 100));
      expect(sent.length).toBeGreaterThanOrEqual(2);
      await outbox.stop();
    } finally {
      cleanup(dir);
    }
  });
});

describe("overflow", () => {
  test("collapses rather than growing without bound", async () => {
    const { logger, dir } = quietLogger();
    try {
      const delivered: string[] = [];
      const outbox = new Outbox(
        async (m) => {
          const card = m.cards[0];
          if (card?.kind === "text") delivered.push(card.markdown);
          if (card?.kind === "notice") delivered.push(card.text);
        },
        { logger, minGapMs: 0, queueCap: 5 },
      );

      for (let i = 0; i < 50; i++) outbox.push(msg(`m${i}`));
      expect(outbox.pending("test:c1")).toBeLessThanOrEqual(DEFAULT_QUEUE_CAP);
      await new Promise((r) => setTimeout(r, 100));

      // The early messages are replaced by one summary line, not 50 messages.
      expect(delivered.length).toBeLessThan(15);
      expect(delivered.some((d) => d.includes("collapsed"))).toBe(true);
      await outbox.stop();
    } finally {
      cleanup(dir);
    }
  });
});

describe("edit throttling", () => {
  test("permits one edit per second and then refuses", () => {
    const { logger, dir } = quietLogger();
    try {
      const outbox = new Outbox(async () => {}, { logger, minGapMs: 0 });
      const key = "test:c1";
      expect(outbox.canEdit(key)).toBe(true);
      outbox.markEdited(key);
      expect(outbox.canEdit(key)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });
});

describe("parseRetryAfter", () => {
  test("reads Telegram's parameters.retry_after (seconds)", () => {
    expect(parseRetryAfter({ parameters: { retry_after: 3 } })).toBe(3000);
  });

  test("reads a millisecond hint from our own adapters", () => {
    expect(parseRetryAfter({ retryAfterMs: 2500 })).toBe(2500);
  });

  test("reads a seconds hint from Discord REST", () => {
    expect(parseRetryAfter({ retry_after: 2.5 })).toBe(2500);
  });

  test("reads an HTTP Retry-After header (seconds)", () => {
    expect(parseRetryAfter({ headers: { "retry-after": "5" } })).toBe(5000);
  });

  test("is capped so a hostile value cannot stall the queue forever", () => {
    expect(parseRetryAfter({ retry_after: 99999 })).toBe(60_000);
  });

  test("returns undefined when there is no hint", () => {
    expect(parseRetryAfter(new Error("boom"))).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

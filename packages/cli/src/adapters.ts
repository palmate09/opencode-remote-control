/**
 * Optional adapter loading.
 *
 * Every adapter lives in its own workspace package and is enabled by an
 * environment flag. Each is imported dynamically so a missing token, a missing
 * package, or a broken third-party SDK can never take down a bridge that does
 * not use it — that isolation is a mitigation, not an accident (PLAN.md §13).
 */

import type { Adapter } from "@opencode-rc/core";

interface AdapterModule {
  create(options: Record<string, string | undefined>): Adapter;
  readonly id: string;
}

const CANDIDATES: readonly { env: string; module: string; id: string; keys: readonly string[] }[] =
  [
    {
      env: "RC_TELEGRAM_ENABLED",
      module: "@opencode-rc/telegram",
      id: "telegram",
      keys: ["RC_TELEGRAM_BOT_TOKEN"],
    },
    {
      env: "RC_DISCORD_ENABLED",
      module: "@opencode-rc/discord",
      id: "discord",
      keys: ["RC_DISCORD_BOT_TOKEN"],
    },
    {
      env: "RC_SLACK_ENABLED",
      module: "@opencode-rc/slack",
      id: "slack",
      keys: ["RC_SLACK_BOT_TOKEN", "RC_SLACK_APP_TOKEN"],
    },
    {
      env: "RC_WEBHOOK_ENABLED",
      module: "@opencode-rc/webhook",
      id: "webhook",
      keys: ["RC_WEBHOOK_TOKEN"],
    },
    {
      env: "RC_API_ENABLED",
      module: "@opencode-rc/api",
      id: "api",
      keys: ["RC_API_PASSWORD"],
    },
    {
      env: "RC_MCP_ENABLED",
      module: "@opencode-rc/mcp",
      id: "mcp",
      keys: [],
    },
  ];

export function isEnabled(env: Record<string, string | undefined>, flag: string): boolean {
  const v = (env[flag] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function enabledAdapters(env: Record<string, string | undefined>): string[] {
  return CANDIDATES.filter((c) => isEnabled(env, c.env)).map((c) => c.id);
}

export interface LoadedAdapters {
  readonly adapters: Adapter[];
  readonly names: string[];
  /** Enabled but not loadable — surfaced by `doctor`, never fatal. */
  readonly failures: { id: string; reason: string }[];
}

export async function loadOptionalAdapters(
  env: Record<string, string | undefined>,
): Promise<LoadedAdapters> {
  const adapters: Adapter[] = [];
  const names: string[] = [];
  const failures: { id: string; reason: string }[] = [];

  for (const candidate of CANDIDATES) {
    if (!isEnabled(env, candidate.env)) continue;

    const missing = candidate.keys.filter((k) => !env[k]);
    if (missing.length > 0) {
      failures.push({ id: candidate.id, reason: `missing ${missing.join(", ")}` });
      process.stderr.write(
        `rc: ${candidate.id} is enabled but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset — skipping\n`,
      );
      continue;
    }

    try {
      const mod = (await import(candidate.module)) as unknown as AdapterModule;
      adapters.push(mod.create(env));
      names.push(candidate.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ id: candidate.id, reason });
      process.stderr.write(`rc: could not load ${candidate.id}: ${reason}\n`);
    }
  }

  return { adapters, names, failures };
}

/**
 * `rc run` — boots the bridge and every enabled adapter.
 *
 * Adapters are selected by environment (§5.1: each adapter lives in its own
 * package and imports only `@opencode-rc/core`). Nothing here knows what a
 * Telegram message looks like.
 */

import type { Adapter } from "@opencode-rc/core";
import { Bridge, PreconditionError, createLogger, loadConfig } from "@opencode-rc/core";

import { CliAdapter } from "./adapter.ts";

export interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly stateDir?: string;
  readonly adapters?: Adapter[];
  readonly skipPreconditions?: boolean;
  /** Adapters to enable in addition to whatever env selects. */
  readonly extra?: Adapter[];
  /** Run in background as a daemon. */
  readonly detach?: boolean;
  /** PID file path when running detached. */
  readonly pidFile?: string;
}

export interface RunHandle {
  readonly bridge: Bridge;
  readonly adapters: Adapter[];
  stop(): Promise<void>;
}

/** §10.3 — SIGTERM → SIGKILL after 30s. */
export const SHUTDOWN_GRACE_MS = 30_000;

export async function runBridge(opts: RunOptions = {}): Promise<RunHandle> {
  const { config, salt } = loadConfig({
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
  });

  const logger = createLogger({
    logDir: config.logDir,
    level: config.logLevel,
    debugFilter: config.debugFilter,
    stateDir: config.stateDir,
    maxBytes: config.logRotateMaxBytes,
    maxFiles: config.logRotateMaxFiles,
    actorMode: config.actorMode,
    salt,
  });

  const bridge = new Bridge({ config, logger, salt });
  const adapters: Adapter[] = [...(opts.adapters ?? []), ...(opts.extra ?? [])];

  for (const adapter of adapters) bridge.attach(adapter);

  if (!opts.skipPreconditions) {
    try {
      await bridge.verifyPreconditions();
    } catch (err) {
      logger.error("precondition failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof PreconditionError) {
        throw err;
      }
      throw new PreconditionError(
        `Could not verify opencode is reachable: ${err instanceof Error ? err.message : String(err)}`,
        "Is `opencode web` running? Check RC_OPENCODE_URL.",
      );
    }
  }

  await bridge.start();

  // Adapters start after the hub so `ctx.hub` is live when they subscribe.
  for (const adapter of adapters) {
    try {
      await adapter.start(bridge.context());
    } catch (err) {
      logger.error("adapter failed to start", { adapter: adapter.id, error: String(err) });
      // One broken adapter must not take down the others (PLAN.md §13).
    }
  }

  if (opts.detach) {
    await daemonize(opts.pidFile, logger);
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => {
      logger.error("shutdown exceeded grace period, exiting hard");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref?.();
    for (const adapter of adapters) {
      try {
        await adapter.stop();
      } catch (err) {
        logger.warn("adapter stop failed", { adapter: adapter.id, error: String(err) });
      }
    }
    await bridge.stop();
    clearTimeout(timer);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info(`received ${signal}, shutting down`);
      void stop().then(() => process.exit(0));
    });
  }

  return { bridge, adapters, stop };
}

/**
 * Double-fork daemonization. Detaches from the controlling terminal,
 * redirects stdio to /dev/null, and writes the daemon PID to a file.
 */
async function daemonize(
  pidFile?: string,
  logger?: ReturnType<typeof createLogger>,
): Promise<void> {
  const log = logger?.child("daemonize") ?? console;

  // Write a simple daemonization script
  const script = [
    "#!/bin/sh",
    "# Double-fork daemonization for opencode-rc",
    "# Usage: $0 [pid-file]",
    "",
    "# First fork",
    "if [ $$ -ne 1 ]; then",
    "  exec setsid sh -c '",
    "    # Second fork - grandchild becomes daemon",
    "    if [ $$ -ne 1 ]; then",
    "      # Grandchild: daemon process",
    "      exec 0</dev/null",
    "      exec 1>/dev/null",
    "      exec 2>/dev/null",
    '      echo $$ > "${1:-/dev/null}"',
    '      exec "$0" "$@"',
    "    fi",
    '  \' -- "$@"',
    ") &",
    "",
  ].join("\n");

  const scriptPath = "/tmp/opencode-rc-daemonize.sh";
  await Bun.write(scriptPath, script, { mode: 0o755 });

  const result = Bun.spawnSync(["sh", scriptPath, pidFile ?? "/dev/null"], {
    stdout: "ignore",
    stderr: "ignore",
  });

  if (pidFile) {
    // Wait for daemon to write PID file
    await new Promise((r) => setTimeout(r, 200));
  }

  log.info("daemonized", { pid: process.pid, pidFile });
  process.exit(0);
}

/** The CLI is the default adapter: cheapest, and the best core debugger. */
export function cliAdapter(interactive = true): Adapter {
  return new CliAdapter(interactive);
}

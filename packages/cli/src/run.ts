/**
 * `rc run` — boots the bridge and every enabled adapter.
 *
 * Adapters are selected by environment (§5.1: each adapter lives in its own
 * package and imports only `@opencode-rc/core`). Nothing here knows what a
 * Telegram message looks like.
 */

import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";

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
  /** PID file to write once the bridge is up. */
  readonly pidFile?: string;
}

export interface RunHandle {
  readonly bridge: Bridge;
  readonly adapters: Adapter[];
  stop(): Promise<void>;
}

/** §10.3 — SIGTERM → SIGKILL after 30s. */
export const SHUTDOWN_GRACE_MS = 30_000;

export interface DetachResult {
  /** The daemon's pid, once it has written the pid file (or the spawn pid). */
  readonly pid: number | undefined;
  /** stderr from the daemon child, for an honest startup failure message. */
  readonly stderr: string;
  readonly exitCode: number | null;
}

/**
 * Marker in the child's environment. The daemon runs the *same* command, so
 * without this it would detach again, forever. Checking the environment rather
 * than sniffing argv means the child is indistinguishable from a foreground run
 * to everything downstream.
 */
const DETACHED_ENV = "RC_DETACHED";

export function isDetachChild(env: Record<string, string | undefined> = process.env): boolean {
  return env[DETACHED_ENV] === "1";
}

/**
 * Re-exec this command as a background daemon.
 *
 * The previous implementation wrote a shell script to `/tmp` that never
 * re-executed anything and then called `process.exit(0)` on the already-running
 * bridge — so `rc run --detach` started a foreground bridge, printed success,
 * and killed it. This spawns a genuinely detached child (`detached`, its own
 * session via `setsid` semantics, stdio to files), waits briefly for the pid
 * file, and returns so the parent exits.
 *
 * `Bun.spawn` (not `spawnSync`) is required: the child is long-lived.
 */
export async function daemonizeSpawn(
  args: readonly string[],
  opts: { pidFile?: string; env?: Record<string, string | undefined> } = {},
): Promise<DetachResult> {
  const env = { ...(opts.env ?? process.env), [DETACHED_ENV]: "1" };
  const errFile = opts.pidFile ? `${opts.pidFile}.err` : undefined;
  // Bun.spawn takes a file descriptor for stdio, not a path. Capture the
  // child's stderr so a fatal startup error surfaces before we claim success.
  const errFd = errFile ? openSync(errFile, "w") : -1;

  const proc = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: errFile ? errFd : "ignore",
    // New session, no controlling terminal: the daemon survives the parent.
    detached: true,
  });

  // The child holds its own dup of the fd; ours is no longer needed.
  if (errFd >= 0) closeSync(errFd);

  // Wait for the daemon to write its pid file so we can report a real pid,
  // and so a fatal startup error surfaces before we claim success.
  let pid = proc.pid;
  const deadline = Date.now() + 1500;
  while (opts.pidFile && Date.now() < deadline) {
    await sleep(50);
    if (existsSync(opts.pidFile)) {
      const raw = readFileSync(opts.pidFile, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) pid = parsed;
      break;
    }
    if (proc.exitCode !== null) break;
  }

  const stderr = errFile && existsSync(errFile) ? readFileSync(errFile, "utf8").trim() : "";
  void args; // reserved for future argv adjustments
  return { pid, stderr, exitCode: proc.exitCode ?? null };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

  // Record our pid once the bridge is actually up. The detached parent that
  // spawned us waits for this file to report a real pid; a foreground run with an
  // explicit --pid-file is useful for service managers too.
  if (opts.pidFile) {
    try {
      writeFileSync(opts.pidFile, `${process.pid}\n`, { mode: 0o600 });
      logger.info("wrote pid file", { pidFile: opts.pidFile, pid: process.pid });
    } catch (err) {
      logger.warn("could not write pid file", { pidFile: opts.pidFile, error: String(err) });
    }
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

/** The CLI is the default adapter: cheapest, and the best core debugger. */
export function cliAdapter(interactive = true): Adapter {
  return new CliAdapter(interactive);
}

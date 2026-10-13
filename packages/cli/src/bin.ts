#!/usr/bin/env bun
/**
 * `rc` entry point. Thin argument dispatch over `./commands.ts` and `./run.ts`.
 */

import { type Adapter, loadConfig } from "@opencode-rc/core";

import { CliAdapter } from "./adapter.ts";
import { loadOptionalAdapters } from "./adapters.ts";
import { runAccess, runAudit, runConsent, runDoctor, runInit } from "./commands.ts";
import { daemonizeSpawn, isDetachChild, runBridge } from "./run.ts";

const VERSION = "0.1.0";

const HELP = `opencode-rc ${VERSION} — remote control for opencode

  rc init                      create the state directory and first-run consent
  rc doctor                    check opencode, access policy and audit chain
  rc run [--cli] [--detach] [--pid-file <path>] [adapter...]  start the bridge
  rc access <sub>              allowlist and pairing control (terminal only)
  rc audit <sub>               verify, export or tail the audit log
  rc consent <sub>             show, grant or withdraw consent

access subcommands:
  list                         show the allowlist and group policies
  allow <6-hex-code>           approve a pending pairing
  revoke <platform:id>         remove an allowlist entry
  disable | enable             the master kill switch
  group <chatId> <policy>      open | close | allow <ids…> | mention <bool>

audit subcommands:
  verify                       check the hash chain
  export [--since <date>]      machine-readable records for an incident report
  tail [n]                     the last n records, human-readable

run options:
  --cli              enable CLI adapter (default if no adapters enabled)
  --detach           run as background daemon
  --pid-file <path>  write daemon PID to file (requires --detach)

Everything except message bodies is logged. Nothing is sent anywhere except
the opencode instance and the chat platforms you enabled.
`;

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}
function err(s: string): void {
  process.stderr.write(`${s}\n`);
}

function stateDir(): string {
  try {
    return loadConfig().stateDir;
  } catch {
    return process.env.RC_STATE_DIR ?? joinDefault();
  }
}

function joinDefault(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return xdg ? `${xdg}/opencode-rc` : `${process.env.HOME}/.local/state/opencode-rc`;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return 0;

    case "version":
    case "--version":
    case "-v":
      out(VERSION);
      return 0;

    case "init": {
      const result = runInit(process.env as Record<string, string | undefined>, args[0]);
      out(`initialised ${result.stateDir}`);
      for (const path of result.created) out(`  created ${path}`);
      out("");
      out("Next:");
      out("  1. put RC_OPENCODE_URL in your .env (see .env.example)");
      out("  2. bunx opencode-rc doctor");
      out("  3. bunx opencode-rc run");
      return 0;
    }

    case "doctor": {
      const checks = runDoctor(process.env as Record<string, string | undefined>);
      let failed = 0;
      for (const check of checks) {
        const mark = check.ok ? "✓" : "✗";
        if (!check.ok) failed++;
        out(`${mark} ${check.name}: ${check.detail}`);
        if (check.remedy) out(`    → ${check.remedy}`);
      }
      out("");
      out(failed === 0 ? "All checks passed." : `${failed} check(s) need attention.`);
      return failed === 0 ? 0 : 1;
    }

    case "access": {
      const r = runAccess(args, { stateDir: stateDir() });
      if (r.stdout) out(r.stdout);
      if (r.stderr) err(r.stderr);
      return r.code;
    }

    case "audit": {
      const r = runAudit(args, { stateDir: stateDir() });
      if (r.stdout) out(r.stdout);
      if (r.stderr) err(r.stderr);
      return r.code;
    }

    case "consent": {
      const r = runConsent(args, { stateDir: stateDir() });
      if (r.stdout) out(r.stdout);
      if (r.stderr) err(r.stderr);
      return r.code;
    }

    case "run": {
      const pidFile = args.includes("--pid-file")
        ? args[args.indexOf("--pid-file") + 1]
        : undefined;
      const detach = args.includes("--detach");

      // Detaching spawns the same command in the background and the parent
      // exits. The child carries RC_DETACHED=1, so it falls through to the
      // normal foreground path instead of detaching again.
      if (detach && !isDetachChild()) {
        const result = await daemonizeSpawn(args, {
          ...(pidFile ? { pidFile } : {}),
          env: process.env as Record<string, string | undefined>,
        });
        if (result.exitCode !== null && result.exitCode !== 0) {
          err("opencode-rc failed to start in the background.");
          if (result.stderr) err(result.stderr);
          return 1;
        }
        out(`opencode-rc ${VERSION} started in the background (pid ${result.pid ?? "?"}).`);
        if (pidFile) out(`  pid file: ${pidFile}`);
        out(`  stop with: kill ${result.pid ?? "<pid>"}`);
        return 0;
      }

      const { adapters, names, failures } = await loadOptionalAdapters(
        process.env as Record<string, string | undefined>,
      );
      for (const failure of failures) err(`rc: ${failure.id} was not started: ${failure.reason}`);
      const wantCli = args.includes("--cli") || names.length === 0;
      const selected: Adapter[] = [];
      if (wantCli) selected.push(new CliAdapter(!args.includes("--no-cli")));
      const explicit = args.filter((a) => !a.startsWith("--"));
      for (const adapter of adapters) {
        if (explicit.length === 0 || explicit.includes(adapter.id)) selected.push(adapter);
      }
      out(
        `opencode-rc ${VERSION} starting with: ${selected.map((a) => a.id).join(", ") || "(none)"}`,
      );
      const handle = await runBridge({ adapters: selected, ...(pidFile ? { pidFile } : {}) });
      // Adapters that are not interactive (pollers) resolve immediately; the
      // CLI adapter blocks on stdin. Park the event loop until a signal.
      await new Promise<void>(() => {});
      await handle.stop();
      return 0;
    }

    default:
      err(`Unknown command: ${command}\n`);
      err(HELP);
      return 2;
  }
}

const code = await main(process.argv.slice(2)).catch((e: unknown) => {
  err(e instanceof Error ? e.message : String(e));
  return 1;
});
process.exit(code);

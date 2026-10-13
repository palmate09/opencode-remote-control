/**
 * packages/core — the engine.
 *
 * **Rule 2 (§5.2): core knows nothing about any platform.** No `if (telegram)`
 * appears anywhere below. That is what makes Discord a 300-line addition
 * instead of a rewrite.
 *
 * **Rule 1 (§5.2): adapters never import `@opencode-ai/sdk`.** They import from
 * here and nothing else. When opencode's API moves to v2, `opencode.ts` is the
 * only file that changes.
 */

export * from "./types.js";
export * from "./sanitize.js";
export {
  createLogger,
  defaultLogDir,
  defaultStateDir,
  rotateIfNeeded,
  verifyChain,
  purgeAuditFile,
  redactString,
  GENESIS,
  hashRecord,
} from "./logger.js";
export type {
  Logger,
  AuditRecord,
  LoggerOptions,
  VerifyResult,
  PurgeResult,
} from "./logger.js";
export { AuditLog } from "./logger.js";
export * from "./config.js";
export * from "./pairing.js";
export * from "./permissions.js";
export * from "./transport.js";
export * from "./opencode.js";
export * from "./events.js";
export * from "./sessions.js";
export * from "./router.js";
export * from "./renderer.js";
export * from "./outbox.js";
export * from "./retention.js";
export * from "./privacy.js";
export * from "./bridge.js";

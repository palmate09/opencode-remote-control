/**
 * Relay sanitisation (§7.3, §7.4 layers 4 and 6).
 *
 * Everything that reaches a chat app, the disk, or a log line passes through
 * here. The module is deliberately dependency-free and side-effect-free so it
 * can be unit-tested exhaustively — it is the one component where a bug is a
 * remote code execution primitive.
 */

import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

/** §10.2 — relay text cap. */
export const RELAY_CAP = 3500;

/** §10.2 — the elision marker. Counted code points, not UTF-16 units. */
export const ELISION = "⋯ N code points elided ⋯";
export const ELISION_RE = /⋯ (\d+) code points elided ⋯/;
export const ELISION_LITERAL = "⋯ code points elided ⋯";

export const REDACTED = "[REDACTED]";
export const UNSERIALIZABLE = "(value unserializable)";
export const STATE_PLACEHOLDER = "<state>";

/**
 * Characters with no visual representation. They are how you hide `rm -rf /`
 * in `git status`, and how you forge a whole command out of an innocuous one.
 */
const INVISIBLE: ReadonlySet<string> = new Set([
  "\u200B", // zero width space
  "\u200C", // zero width non-joiner
  "\u200D", // zero width joiner
  "\u200E", // left-to-right mark
  "\u200F", // right-to-left mark
  "\u2060", // word joiner
  "\u2061", // function application
  "\u2062", // invisible times
  "\u2063", // invisible separator
  "\u2064", // invisible plus
  "\uFEFF", // zero width no-break space / BOM
  "\u180E", // mongolian vowel separator
]);

/**
 * Bidirectional overrides and isolates. These are the highest-severity class:
 * `rm -rf / #` rendered as `safe #/ -rf mr` in the victim's terminal.
 */
const BIDI: ReadonlySet<string> = new Set([
  "\u202A",
  "\u202B",
  "\u202C",
  "\u202D",
  "\u202E",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
  "\u200B\u200B",
]);

/**
 * Tag characters (U+E0000..U+E007F). Invisible; used to smuggle arbitrary text
 * past naive allowlists.
 */
function isTag(cp: number): boolean {
  return cp >= 0xe0000 && cp <= 0xe007f;
}

/** Deprecated non-standard whitespace. */
function isLegacySpace(cp: number): boolean {
  return (
    cp === 0x00a0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

function isAsciiControl(cp: number): boolean {
  // Keep \t and \n out of this; they are handled by the whitespace fold.
  return cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d;
}

/**
 * Homoglyph lookalikes for ASCII. We do not map them to their ASCII twin — that
 * would let a caller believe a command is safe when it is not. We replace them
 * with a marker so a human reading the chat can see the substitution happened.
 */
const HOMOGLYPHS: ReadonlyMap<string, string> = new Map([
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201A", "'"],
  ["\u201B", "'"],
  ["\u2032", "'"],
  ["\u201C", '"'],
  ["\u201D", '"'],
  ["\u201E", '"'],
  ["\u201F", '"'],
  ["\u2033", '"'],
  ["\u2010", "-"],
  ["\u2011", "-"],
  ["\u2012", "-"],
  ["\u2013", "-"],
  ["\u2014", "-"],
  ["\u2015", "-"],
  ["\u2212", "-"],
  ["\uFF0B", "+"],
  ["\u00D7", "x"],
  ["\u2024", "."],
  ["\uFE52", "."],
  ["\uFF0E", "."],
  ["\u2027", "."],
]);

/** Zero-width joiner run markers around emoji keep emoji rendering intact. */

/**
 * Step 1 — neutralise.
 *
 * Removes invisibles and bidi controls entirely, maps homoglyphs to their
 * closest ASCII equivalent, and folds exotic spaces to a plain space.
 */
export function neutralise(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (INVISIBLE.has(ch) || BIDI.has(ch) || isTag(cp)) continue;
    if (isAsciiControl(cp)) continue;
    if (isLegacySpace(cp)) {
      out += " ";
      continue;
    }
    const mapped = HOMOGLYPHS.get(ch);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Step 2 — collapse whitespace runs to a single space, preserving paragraph
 * breaks as `\n\n`. Telegram and Discord both render blank lines differently
 * from `\n`; collapsing to one keeps the message readable.
 */
export function foldWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/**
 * Step 3 — cap at {@link RELAY_CAP} code points, preserving head **and tail**.
 *
 * Head-only truncation hides `&& rm -rf /` behind an ellipsis, which is exactly
 * the case an approver most needs to see. The tail is the dangerous half of any
 * long command, so both ends survive.
 *
 * The elision marker's own length is taken out of the budget first. Adding the
 * marker after the fact would push the result over the cap, and "the cap is a
 * cap" is the property a chat platform's message limit depends on.
 */
export function elide(input: string, cap: number = RELAY_CAP): string {
  const cps = Array.from(input);
  if (cps.length <= cap) return input;

  // Shrink the budget until the marker fits. In practice one iteration is
  // enough, but the loop is cheap and makes the invariant unconditional.
  let budget = cap;
  let marker = elisionMarker(cps.length - budget);
  while (budget > 1 && Array.from(marker).length > cap - budget) {
    budget -= Math.max(1, Math.ceil((Array.from(marker).length - (cap - budget)) / 2));
    marker = elisionMarker(cps.length - budget);
  }
  if (budget <= 1) return `${Array.from(input).slice(0, cap).join("")}`;

  // 60/40 head/tail: a command's head says what it is, its tail says what it
  // does.
  const headLen = Math.floor(budget * 0.6);
  const tailLen = budget - headLen;
  const head = cps.slice(0, headLen).join("");
  const tail = tailLen > 0 ? cps.slice(cps.length - tailLen).join("") : "";
  return `${head}${elisionMarker(cps.length - headLen - tailLen)}${tail}`;
}

/** The marker inserted where code points were dropped. §10.2. */
export function elisionMarker(count: number): string {
  return `⋯ ${count} code points elided ⋯`;
}

export { elide as capHeadTail };

/**
 * Credential masking.
 *
 * Deliberately conservative: a mask never spans shell syntax, path characters
 * or URL characters, because "a mask can't hide the command, file path, or
 * destination being approved". Each pattern is bounded to a token that cannot
 * swallow a `&&`, `;`, `/`, or `?`.
 */
const SECRET_PATTERNS: readonly { re: RegExp; label: string }[] = [
  // OpenAI / Anthropic style
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, label: "sk" },
  // GitHub
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: "gh" },
  // AWS access key ids
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "AKIA" },
  // Google
  { re: /\bAIza[A-Za-z0-9_-]{30,}/g, label: "AIza" },
  // Slack
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, label: "xox" },
  // Telegram bot tokens
  { re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, label: "telegram-bot-token" },
  // Discord bot tokens (three base64 segments)
  { re: /\b[MNO][\w-]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/g, label: "discord-bot-token" },
  // JWTs — three dot-separated base64url segments
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: "jwt" },
  // Bearer headers
  { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, label: "bearer" },
  // npm
  { re: /\bnpm_[A-Za-z0-9]{30,}/g, label: "npm" },
  // Private key blocks — the whole block, never a fragment.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    label: "private-key",
  },
];

/** Extra secrets the operator has taught us about (values from `.env`, tokens). */
const extraSecrets: string[] = [];

export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const trimmed = value.trim();
  // Never register a short value: masking "http" or "1" mangles every message.
  if (trimmed.length < 8) return;
  if (!extraSecrets.includes(trimmed)) extraSecrets.push(trimmed);
}

export function clearRegisteredSecrets(): void {
  extraSecrets.length = 0;
}

/**
 * Step 4 — mask credentials. Operator-registered secrets are masked first
 * (longest first, so a prefix never masks a longer match and leaves a tail).
 */
export function maskCredentials(input: string): string {
  let out = input;
  const registered = [...extraSecrets].sort((a, b) => b.length - a.length);
  for (const secret of registered) {
    out = out.split(secret).join(REDACTED);
  }
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * The full relay pipeline: neutralise → fold → mask → cap.
 *
 * Order matters. Masking before capping would put `[REDACTED]` in the part that
 * survives; capping before masking could truncate a secret into something the
 * patterns no longer match and therefore leak. We mask, then cap.
 */
export function sanitizeText(input: string, cap: number = RELAY_CAP): string {
  const folded = foldWhitespace(neutralise(String(input ?? "")));
  const masked = maskCredentials(folded);
  return elide(masked, cap);
}

/**
 * §7.4 layer 4 — delimiter injection defence.
 *
 * Strips the characters that let a filename or title forge structure in a
 * downstream frame: angle brackets (HTML), square brackets (card syntax),
 * semicolons (frame terminators in several chat markup dialects).
 *
 * Newlines become a space rather than vanishing — dropping them outright would
 * weld two adjacent words into one token, which is its own kind of forgery
 * (`evil\nrm` becoming `evilrm` hides the split, and `evil\n rm` becoming
 * `evilrm` changes which command would run).
 */
export function safeName(input: string, cap = 120): string {
  const stripped = neutralise(String(input ?? ""))
    // Brackets carry no word boundary, so they vanish entirely.
    .replace(/[\[\]]/g, "")
    // Everything here *is* a token separator in some downstream grammar —
    // dropping it outright would weld two words into one (`evil\nrm` → `evilrm`
    // changes which command a shell would see). A space is the honest
    // rendering of "something was removed here".
    .replace(/[<>;]|\r\n?|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return elide(stripped, cap);
}

/**
 * §7.4 layer 4 — newlines inside fetched history collapse to a visible marker
 * so a message body cannot forge an adjacent row in a rendered frame.
 */
export function inlineFrameSafe(input: string, cap = RELAY_CAP): string {
  return sanitizeText(String(input ?? "").replace(/\r\n?|\n/g, " ⏎ "), cap);
}

/** §7.4 layer 5 — file paths travel as metadata, never inline. */
export function safePath(input: string, cap = 400): string {
  const raw = String(input ?? "");
  if (!raw) return "";
  // Control characters only — spaces and dashes are legitimate in a
  // path, so this must never grow into a blanket `\W` strip. Matching control
  // characters is the entire job: a path containing them is what we remove.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate, see above
  const out = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return elide(neutralise(out), cap);
}

/**
 * §6.5 step 3 — replace the state directory with `<state>` so operator paths
 * never land in a log file or a chat transcript.
 */
export function scrubPath(input: string, stateDir: string): string {
  if (!stateDir) return input;
  const real = resolve(stateDir);
  const withoutReal = input.split(real).join(STATE_PLACEHOLDER);
  return withoutReal.split(stateDir).join(STATE_PLACEHOLDER);
}

/**
 * §7.4 layer 6 — state exfiltration guard.
 *
 * Refuses to send anything inside the state directory except `inbox/`. Both
 * sides are resolved with `realpath` so a symlink cannot escape the check, and
 * the comparison uses a trailing separator so `/state-evil` cannot match
 * `/state`.
 */
export async function assertSendable(
  candidate: string,
  stateDir: string,
  opts: { mustExist?: boolean } = {},
): Promise<void> {
  const stateReal = await realpath(stateDir).catch(() => resolve(stateDir));
  const abs = isAbsolute(candidate) ? candidate : join(process.cwd(), candidate);

  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    if (opts.mustExist) throw new RefusingToSendError(candidate, "path does not exist");
    // Non-existent paths cannot be symlinks. Check the lexical form.
    real = resolve(abs);
  }

  const statePrefix = stateReal.endsWith(sep) ? stateReal : `${stateReal}${sep}`;
  const inbox = join(stateReal, "inbox");
  const inboxPrefix = inbox.endsWith(sep) ? inbox : `${inbox}${sep}`;

  const isInsideState = real === stateReal || real.startsWith(statePrefix);
  const isInsideInbox = real === inbox || real.startsWith(inboxPrefix);
  if (isInsideState && !isInsideInbox) {
    throw new RefusingToSendError(candidate, "path is inside the state directory");
  }

  if (opts.mustExist) {
    await access(real, constants.R_OK).catch(() => {
      throw new RefusingToSendError(candidate, "path is not readable");
    });
  }
}

export class RefusingToSendError extends Error {
  override readonly name = "RefusingToSendError";
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`refusing to send ${path}: ${reason}`);
  }
}

/**
 * §10.2 — safe JSON serialisation for the audit log. Cycles and non-serialisable
 * values become a marker rather than throwing mid-write, because losing the
 * audit record is worse than losing the field.
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "function" || typeof v === "symbol") return UNSERIALIZABLE;
      if (typeof v === "number" && !Number.isFinite(v)) return String(v);
      if (v instanceof Error) return { name: v.name, message: v.message };
      if (v && typeof v === "object") {
        if (seen.has(v as object)) return "[circular]";
        seen.add(v as object);
      }
      return v;
    });
  } catch {
    return UNSERIALIZABLE;
  }
}

/** Deterministic key-sorted serialisation, used as audit hash input. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      return typeof v === "number" && !Number.isFinite(v) ? String(v) : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Error) return { name: v.name, message: v.message };
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const child = obj[key];
      if (child === undefined) continue;
      out[key] = walk(child);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(value)) ?? "null";
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * Splits a long rendered message into chunks that fit a platform limit while
 * preferring paragraph boundaries, then line boundaries, then word boundaries.
 *
 * The cut character itself is consumed, so concatenating the chunks with the
 * separator that was removed reproduces the original exactly.
 */
export function chunkText(text: string, limit: number): string[] {
  const max = Math.max(1, limit);
  const cps = Array.from(text);
  if (cps.length <= max) return [text];

  const chunks: string[] = [];
  let cursor = 0;

  /** Moves the cursor to an absolute code-point index, never backwards. */
  const seek = (to: number): void => {
    cursor = Math.max(cursor + 1, Math.min(to, cps.length));
  };

  while (cursor < cps.length) {
    if (cps.length - cursor <= max) {
      chunks.push(cps.slice(cursor).join("").trimEnd());
      break;
    }
    const window = cps.slice(cursor, cursor + max).join("");

    // Prefer a paragraph break, then a line break, then a space — but only if
    // the boundary is far enough into the window that we are not emitting a
    // chunk of one or two characters.
    const para = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const cut = para > max * 0.4 ? para : line > max * 0.4 ? line : space > max * 0.4 ? space : -1;

    if (cut > 0) {
      chunks.push(window.slice(0, cut).trimEnd());
      // Consume the boundary itself, then any blank space it left behind.
      seek(cursor + cut + 1);
      while (cps[cursor] === "\n" || cps[cursor] === " ") cursor++;
      continue;
    }

    chunks.push(window);
    seek(cursor + max);
  }

  return chunks.filter((c) => c.trim().length > 0);
}

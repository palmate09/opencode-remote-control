# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).
Because the project is pre-1.0, `0.x` minor bumps **may** be breaking; `0.1.y`
patches are safe.

---

## [0.1.0] — 2026-10-11

First release. Verified end-to-end against a live opencode **1.18.35** server:
pairing, prompt round-trip, streaming, the permission relay, and the §2.4
carry-over guard.

### Added

**Engine (`@opencode-rc/core`)** — 16 modules, zero platform knowledge.

- `sanitize.ts` — invisible-Unicode and bidi defence, credential masking,
  path scrubbing, and capping at 3,500 code points with **head and tail
  preserved**. Tail preservation is the load-bearing detail: a head-only
  truncation hides `&& rm -rf /`, which is the part an approver must see.
- `pairing.ts` — the gate (§7.1) and pairing (§7.2). Six-hex CSPRNG codes,
  1-hour TTL, reply budget, global pending cap, `disabled` checked before the
  allowlist so it is a true master kill.
- `permissions.ts` — pending registry with first-answer-wins, five-letter short
  ids from Claude's `a–z` minus `l` alphabet (`l` and `1` are
  indistinguishable on a phone keyboard), and the strict reply grammar.
- `audit.ts` (`AuditLog`) — append-only, hash-chained JSONL. Tamper
  **evidence**, explicitly not tamper prevention.
- `logger.ts` — two streams: rotating human-readable debug logs, and the audit
  trail. Redaction runs before any byte hits disk.
- `opencode.ts` — the only file that imports `@opencode-ai/sdk`, behind the
  `OpencodeTransport` interface so a v2 migration is a one-file change.
- `events.ts` — one SSE connection fanned out, with deduplication and two-track
  reconnect backoff including sleep detection.
- `sessions.ts`, `router.ts`, `renderer.ts`, `outbox.ts`, `retention.ts`,
  `privacy.ts`, `config.ts`, `bridge.ts`.

**Adapters** — each depends only on `@opencode-rc/core`, and each declares its
capabilities honestly.

- `cli` — `rc` plus the CLI adapter. Interactive or piped stdin.
- `telegram` — long-poll, inline keyboard buttons, MarkdownV2 escaping.
- `discord` — Gateway inbound, REST outbound, channel = project, thread =
  session, buttons acknowledged inside the 3-second interaction window.
- `slack` — Socket Mode, so no public URL is needed.
- `webhook` — the escape hatch. `permissionRelay: false`; the endpoint returns
  403 unless explicitly opted in.
- `mcp` — stdio server exposing the bridge's own primitives.
- `api` — REST + SSE, loopback by default, shared password compared in
  constant time.

**Operator surface** — `rc init | doctor | run | access | audit | consent`.

**Data subject rights** — `/privacy`, `/export`, `/export --format ndjson`,
`/forget [--session] [--purge-only] [--all]`, `rc consent withdraw`. Every
right is a working command.

**Documentation** — README, SECURITY, PRIVACY, GOVERNANCE, CONTRIBUTING, CODE_OF_CONDUCT,
NOTICE, LICENSE, and `docs/{ARCHITECTURE,THREAT_MODEL,DATA_PROTECTION,SUBPROCESSORS}.md`.

**CI** — lint, typecheck, tests, build, dependency-licence audit, DCO sign-off,
and two structural rules enforced as gates: adapters must not import the
opencode SDK, and core must not name a platform.

### Bugs found and fixed during development

Recorded because each was found by running against a real opencode, not by
reading its docs, and each is now covered by a regression test.

| Symptom | Cause |
|---|---|
| Permission prompts never reached the user | The documented event is `permission.updated`; 1.18.35 emits **`permission.asked`**, with the tool in `permission` and no `title` |
| The bot replied with the user's own words | `message.part.updated` carries no role; it fires for the prompt as well as the answer |
| Every reply was lost | `step-finish` parts reset the renderer's text buffer before `session.idle` |
| Nothing streamed | Token deltas arrive as a separate `message.part.delta` event, not a `delta` field |
| `/model` listed nothing | `/provider` returns `{all, connected}` where `all` is an **array**; it was read as `providers` |
| `/model provider/model` sent a broken model | opencode model ids contain slashes; `split("/")` mangled them |
| The §2.4 carry-over guard silently passed | `permission` is `{"*": "ask"}`, not the string `"ask"` |
| The guard then failed **open** | "Cannot determine the mode" was treated as "the mode is ask"; now fails closed |
| The webhook opt-in could never be enabled | The constructor read `opts.permissionRelay`; the interface declared `allowPermissionRelay` |
| `--no-cli` read nothing | The CLI adapter returned before wiring up stdin |
| A terminal had to pair with itself | The CLI is trust boundary 1; made an explicit `LOCALLY_TRUSTED_ACTORS` entry inside the gate |
| `/status` reported answered permissions as pending | `PermissionRegistry.list()` did not filter answered requests |

### Security

- **A bot cannot approve itself.** Pairing completes only at a terminal. This
  single property is the whole security argument, and there is no chat-reachable
  path to `access.json`.
- **Master kill checked first.** `RC_DISABLED=true` drops all traffic before
  the allowlist is consulted — including the locally trusted CLI actor.
- **Anti-sycophancy.** "Approve the pending pairing" never auto-resolves, *even
  when exactly one code is pending*; an attacker can seed a single entry by
  DMing the bot.
- **Seven anti-injection layers** (§7.4), each with tests. Layer 7 — capability
  declaration — is enforced per adapter, and the webhook adapter ships
  `permissionRelay: false` because a URL authenticates a caller, not a person.
- **Actors pseudonymised** in the audit log as `sha256(salt + platform + ":" + id)`.
- **Message bodies never enter the logs.** They live in opencode's transcript
  and the chat platform's; our logs record *that* a message was sent, by whom,
  to which session, and its length.
- **State exfiltration guard** with `realpath` on both sides and a trailing
  separator, so `/state-evil` cannot match `/state`.
- **Zero telemetry.** No code path opens a connection to an opencode-rc
  controlled host, and there will not be one.

### Known limitations

Stated in the README rather than buried, and repeated here because a changelog
is what a security-conscious reader reads:

- **If the computer sleeps, the bot stops.** Not solvable in software.
- **opencode already ships a PWA.** opencode-rc is the push layer and the
  unified inbox, not a replacement for it.
- **Telegram, Discord and Slack adapters have not been exercised against a
  live bot token.** Their transports are covered by tests against fake servers
  on loopback, but a real credential has never been used. Smoke-test before
  relying on one.
- **There is no encryption at rest.** Use full-disk encryption for `state/`.
- **iMessage, Signal and WhatsApp are not implemented.** All reverse-engineered
  clients; WhatsApp carries a real number-ban risk.
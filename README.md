# opencode-rc

> Control your coding agent from your phone. Start with Telegram, then Discord, Slack, CLI, MCP and webhooks.
> Open source. Self-hosted. Privacy-first by construction.

[![CI](https://github.com/palmate09/opencode-remote-control/actions/workflows/ci.yml/badge.svg)](https://github.com/palmate09/opencode-remote-control/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What this is

One small daemon that runs on your computer. It sits between your chat app and
the opencode process on your machine.

You message the bot from your phone. It hands your message to opencode. opencode
reads code, edits files, runs tests. The answer comes back to the chat. When
opencode asks permission, you get three buttons: **Approve once**, **Always**,
**Deny**. You tap one and work continues.

Nothing leaves your machine except the chat transcript, which passes through
whichever chat platform you chose. There is no cloud component. There is no
account. There is no telemetry.

This is Claude Code's "Channels", rebuilt for opencode.

---

## Honest limitations, first

We would rather you read these now than discover them on a train.

- **If your computer sleeps, the bot stops.** No software fixes this. Use
  `tmux`, disable sleep, or run it on a $60 mini PC or a cheap VPS. Claude Code
  has exactly the same limit.
- **opencode already ships a PWA.** `opencode web` gives you a phone UI with no
  third-party app in the loop. opencode-rc is the **push layer and the unified
  inbox** — it tells you when work finished, and it works from apps that are not
  browsers. If the PWA is enough for you, this project is not for you, and that
  is a fine outcome.
- **Group chats are off by default** and need a per-group allowlist plus a
  mention. This is deliberate and is not configurable away.
- **The audit log is tamper-*evidence*, not tamper-proof.** An attacker with
  write access to your disk can recompute the chain. What they cannot do is edit
  one record in place without detection. See [SECURITY.md](SECURITY.md).
- **We are a bridge, not a legal product.** [PRIVACY.md](PRIVACY.md) and
  [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md) are engineering guidance,
  not legal advice. You are the controller.

---

## Architecture

```
                     opencode /event  (SSE)
                             │
                     events.ts  — ONE connection
                             │
               ┌─────────────┼─────────────┬──────────┐
               ▼             ▼             ▼          ▼
           telegram       discord       slack       api/SSE
               │             │             │          │
               └─────────────┴──────┬──────┴──────────┘
                                    ▼
                             renderer.ts
                               Cards
                                    │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
               outbox.ts    permissions.ts   audit.ts
```

Two rules govern the codebase and are enforced by review, by tests, and by the
fact that `bun run typecheck` fails otherwise:

1. **Adapters never import the opencode SDK.** They speak only to
   `packages/core`. When the API moves to v2, you edit one file.
2. **Core knows nothing about any platform.** No `if (telegram)` anywhere in
   `packages/core`. Every platform-specific concern lives in an adapter. This is
   what makes Discord a 300-line addition instead of a rewrite.

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Quickstart — five minutes

**0. Before any code: check whether opencode's own PWA is enough.**

```bash
# Install Bun if you do not have it
curl -fsSL https://bun.sh/install | bash

# Start opencode, reachable only from your Tailscale network
opencode web --hostname "$(tailscale ip -4)" --port 4096
```

Open `http://<tailscale-ip>:4096` on your phone and **Add to Home Screen**. If
that is all you need, stop here. You have saved yourself a lot of moving parts.

If you want push notifications and a unified inbox from Telegram/Discord/Slack,
continue:

**1. Create a bot and get your user id.**

- Telegram: [@BotFather](https://t.me/BotFather) → `/newbot` → keep the token.
  Message the bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to
  read your numeric user id.
- Discord: Developer Portal → your app → Bot → **Reset Token**. Enable the
  `MESSAGE_CONTENT` privileged intent.
- Slack: create an app, enable **Socket Mode**, install to your workspace, and
  keep both the bot token (`xoxb-…`) and the app token (`xapp-…`).

**2. Install and configure.**

```bash
bunx opencode-rc init      # writes the state directory and first-run consent
cp .env.example .env       # then fill in RC_OPENCODE_URL and your bot token
bunx opencode-rc doctor    # checks opencode, access policy, audit chain
```

**3. Start the bridge.**

```bash
bunx opencode-rc run
```

**4. Pair.** Message your bot from the phone. It replies with a pairing
instruction. **Type the code at your terminal — this step is the security
boundary, and it cannot be done from chat.**

```bash
bunx opencode-rc access allow <the-6-hex-code>
```

That is it. Send a prompt. Tap **Approve once** when opencode asks.

---

## Running it as a service

```ini
# ~/.config/systemd/user/opencode-rc.service
[Unit]
Description=opencode-rc bridge
After=network-online.target

[Service]
ExecStart=/usr/bin/env bun run /path/to/opencode-rc/packages/cli/src/bin.ts run
Restart=on-failure
RestartSec=5
EnvironmentFile=/path/to/project/.env

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now opencode-rc
```

macOS: use `launchd`, or wrap it in `tmux new -d -s opencode-rc 'bun … run'`.

---

## Commands

| Command | What it does |
|---|---|
| `rc init` | Create the state directory, allowlist and consent record |
| `rc doctor` | Check opencode, the access policy and the audit chain |
| `rc run [adapter…]` | Start the bridge with every enabled adapter |
| `rc access list` | Show the allowlist and group policies |
| `rc access allow <code>` | **Approve a pending pairing. Terminal only.** |
| `rc access revoke <platform:id>` | Remove an allowlist entry |
| `rc access disable \| enable` | The master kill switch |
| `rc access group <chatId> <policy>` | `open`, `close`, `allow <ids…>`, `mention <bool>` |
| `rc audit verify` | Check the hash chain; reports the exact broken record |
| `rc audit export --since <date>` | Machine-readable records for an incident report |
| `rc audit tail [n]` | The last n records, human-readable |
| `rc consent show \| grant \| withdraw` | Inspect or change the lawful basis |

In chat:

| Message | Effect |
|---|---|
| `/new [title]` | Start a fresh session |
| `/sessions` · `/status` · `/diff` | Inspect the current work |
| `/abort` | Stop the current run — always works |
| `/model <provider/model>` | Pick a model |
| `btw <text>` | Queue a follow-up for when the current run finishes |
| `/cancel` | Drop the queue |
| `/privacy` · `/export` · `/forget` | Your data rights (§8.5 of the plan) |
| `yes <code>` / `always <code>` / `no <code>` | Answer a permission request |

---

## The security model, in seven rules

Full detail and rationale: [SECURITY.md](SECURITY.md) and
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

1. **Outbound-only.** We dial out to Telegram/Discord/Slack and to opencode. We
   never accept inbound connections from the internet. No port forwarding, no
   public URL, no certificate to manage. (The API and webhook adapters are the
   deliberate exception: bind them to a Tailscale address or loopback.)
2. **A bot cannot approve itself.** Pairing requires typing at a terminal. This
   single rule is the entire security argument.
3. **Authenticate the sender, not the room.** Group chats are off until you
   configure them, and a mention is required.
4. **Push toward lockdown.** `pairing` is a bootstrap, not a steady state. The
   target is an explicit allowlist.
5. **A master kill checked before everything.** `RC_DISABLED=true` drops all
   traffic before the allowlist is consulted.
6. **First answer wins.** A permission request resolves once; later taps are
   ignored.
7. **Sanitise everything relayed.** Invisible Unicode, bidi overrides and
   lookalike characters are stripped before anything reaches a chat app. Long
   text is capped with **head and tail preserved**, because the end of a
   command is the dangerous part.

---

## Privacy

**opencode-rc collects nothing about its users.** No crash reporting, no
analytics, no phone-home, no update check. There is no code path that opens an
outbound connection to an opencode-rc-controlled host, and there will not be one.

- **Message bodies are never written to our logs.** They live in opencode's own
  transcript storage and the chat platform's. Our logs record *that* a message
  was sent, by whom (hashed), to which session — not what it said.
- **Actor ids are pseudonymised** in the audit log as
  `sha256(salt + platform + ":" + id)`. You can correlate one person's actions
  without a Telegram user id sitting on your disk in plaintext. Turn it off with
  `RC_LOG_ACTOR=raw` if you prefer raw.
- **You are the controller**, not us. opencode-rc is software that provides the
  means of processing; it makes no claims on your behalf.

See [PRIVACY.md](PRIVACY.md), [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md)
and [docs/SUBPROCESSORS.md](docs/SUBPROCESSORS.md).

---

## Repository layout

```
packages/
├── core/       the engine — zero platform knowledge
├── cli/        the `rc` command and the CLI adapter
├── telegram/   Telegram adapter
├── discord/    Discord adapter  (channel = project, thread = session)
├── slack/      Slack adapter    (Socket Mode, no public URL)
├── webhook/    generic webhooks — the escape hatch
├── mcp/        MCP server, so a desktop client can drive the bridge
└── api/        REST + SSE, Tailscale-only
```

Every adapter is enabled by an environment flag and isolated: a broken
third-party client cannot affect Telegram, Discord or Slack. See
[.env.example](.env.example).

### Test coverage, honestly

| Area | Coverage |
|---|---|
| Core policy, sanitisation, audit, pairing | Full |
| CLI adapter, `rc` commands | Full |
| Telegram transport | Against a fake Bot API over real HTTP on loopback |
| API + webhook adapters | Real HTTP servers, real requests, real SSE |
| Discord, Slack, MCP transports | **Payload parsing and card rendering only — no transport-level test** |

**No test needs a live agent, a bot token, or network egress.** That is
deliberate: a suite that needs infrastructure is a suite nobody runs.

But be clear about what that means: the Telegram, API and webhook adapters have
been exercised against local servers, and **the Discord, Slack and MCP
adapters have never had their network transports run**. Their event parsing,
payload round-trip and capability declarations are tested; their sockets are
not. Smoke-test them with a real credential before relying on one.

---

## Development

```bash
bun install
bun run typecheck     # tsc --noEmit, strict
bun run lint          # biome
bun test              # 272 tests, no network egress
bun run build
bun run check         # all of the above
```

The test suite runs entirely against a fake opencode transport. **No test needs
a live agent, a bot token, or a network connection.** That is deliberate: a test
suite that needs infrastructure is a suite nobody runs.

### Adding an adapter

1. Create `packages/<name>/` with a `package.json` depending only on
   `@opencode-rc/core`.
2. Implement `Adapter`: `start`, `stop`, `send`.
3. Declare `capabilities.permissionRelay` **honestly**. If you cannot
   authenticate the person tapping a button, it is `false`.
4. Export `create(env)` and register the module in `packages/cli/src/adapters.ts`.
5. Convert every inbound event into `InboundMessage` and let the bridge do the
   rest — the gate, the router and the audit trail are already wired.

You do not need to touch `packages/core`.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md) and to the Developer Certificate of Origin
sign-off on every commit.

## Security

Report vulnerabilities through GitHub's private reporting, or by email to the
maintainers. See [SECURITY.md](SECURITY.md) for the disclosure policy and a
summary of the threat model. **Please do not open a public issue for a
vulnerability.**

## Licence

MIT — see [LICENSE](LICENSE), [NOTICE](NOTICE) and
[TRADEMARKS.md](TRADEMARKS.md).

## Changelog

[CHANGELOG.md](CHANGELOG.md) — including a table of the bugs found by running
against a real opencode rather than reading its documentation.
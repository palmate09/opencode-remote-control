# Sub-processors

> **This document is engineering guidance, not legal advice.** It records who
> can see your data, so you can write an accurate Art. 28 / DPDP §6 notice. The
> platforms' own DPAs and transfer mechanisms are theirs, not ours; links are to
> their official documents as of the date below, and they change.

**Last reviewed:** 2026-10-11

---

## The short version

opencode-rc runs on your machine and contacts exactly two kinds of service:

1. **The opencode server you configured** — on your own machine or your own
   infrastructure.
2. **The chat platforms you explicitly enabled**, one at a time, each behind its
   own environment flag.

There is no third category. There is no opencode-rc-operated service, no
analytics endpoint, no crash reporter, no update checker. There is no code path
that opens an outbound connection to an opencode-rc-controlled host, and there
will not be one.

---

## Who sees your data

### 1. The chat platforms you enable

You choose which of these run. Each is enabled by an environment flag and is off
by default.

| Platform | Enabled by | Sees | Lawful transfer basis |
|---|---|---|---|
| **Telegram** | `RC_TELEGRAM_ENABLED=true` | Bot token, your user id, chat id, **message content**, relayed agent output, permission taps | [Telegram Privacy Policy](https://telegram.org/privacy) · [DPA](https://telegram.org/privacy#3.-dpa) |
| **Discord** | `RC_DISCORD_ENABLED=true` | Bot token, your user id, channel id, thread id, **message content**, relayed agent output, button interactions | [Discord Privacy Policy](https://discord.com/privacy) · [DPA](https://discord.com/privacy-policy) |
| **Slack** | `RC_SLACK_ENABLED=true` | Bot + app tokens, workspace, member id, channel, thread, **message content**, relayed agent output, block actions | [Slack Privacy Policy](https://slack.com/legal/privacy-policy) · [DPA](https://slack.com/legal/data-protection-addendum) |

### What each platform receives

| Data | Why it cannot be avoided |
|---|---|
| Your **message content** | The message *is* the request to the agent. |
| **Relayed agent output** | You asked for the answer in that chat. |
| Your **user id** | Authentication. Without it there is no allowlist. |
| The **bot/app token** | Authenticates *our* calls to them. It is your credential, in your configuration. |
| **Timestamps, chat ids, message ids** | Required to route and to rate-limit. |

### What none of them receive

- **Your machine's filesystem layout**, unless you explicitly ask for a file and
  it is outside the state directory. `assertSendable()` refuses anything inside
  `state/` except `inbox/`.
- **Your opencode session transcript** beyond what is relayed to the chat.
- **Your allowlist** (`state/access.json`) — it never leaves your machine.
- **Your audit salt** — it never leaves your machine.
- **Credentials you did not paste into a message.** Pattern-based masking catches
  known prefixes; a secret with an unrecognised shape and no surrounding
  whitespace will survive. See the limitation in §5.

### Transfer location

All three platforms process data outside the EEA. Each offers an adequacy
decision (EU-US Data Privacy Framework) and standard contractual clauses under
its DPA. For EU operators this is a restricted transfer under Chapter V and you
must document your own assessment. We link the DPAs above rather than
reproducing or interpreting them.

### What we do not do

We do **not** read from a platform anything you have not sent us. We long-poll
Telegram and Slack, and hold a Gateway connection for Discord, which delivers
**only messages in contexts the bot is present in**:

- **Telegram** — long-polling `getUpdates` returns updates addressed to the bot.
  **Telegram has no history pull**: messages sent while the bridge is down are
  not recoverable through this adapter. Accept it or use Discord.
- **Discord** — Gateway delivers `MESSAGE_CREATE` for guilds the bot is in, and
  `INTERACTION_CREATE` for its components.
- **Slack** — Socket Mode delivers events scoped to the bot's subscriptions.

### Unavoidable metadata

Each platform necessarily learns that *you* are talking to *a bot at this time*.
We cannot prevent this, and neither can you. It is why the allowlist exists and
why group use is off by default.

---

### 2. The opencode server

Configured via `RC_OPENCODE_URL`. Usually `http://127.0.0.1:4096` on your own
machine.

| Deployment | Who sees your prompts |
|---|---|
| Local (`127.0.0.1`) | Only you |
| Tailscale / LAN | Only you, over an encrypted mesh |
| A VPS you run | Only you, plus whoever controls that VPS |
| Someone else's server | **Them.** Do not do this. |

opencode-rc is a client of opencode. It sends prompts, reads events, and answers
permission requests. opencode then talks to **your model provider** —
Anthropic, OpenAI, Google, or a local model — and that provider sees your prompt
and the context you gave it.

**opencode-rc does not choose, proxy, or mitigate your model provider.** It is
outside our control and outside this document's scope, but you should know it
exists before you send a secret into a chat.

---

### 3. Transport, if you use it

| Tool | Role | Data |
|---|---|---|
| **Tailscale** | Private network between your laptop and your phone | Encrypted end-to-end; WireGuard, no relay of plaintext. Coordinates go to Tailscale's control plane, message content does not. |

Not required. It is simply the least complicated way to reach `opencode web`
from a phone without opening a port. See [ARCHITECTURE.md](ARCHITECTURE.md) and
`README.md`.

---

### 4. Development-time dependencies

If you build from source, your package manager fetches from the npm registry.
These never see runtime data.

| Dependency | Licence | Role |
|---|---|---|
| [`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk) | MIT | The opencode API client |
| [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) | MIT | MCP server |
| [`zod`](https://www.npmjs.com/package/zod) | MIT | Schema validation (MCP) |
| [`typescript`](https://www.npmjs.com/package/typescript) | Apache-2.0 | Type checking |
| [`@biomejs/biome`](https://www.npmjs.com/package/@biomejs/biome) | MIT OR Apache-2.0 | Lint and format |
| [`bun`](https://bun.sh) | MIT | Runtime |

Enumerate the full transitive tree with `bun run deps:license`, which fails on
GPL-3.0 / AGPL / SSPL contamination. **Chat platforms are contacted using our own
HTTP and WebSocket clients; no platform SDK is vendored.**

---

## Your notice template

If you run opencode-rc for other people, your sub-processor list is:

1. **Telegram Messenger Inc.** — or not, if you did not enable it
2. **Discord Inc.** — or not
3. **Slack Technologies, LLC** — or not
4. **Your model provider**, reached through opencode
5. **Tailscale Inc.** — if you use Tailscale

…plus whatever your infrastructure provider is.

Say which platforms you enabled. Saying "Telegram, Discord and Slack" when you
enabled one of them is a false statement in a legal document, even if it
over-discloses.

---

## Change control

If the set of services contacted by opencode-rc ever changes, this document
changes in the same pull request, and the change is called out in the release
notes.

**Current status: adding a network destination is a super-majority change**
([GOVERNANCE.md](../GOVERNANCE.md)), because it changes the privacy properties
of the software, not just its features.
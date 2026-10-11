# Privacy Notice — opencode-rc

> **This is a template you adopt, not a policy we impose.**
>
> opencode-rc is software. It makes no claims on your behalf, processes nothing
> on your users' behalf, and has no relationship with any end user. When *you*
> run opencode-rc, **you are the controller** and *your* users are the data
> subjects. This document tells you exactly what the software does with data so
> you can write a notice that is true for your deployment.
>
> **This document is engineering guidance, not legal advice.** If you operate in
> a regulated setting, have counsel review your specific configuration. See also
> [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md).

---

## 1. Who is responsible

Projects usually get this wrong, so it goes first.

| Role | Who | GDPR | DPDP (India) |
|---|---|---|---|
| **The software** | opencode-rc | Provides the *means* of processing (Art. 4(8)) | — |
| **The controller / Data Fiduciary** | **You**, the person running it | Controller (Art. 4(7)) | Data Fiduciary (§2(4)) |
| **The data subject / Data Principal** | **You** and anyone you authorise | Data subject (Art. 4(1)) | Data Principal (§2(2)) |
| **Sub-processors** | Telegram / Discord / Slack; your model providers | Sub-processor (Art. 28) | Significant Data Fiduciary |

**You are the controller. We are the tool.** That is why every privacy feature
here is operator-configurable rather than hardcoded by us, and why this document
is a template you adopt rather than a policy you are bound by.

---

## 2. What personal data the software touches

| Data | Where it lives | Minimisation applied |
|---|---|---|
| Platform user / chat ids | `state/access.json` | Raw, mode `0600`, directory `0700` |
| Platform user ids, pseudonymised | `state/logs/audit.jsonl` | `sha256(RC_AUDIT_SALT + platform + ":" + id)` — see §4 |
| Session titles, directories, chat ids | `state/sessions.json` | Necessary for routing; removable with `/forget` |
| Permission decisions | `state/logs/audit.jsonl` | Legitimate interest: accountability |
| File paths, commands | chat message text | Capped, masked and Unicode-stripped before relay; hashed in audit |
| **Message content** | **nowhere, in our storage** | See §3 |

### The single most important decision in this project

**Message bodies never enter our logs.**

They live in opencode's own transcript storage and in the chat platform's. Our
logs record *that* a message was sent, by whom, to which session — and its
length in code points — not what it said. This is enforced by a test
(`tests/bridge.test.ts` — "message bodies never reach the audit log"), because a
promise in a README is not a control.

---

## 3. What we deliberately do not do

- **No telemetry.** None. No crash reporting, no analytics, no phone-home, no
  update check. There is no code path that opens an outbound connection to an
  opencode-rc-controlled host, and there will not be one.
- **No accounts.** No registration, no login, no user database.
- **No cloud component.** One process, one machine.
- **No message content retention.** Not in logs, not in memory beyond the run.

Claude Code ships `DISABLE_TELEMETRY` and `DO_NOT_TRACK`. We honour both for
familiarity, and we also ship no telemetry in the first place — so the setting is
a no-op we keep only so operators who reach for it are not surprised.

---

## 4. Pseudonymisation of actors

The audit log stores

```
sha256( RC_AUDIT_SALT  +  platform  +  ":"  +  id )
```

rather than the raw platform user id. This preserves every legitimate use:

- correlating one person's actions over time,
- enforcing per-actor limits,
- answering "was that me?" for a specific tap,

…without writing a Telegram user id to your disk in plaintext. If your disk is
stolen, an attacker cannot go from the audit log to a Telegram account without
also stealing `state/audit.salt` — and that file is `0600`.

`RC_AUDIT_SALT` is generated with `randomBytes(32)` on first run and stored
`0600`. **You can turn pseudonymisation off** by setting `RC_LOG_ACTOR=raw`, in
which case the audit log stores `platform:id` in the clear. We chose the hashed
default and we are telling you the escape hatch exists so the choice is yours.

---

## 5. Lawful basis

| Processing | GDPR basis | DPDP basis |
|---|---|---|
| Operating the bridge you chose to run | Art. 6(1)(f) legitimate interests | §6(1)(a) consent, captured at first run |
| Authentication and access control | Art. 6(1)(f) legitimate interests | §6(1)(a) |
| Audit trail | Art. 6(1)(c) legal obligation and/or Art. 6(1)(f) | §6(1)(c) |
| **Telemetry** | **none — we collect none** | **none** |

**We default to legitimate interests rather than consent**, because a self-hosted
tool processing your own messages in order to do what you asked for is a textbook
legitimate-interest case. Consent for a local daemon is theatre: a consent banner
you click once in your own terminal does not make the processing more consensual,
it just makes it harder to audit.

DPDP is consent-centric, so we capture an explicit consent record at first run in
`state/consent.json`, with version, timestamp and notice hash:

```bash
rc consent show       # inspect
rc consent withdraw   # stops all processing
```

**Withdrawal removes the record; stop the daemon too.** Withdrawal is honoured on
the next start. We say this plainly rather than implying a consent record is a
kill switch.

---

## 6. Data subject rights — implemented, not promised

"Contact us" is not an implementation. Every right is a working command.

| Right | GDPR | DPDP | Command |
|---|---|---|---|
| Notice | Art. 13 | §5 | `/privacy` |
| Access | Art. 15 | §11(1) | `/export` |
| Portability | Art. 20 | §11(4) | `/export --format ndjson` |
| Erasure | Art. 17 | §11(3) | `/forget` |
| Rectification | Art. 16 | §11(2) | `/forget --session <id>`, then re-prompt |
| Object / restrict | Art. 21 | §11(5) | `/forget --purge-only` |
| Consent withdrawal | Art. 7(3) | §6(6) | `rc consent withdraw` |

`/export` produces a machine-readable dump of everything associated with your
platform identity: allowlist entry, session mappings, audit records, consent
record, and the retention policy in force.

`/forget` removes the session mappings, purges audit records for that actor, and
rotates the session out of the router. `--purge-only` drops audit records but
keeps the session mapping; `--all` also removes the consent record.

**Rights requests are themselves audited.** Art. 5(2) accountability means you
must be able to demonstrate that you handled a request. `rc audit export --since
<date> --format ndjson` produces exactly the record an incident report needs,
without a vendor.

---

## 7. Retention

| Record | Default | Configurable |
|---|---|---|
| Debug logs (`logs/app.log`) | 7 days | `RC_LOG_RETENTION_DAYS` |
| Audit log (`logs/audit.jsonl`) | 90 days | `RC_AUDIT_RETENTION_DAYS` |
| Pending pairing codes | 1 hour | hard TTL, pruned lazily |
| Session mappings | until `/forget` or session deletion | `/forget` |
| Consent record | life of install | `/forget --all`, `rc consent withdraw` |
| Rotated debug log files | 7 days, 10 files max | `RC_LOG_ROTATE_MAX_FILES` |
| **Message content** | **not stored by us at all** | n/a |

Purge runs **on a timer and at startup**. A machine that was off for a month
catches up the moment it wakes; a purely timer-driven purge would leave stale
records on disk for as long as the machine was asleep.

Audit records are filtered, not the file rewritten in place, so the hash chain
survives. The one exception is retention purge itself, which rewrites
atomically via a `.purge` temp file and a `rename`, so a crash mid-rewrite
cannot corrupt the chain.

---

## 8. Sub-processors and cross-border transfers

Messages transit Telegram's, Discord's or Slack's infrastructure, which is very
likely outside your jurisdiction. For EU users that is a transfer requiring an
adequacy decision or standard contractual clauses, supplied by the platform under
their data processing agreement.

The full list is in [docs/SUBPROCESSORS.md](docs/SUBPROCESSORS.md).

**We add no further transfer.** No cloud, no analytics endpoint, no telemetry.
The only outbound connections opencode-rc makes are to:

1. the opencode server you configured, and
2. the chat platforms you explicitly enabled.

---

## 9. Breach response

For **maintainer** vulnerabilities in opencode-rc itself, the disclosure process
is in [SECURITY.md](SECURITY.md): 90-day coordinated window, 72-hour
acknowledgement, private fix branch, regression test included.

For **operator** breaches — someone abused *your* deployment — your obligations
are mapped in [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md): GDPR Art. 33
(72 hours to the supervisory authority), Art. 34 (notify data subjects where risk
is high), DPDP §8 (without delay).

Prepare the record before you need it:

```bash
rc audit export --since 2026-10-01 --format ndjson > incident.jsonl
rc audit verify
```

---

## 10. Children and prohibited data

opencode-rc is a developer tool. We do not target children and do not knowingly
support processing children's data. Operators must not use it for that.

Prohibited: health, biometric, precise geolocation, and any special-category data
under GDPR Art. 9. This is noted so operators can assess fitness for their
context — not because the software can enforce it for you.

---

## 11. Your checklist before going live

- [ ] `PRIVACY.md` copied and adapted into whatever surface your users actually see
- [ ] `docs/SUBPROCESSORS.md` reviewed against the platforms you enabled
- [ ] `RC_LOG_ACTOR=hash` (the default — do not set `raw` casually)
- [ ] Retention values match your stated policy
- [ ] A `/privacy`, `/export` and `/forget` path documented for your users
- [ ] `rc audit export` wired into whatever your incident process uses
- [ ] A lawful-basis decision recorded in your own documentation, with the
      reasoning — not just the answer
- [ ] Counsel has reviewed it, if you are in a regulated setting

---

## Changes to this document

Material changes are noted in the release that ships them. Because this is a
template you adopt, changes here do not retroactively change your obligations —
your deployment's configuration does.
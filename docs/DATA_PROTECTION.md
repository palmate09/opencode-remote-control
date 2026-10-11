# Data Protection — GDPR & DPDP mapping

> **This document is engineering guidance, not legal advice.** It maps what the
> software does to the concepts in two statutes so an operator can write an
> accurate notice. If you operate in a regulated setting, have counsel review
> your specific configuration. See [PRIVACY.md](../PRIVACY.md) for the notice
> template itself and [SUBPROCESSORS.md](SUBPROCESSORS.md) for who sees what.

---

## 1. Roles, taken seriously

Most projects get this backwards, so it goes first.

| Entity | Role | Under GDPR | Under DPDP (India) |
|---|---|---|---|
| opencode-rc (the software) | Provider of the means of processing | Art. 4(8) | — |
| **You**, the operator | Controller | **Art. 4(7)** | **Data Fiduciary, §2(4)** |
| The people you authorise | Data subjects | Art. 4(1) | Data Principal, §2(2) |
| Telegram / Discord / Slack | Sub-processor | **Art. 28** | Significant Data Fiduciary |
| Model providers (via opencode) | Sub-processor | Art. 28 | — |
| Tailscale (if used) | Sub-processor | Art. 28 | — |

**opencode-rc is not a controller and never acts as one.** It holds no user
accounts, registers nobody, transmits nothing on your behalf, and has no
customer relationship with any end user. If you need a Data Processing
Agreement from a vendor, this is not it.

**You** are the controller. Every privacy feature below is operator-configurable
for exactly that reason.

---

## 2. What is processed

### 2.1 Personal data

| Category | Example | Source | Lawful basis (GDPR) |
|---|---|---|---|
| **Identifiers** | Telegram numeric user id, Discord snowflake, Slack member id | The platform's API | Art. 6(1)(f) |
| **Correspondence** | Message content | The user, via the platform | Art. 6(1)(f) |
| **Technical activity** | "a message was sent by actor X to session Y, length N" | Generated | Art. 6(1)(f) / (c) |
| **Authorisation decisions** | "permission `abcde` answered `once` by actor X" | Generated | Art. 6(1)(c), Art. 5(2) |
| **Credentials** | Bot tokens, API passwords | Your configuration | Art. 6(1)(f), and these are *your* secrets, not personal data |

### 2.2 Not personal data

- Tool output relayed through opencode (your own code, your own machine)
- Session titles you wrote
- The hash chain in the audit log, with no key

---

## 3. Data minimisation

This is the part that is actually engineered rather than promised.

### 3.1 Message bodies never enter our logs

They live in opencode's transcript storage and in the chat platform's. Our logs
record that a message was sent, by whom (hashed), to which session, and its
length — never its content.

This is the single most important data-minimisation decision in the project and
it is enforced by a test (`tests/bridge.test.ts`). A promise in a README is not a
control.

### 3.2 Pseudonymisation

Audit records store `sha256(salt + platform + ":" + id)`, not the raw id.

| Purpose | Still works? |
|---|---|
| Correlate one person's actions over time | ✅ |
| Enforce per-actor limits | ✅ |
| Answer "was that tap mine?" | ✅ — the operator knows their own id and can hash it |
| Go from a stolen audit log to a Telegram account | ❌ — needs `audit.salt` too, which is `0600` |

Under GDPR Recital 26, pseudonymised data is still personal data where the
additional information (the salt) is held by the controller. So we do not claim
anonymisation — we claim a materially reduced exposure if the log alone is
disclosed. `RC_LOG_ACTOR=raw` turns it off.

### 3.3 Cap, mask, strip

Everything relayed passes through `sanitize.ts`:

1. Neutralise invisibles, bidi controls, tag characters, homoglyphs
2. Fold whitespace runs
3. Mask credentials as `[REDACTED]`
4. Cap at 3,500 code points with head and tail preserved

### 3.4 Structural separation

`app.log` (debug) and `audit.jsonl` (evidence) are separate files, so an operator
can share one in a bug report without leaking the other, and rotate one
aggressively while preserving the other.

---

## 4. Lawful basis

| Processing | GDPR | DPDP | Notes |
|---|---|---|---|
| Operating the bridge you chose to run | Art. 6(1)(f) legitimate interests | §6(1)(a) consent | See §4.1 |
| Authentication and access control | Art. 6(1)(f) | §6(1)(a) | Security is a legitimate interest |
| Audit trail | Art. 6(1)(c) and/or Art. 6(1)(f) | §6(1)(c) | Accountability under Art. 5(2) |
| **Telemetry** | **none — we collect none** | **none** | There is no code path |

### 4.1 Why legitimate interests rather than consent

A self-hosted tool processing your own messages in order to do what you asked
for is a textbook legitimate-interest case (Recital 47): the processing is
necessary, it is your data, and the impact on others is nil.

Consent for a local daemon is theatre. A banner you click once in your own
terminal does not make the processing more consensual; it makes it harder to
audit.

DPDP is consent-centric, so we do both:

```bash
rc consent show       # what was recorded, and when
rc consent withdraw   # stop all processing
```

The record lands in `state/consent.json` with version, timestamp and notice hash.
**Withdrawal removes the record; stop the daemon too.** Withdrawal is honoured at
the next start, and we say that plainly rather than implying a consent file is a
kill switch.

### 4.2 Balancing test (Art. 6(1)(f))

| Factor | Assessment |
|---|---|
| **Purpose** | Operate a bridge the user deliberately configured |
| **Necessity** | Without processing the message, the tool does nothing. There is no less-intrusive way to run an agent from a chat app. |
| **Balance** | The subject is the operator or someone they chose to authorise. Impact on third parties is nil. On the subject: they can `/forget`, `/export`, or `rc access revoke` at any time. |

---

## 5. Data subject rights

Every right is a working command. "Contact us" is not an implementation.

| Right | GDPR | DPDP | Command | Effect |
|---|---|---|---|---|
| Notice | Art. 13 | §5 | `/privacy` | States who the controller is, what is held, what is not |
| Access | Art. 15 | §11(1) | `/export` | JSON bundle: allowlist entry, sessions, audit records, consent, retention |
| Portability | Art. 20 | §11(4) | `/export --format ndjson` | One JSON object per line; pipes into `jq` |
| Erasure | Art. 17 | §11(3) | `/forget` | Removes session mappings, purges this actor's audit records |
| Rectification | Art. 16 | §11(2) | `/forget --session <id>` then re-prompt | Removes the incorrect mapping; the session can be re-created |
| Restriction | Art. 21 | §11(5) | `/forget --purge-only` | Drops audit records, keeps the session mapping |
| Consent withdrawal | Art. 7(3) | §6(6) | `rc consent withdraw` | Removes the consent record |

### 5.1 Rights requests are themselves audited

Art. 5(2) accountability means you must be able to demonstrate that a request
was handled. `Bridge.privacy.forget()` writes a `privacy.forget` record
*before* the hash chain moves on, listing what was removed.

### 5.2 Producing the record without a vendor

```bash
rc audit export --since 2026-10-01 --format ndjson > incident.jsonl
rc audit verify
```

---

## 6. Retention

| Record | Default | Setting | Expiry behaviour |
|---|---|---|---|
| Debug logs | 7 days | `RC_LOG_RETENTION_DAYS` | Rotated files deleted; the live file is never truncated |
| Audit log | 90 days | `RC_AUDIT_RETENTION_DAYS` | Records filtered out; chain re-verified |
| Rotated debug files | 10 files max | `RC_LOG_ROTATE_MAX_FILES` | Oldest dropped |
| Pending pairing codes | 1 hour | hard TTL | Pruned lazily on every inbound message |
| Session mappings | until `/forget` or session deletion | `/forget` | Removed atomically |
| Consent record | life of install | `/forget --all` | File removed |
| **Message content** | **never stored by us** | n/a | — |

**Purge runs on a timer and at startup.** A machine that was off for a month
catches up immediately. A purely timer-driven purge leaves stale records on disk
for as long as the machine was asleep.

Retention does **not** shorten below one day by default. Setting
`RC_LOG_RETENTION_DAYS=0` would delete the audit log on every start, which is
almost certainly not what you want.

---

## 7. Transfers

Messages transit Telegram's, Discord's or Slack's infrastructure, which is very
likely outside your jurisdiction. For EU users that is a transfer requiring an
adequacy decision or standard contractual clauses, supplied by the platform
under their DPA. See [SUBPROCESSORS.md](SUBPROCESSORS.md).

**opencode-rc adds no further transfer.** There is no cloud, no analytics
endpoint, no telemetry. The only outbound connections are:

1. the opencode server you configured (`RC_OPENCODE_URL`), and
2. the chat platforms you explicitly enabled.

Bind opencode to `127.0.0.1` or a Tailscale address. If it is on the public
internet, its `HOST` header and TLS posture become your transfer posture too.

---

## 8. Security of processing

Art. 32. See [SECURITY.md](../SECURITY.md) and
[THREAT_MODEL.md](THREAT_MODEL.md) for the full analysis. In brief:

| Measure | Implementation |
|---|---|
| Pseudonymisation of identifiers | `sha256(salt + platform + ":" + id)` |
| Encryption at rest | **Not implemented.** Relies on OS disk encryption. |
| Access control on state files | `0700` directory, `0600` files |
| Integrity of the audit trail | Hash chain — tamper *evidence*, not prevention |
| Recovery | Restore from `state/`; session mappings are advisory, opencode holds the real sessions |
| Regular testing | 199 automated tests; CI on every push |

**Encryption at rest is the most significant gap.** There is none. If you need
it, use full-disk encryption (FileVault, LUKS, BitLocker) or an encrypted
volume for `state/`. We do not implement application-level encryption because a
key in the same process that reads the data is not a security control.

---

## 9. Breach response

### 9.1 Operator obligations

| Trigger | Obligation | Deadline |
|---|---|---|
| Personal data breach | GDPR **Art. 33** — notify the supervisory authority | **72 hours** from becoming aware |
| High risk to the subject | GDPR **Art. 34** — notify the data subject | without undue delay |
| DPDP breach | **DPDP §8(5)–(6)** — notify the Data Principal and the Data Protection Board | without delay |
| Records of breaches | GDPR Art. 33(5) — document it | — |

### 9.2 What a breach of *this* system means

| Compromised | Consequence |
|---|---|
| The **platform account** of a paired user | An attacker can drive the agent until you revoke. `rc access revoke <platform:id>` takes effect on the next message. |
| `state/access.json` | An attacker with your UID can authorise themselves. They already had code execution as you. |
| `state/logs/audit.jsonl` alone | Pseudonymised. Re-identification needs `audit.salt` as well. |
| A **relayed secret** | A credential pattern we did not recognise reached a chat platform. Rotate it. This is the most *likely* breach and the easiest to miss, because the sanitiser makes it look handled. |
| The **host machine** | Out of scope for this tool. |

### 9.3 Preparing the record

```bash
rc audit export --since <incident-date> --format ndjson > incident.jsonl
rc audit verify                        # prove the chain was not edited
```

The audit log is designed to be exactly this record, produced without a vendor.

---

## 10. Children and prohibited data

opencode-rc is a developer tool. We do not target children and do not knowingly
support processing children's data. Operators must not use it for that.

**Prohibited:** health (Art. 9(1)), biometric data (Art. 9(1)), precise
geolocation (Art. 9(1)), and any other special-category data. Also excluded:
data of specially protected persons in the UK and data concerning children under
UK GDPR §21 and India's DPDP §3(3), both of which tighten the default.

This is noted so operators can assess fitness for their context — not because the
software can enforce it for you.

---

## 11. Operator checklist

- [ ] Copy `PRIVACY.md` into whatever surface your users actually see
- [ ] Review `SUBPROCESSORS.md` against the platforms you enabled
- [ ] Confirm `RC_LOG_ACTOR=hash` (do not set `raw` casually)
- [ ] Record your lawful-basis decision **with the reasoning**, not just the answer
- [ ] Set retention to match your stated policy
- [ ] Document `/privacy`, `/export` and `/forget` to your users
- [ ] Wire `rc audit export` into your incident process
- [ ] Enable full-disk encryption, or accept the gap explicitly
- [ ] Have counsel review it, if you are in a regulated setting
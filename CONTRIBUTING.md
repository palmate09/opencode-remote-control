# Contributing to opencode-rc

Thanks for considering it. This project is small, opinionated, and security-
adjacent, so the bar for changes is about **being able to justify them**, not
about volume.

---

## Ground rules

1. **A change that touches the security model needs a test that fails without
   it.** Not "a test that passes", a test that *fails* on the old code. If you
   are changing the gate, the sanitiser, the audit chain or the permission
   registry, write the failing test first.
2. **Core knows nothing about any platform.** No `if (telegram)` in
   `packages/core`. If you find yourself writing one, the change belongs in an
   adapter.
3. **Adapters never import `@opencode-ai/sdk`.** They import `@opencode-rc/core`
   and nothing else. This is what makes an opencode API migration a one-file
   change.
4. **Message bodies never enter our logs.** If your change causes one to be
   logged, it will fail CI.
5. **Tell the truth in the docs.** A limitation documented honestly is worth
   more than a feature described optimistically.

---

## Setup

Requirements: **Bun ≥ 1.2**. Node, npm and pnpm are not used.

```bash
curl -fsSL https://bun.sh/install | bash
bun install
bun run check          # lint + typecheck + test + build
```

`bun run check` must be green before you open a pull request. CI runs the same
gates plus `audit:verify` and `deps:license`.

### Running the bridge locally

```bash
bunx opencode-rc init
cp .env.example .env    # set RC_OPENCODE_URL
bunx opencode-rc doctor
bunx opencode-rc run --cli
```

The CLI adapter is the fastest way to debug the core: it is synchronous, it has
no rate limit, and every core behaviour is reachable from it. If a bug reproduces
in the CLI but not in Telegram, the bug is in the Telegram adapter, not the core.

---

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <subject>

[body]

[footer]
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`,
`chore`, `revert`.

**Scopes:** `core`, `cli`, `telegram`, `discord`, `slack`, `webhook`, `mcp`,
`api`, `docs`, `deps`.

Examples:

```
fix(core): preserve the tail when capping relay text

A head-only truncation hid `&& rm -rf /` behind the elision marker, which is
exactly the part an approver needs to see. `elide()` now splits 60/40 and
reserves the marker's own length out of the budget, so the result never exceeds
the cap.

Fixes #123
```

```
feat(slack): add Socket Mode transport
```

---

## Developer Certificate of Origin

Every commit must be signed off:

```bash
git commit -s
```

Or configure it once:

```bash
git config commit.gpgsign true
git config user.signingkey <your-key-id>
```

`DCO` is enforced by CI. Sign-off asserts only that you wrote the code or have
the right to submit it under the project's licence. It is not a CLA, and it does
not transfer copyright to anyone.

---

## Pull requests

**One logical change per pull request.** A refactor bundled with a feature makes
review impossible and reverts painful.

Please include:

- **Why.** What problem does this solve? A user-visible problem beats a
  theoretical one, but both are fine if you are honest about which it is.
- **What you tested.** The command you ran and the output.
- **What you deliberately did not do.** Out of scope is a legitimate sentence.
- **Risk.** Does this touch the security model, the audit chain, or anything
  that reaches a chat app? Say so, even if you think it is safe.
- **A failing-then-passing test** for anything in rule 1 above.

Maintainers may ask for changes, or decline. Declining a change is not a
judgement on you, and you are welcome to open a PR to improve the *reasoning*
even when the code is not accepted.

---

## Reporting security issues

**Do not open a public issue or a public PR for a vulnerability.** Follow
[SECURITY.md](SECURITY.md). The reporting channel is listed there.

We will not pursue legal action against good-faith security research that does
not: exfiltrate data beyond what is needed to demonstrate the issue, degrade the
service, access other users' data, or disclose the issue publicly before the
90-day window closes.

---

## Adding an adapter

Adapters are the extension point. A new platform should not require touching
`packages/core`.

```bash
mkdir packages/<name>/src
```

1. **`package.json`** with one dependency: `@opencode-rc/core`.
2. **Implement `Adapter`**: `start(ctx)`, `stop()`, `send(msg)`.
3. **Declare capabilities honestly.** `permissionRelay` must be `false` unless
   the adapter can *positively authenticate the person tapping a button*. A
   webhook URL authenticates a caller, not a person — the webhook adapter ships
   with `permissionRelay: false` for exactly this reason. There is a test for
   every adapter's declaration.
4. **Map platform limits** into constants with a comment citing where the number
   came from (see §10.1 of `PLAN.md`). Do not hardcode `4096` in a function body.
5. **Export `create(env)`** reading your own environment variables, plus a
   string `id`.
6. **Register it** in `packages/cli/src/adapters.ts`, with the environment flag
   and the required keys.
7. **Tests** for card rendering, callback payload round-trip, and forged-payload
   rejection.

If you find yourself needing a core change to add your adapter, that is probably
a missing abstraction in the core. Open an issue describing it before you work
around it — the workaround will outlive the issue.

---

## Dependencies

Adding a dependency is a decision, not a convenience.

- **Prefer the platform's documented HTTP/WebSocket API over an SDK.** The
  Discord and Slack adapters have no SDK dependency and implement the protocol
  directly with Bun's native `WebSocket`. A third-party SDK is a permanent
  maintenance obligation and a permanent supply-chain surface.
- **`bun run deps:license` must pass.** It fails on GPL-3.0, AGPL and SSPL
  contamination, because our MIT claim is worthless if our dependencies are not
  permissive.
- **Say why in the PR**, including what breaks if you use the raw API instead.
  If the answer is "nothing", use the raw API.

---

## Code style

`biome` decides. `bun run lint:fix` applies. The rules that are not automated:

- **Comments explain *why*, not *what*.** If a line needs a comment saying what
  it does, the line is wrong. Comments explaining a non-obvious *reason* are
  the good kind — several in this codebase cite the property being preserved.
- **Cite the plan.** `§7.1`, `§10.3` — a reader can check the reasoning rather
  than guessing.
- **Fail closed.** A missing or malformed security setting is an error, never a
  default. Defaults are only for things that are safe when wrong.
- **Errors are typed and carry a remedy.** `throw new ConfigError(msg, setting)`
  so the operator is told what to change.

---

## Licence

By contributing you agree that your contribution is licensed under the
project's [MIT licence](LICENSE), and you represent that you have the right to
submit it. See [NOTICE](NOTICE) for the provenance and clean-room statement.
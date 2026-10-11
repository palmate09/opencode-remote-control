# Governance

opencode-rc is a small, security-adjacent open-source project. This document
describes how decisions get made, who decides them, and how you can become a
maintainer. It is deliberately short: governance documents that nobody reads
are worse than none.

---

## Decision-making

**Laziness by default.** We do not write a 200-line RFC for a bug fix.

| Change | Who decides |
|---|---|
| Bug fix, docs, tests, refactors with no behaviour change | Any maintainer, via review |
| New adapter, new command, new configuration option | Maintainer approval, at least one other maintainer aware |
| **Anything touching the security model** (§7.1 gate, §7.2 pairing, §7.3 sanitiser, §7.4 layers, §8 privacy) | **All maintainers must agree**, and a failing-then-passing test is required |
| Dependency additions | Maintainer approval; see [CONTRIBUTING.md](CONTRIBUTING.md#dependencies) |
| Licence change | Super-majority (below) |
| Releasing | Any maintainer, following the checklist in `CONTRIBUTING.md` |

When maintainers cannot reach agreement, the decision is **deferred** — the
feature does not ship. Deferring is cheaper than shipping something wrong in a
project whose entire value proposition is "this thing is safe".

### Trivial changes

Spelling, formatting, broken links, and typo fixes do not need review beyond
normal CI.

### The security rule

Any change that can affect *whether an unauthorised party can reach your agent*
requires:

1. A test that **fails without the change**, and
2. Approval from every maintainer, and
3. A note in the pull request describing the attack it defends against.

There is no exception process. If you cannot write the test, the change is not
understood well enough to ship.

---

## Maintainers

Maintainers are people with commit rights. Listed on the repository's
`OWNERS`/`CODEOWNERS` files.

### How someone becomes a maintainer

Maintainers are added by unanimous agreement of the existing maintainers. In
practice, that means a consistent track record of:

- substantive contributions (code, review, documentation, testing) over time,
- reviews that are **thorough and kind**, not merely numerous,
- an understanding of the security model that shows up in their contributions,
- agreement with [SECURITY.md](SECURITY.md) and the disclosure process,
- agreement with the [Code of Conduct](CODE_OF_CONDUCT.md).

There is no minimum commit count. A person who has spent a month finding the one
bug in the sanitiser is more valuable than someone with fifty trivial commits.

### How a maintainer steps down

At any time, without explanation and without drama. Tell the other maintainers,
and the commit rights are removed. Stepping back up should be possible later.

### How a maintainer is removed

For conduct violating the [Code of Conduct](CODE_OF_CONDUCT.md), for abusing
the disclosure process, or for being unreachable for more than six months, by
agreement of the other maintainers. Removal is reversible. We tell the person
being removed, in private, why.

---

## Super-majority

Needed for changes that are hard to reverse:

- changing the licence,
- removing or renaming a public interface,
- weakening any security control,
- accepting a dependency that changes the privacy properties (network calls,
  telemetry, licence class).

Three quarters of maintainers agreeing, with a documented rationale in the pull
request. The person proposing the change does not get a deciding vote on
whether their own change is sufficient.

---

## Releases

Cut by any maintainer. The checklist:

1. `bun run check` green: lint, typecheck, tests, build.
2. `bun run audit:verify` green.
3. `bun run deps:license` green.
4. `SECURITY.md`, `PRIVACY.md` and `docs/` updated for any behaviour change.
5. `CHANGELOG.md` entry written — **including breaking changes and security
   fixes, with a CVE if one was assigned.**
6. Tag, push, and write the release notes in plain language. "This changes the
   reply grammar" is useful; "improved UX" is not.

We version with [semver](https://semver.org). Because the project is pre-1.0,
`0.x` minor bumps may be breaking; `0.1.y` patches are safe.

---

## Decision records

Significant decisions are recorded in `PLAN.md` §14 (Decision log), with the
**why** and the date. New entries are added in the same pull request as the
change they justify. A decision without a recorded reason will be re-litigated
in six months by someone who does not remember the context.

---

## Contact

Maintainers are listed in the repository `CODEOWNERS` file. Security issues go
through the process in [SECURITY.md](SECURITY.md), not through a public issue.

---

## Adapting this document

If you fork opencode-rc, this document describes how *this* project is governed.
Your fork is yours: keep what fits, replace what does not. Please do remove
references to this project's maintainers rather than leaving them to be
contacted about software they do not maintain.
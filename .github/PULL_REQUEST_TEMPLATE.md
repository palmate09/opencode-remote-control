<!--
Thanks for the pull request. This template is short on purpose.

If this changes the security model — who can reach the agent, what they can see,
or what is logged — see GOVERNANCE.md: it needs unanimous maintainer approval
and a test that FAILS without the change.
-->

## What and why

<!-- The problem this solves. A user-visible problem beats a theoretical one, but
     both are fine if you are honest about which this is. -->

Fixes #

## How

<!-- The approach. If you found an existing abstraction that made this easier,
     say so — it is useful signal for future contributors. -->

## Testing

<!-- The command you ran and what it printed. -->

```
bun run check
```

## Risk

<!-- Does this touch the security model, the audit chain, or anything that
     reaches a chat app? Say so even if you think it is safe — especially then. -->

- [ ] Touches the security model (gate, pairing, sanitiser, audit chain, privacy)
- [ ] Adds a network destination
- [ ] Adds a dependency
- [ ] None of the above

## Out of scope

<!-- What you deliberately did not do. Out of scope is a legitimate sentence. -->

## Checklist

- [ ] `bun run check` is green (lint, typecheck, tests, build)
- [ ] New behaviour has a test
- [ ] Security-relevant changes have a test that **fails without the change**
- [ ] Commits are signed off (`git commit -s`)
- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)
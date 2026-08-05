# Kronik engineering guide

- Follow `CONTEXT.md` for domain language and `docs/adr/` for accepted decisions.
- Keep dependencies directed from `packages/contract` to `apps/api`; the contract package never imports API runtime, Cloudflare, GitHub, or Alchemy code.
- Define public HTTP inputs, outputs, and failures with Effect Schema and decode every external, persisted, or process-hop value.
- Keep HTTP handlers thin. Domain behavior belongs behind the `UserActivity` module interface.
- Use `Effect.gen`, named `Effect.fn` operations, `Context.Service`, explicit Layers, and typed `Schema.TaggedErrorClass` failures.
- Bind Effect services to named variables before invoking methods; do not nest service yields.
- Do not use star imports, import aliases, `any`, non-null assertions, unchecked casts, `else`, or global environment reads in application logic.
- Prefer Bun APIs and `bun:test`. Use deterministic Effect test services and clocks rather than sleeps.
- Run tests and typechecks from each package directory. Do not deploy, destroy, adopt domains, or modify Cloudflare resources without explicit confirmation.

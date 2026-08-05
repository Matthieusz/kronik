# Kronik v1 release verification

This report is the release gate for a non-deploying v1 verification. It is intentionally
separate from preview deployment approval.

## Verification evidence

The CI workflow (`.github/workflows/ci.yml`) runs on a clean checkout with no application
secrets and performs these checks:

- root formatting and linting;
- contract typecheck, tests, and generated OpenAPI freshness;
- API typecheck and default tests;
- the initialized local Alchemy Worker and its real Rate Limit and Durable Object bindings;
- the validated RPC → Durable Object → fake GitHub integration scenarios;
- Fumadocs typecheck and static build.

The local commands are equivalent to:

```sh
bun install --frozen-lockfile
bun run verify
```

The manually invoked live GitHub smoke test is excluded from CI and skips unless explicitly
enabled with `KRONIK_LIVE_GITHUB=1` and a service token. Default verification therefore does not
need GitHub credentials or real time.

## Release audit checklist

- [x] OpenAPI is generated only by `packages/contract` and is checked for freshness.
- [x] The docs build regenerates its Fumadocs operation pages from that OpenAPI document.
- [x] Conceptual docs describe default-branch/primary-author scope, actual parents, bounded
      messages, snapshot cursors and expiry, Activity Window coverage, language-byte semantics,
      trailing-range streaks, cache policy, stale warnings, rate limits, ETags, errors, and the
      service-owned GitHub credential model.
- [x] Runtime tests cover normalized cache identity, user isolation, persistence decoding,
      cursor expiry, stale fallback, rate-limit behavior, request IDs, public error projection,
      unknown-user negative-cache TTL, snapshot stability after a new commit, summary/streak
      miss coalescing, invalid Activity Windows, malformed calendars through the public route,
      and freshness boundaries for every activity capability.
- [x] An initialized local Alchemy Worker test covers the real Worker init, Durable Object
      namespace, and Rate Limit binding through the public fetch interface.
- [x] Searchable generated artifacts, docs, and public problem projections contain no GitHub
      token, cursor value or payload, authorization header, or raw caller IP.
- [x] No v1 account, caller-token, webhook, scheduled-refresh, GraphQL endpoint, generated SDK,
      custom analytics sink, D1, KV, or paid observability resource is declared.
- [ ] A real Cloudflare edge deployment has been verified. This requires separate approval and is
      intentionally not part of CI.
- [ ] A live GitHub smoke test has been run. This is optional release evidence and remains
      unverified when no service token is supplied.

## Residual risks and unsupported claims

- The initialized Worker integration uses deterministic fake upstream responses and local
  Cloudflare emulation; it does not prove production edge placement or live GitHub behavior.
- Cloudflare's production edge-cache and approximate rate-limit service behavior remain unproven.
- GitHub's live availability, quota, response evolution, and contribution-calendar completeness
  remain upstream risks.
- No claim is made that streaks are all-time, activity totals are complete when coverage is
  partial, language bytes represent personal authorship or proficiency, or Kronik is wire-compatible
  with Katib.

## Separately authorized preview procedure

Do not run these commands as part of ordinary verification. Before execution, obtain approval for
Cloudflare mutations, confirm the selected Alchemy profile, configure the service-owned secrets,
and record the resulting preview URLs without recording credentials.

1. Build and verify from the exact release revision with `bun run verify`.
2. Use the approved preview profile with `bun run dev -- --profile <preview-profile>` for a local
   plan/preview inspection, if required by the release operator.
3. After explicit approval, run `bun run deploy -- --profile <preview-profile>`.
4. Exercise `/health`, `/openapi.json`, `/docs`, and one representative route; inspect only safe
   request IDs, statuses, cache headers, and expected problem details.

## Rollback procedure

1. Stop public traffic to the preview if the operator's change plan requires it.
2. Restore the last approved release revision and rerun `bun run verify`.
3. With separate approval, redeploy that revision using the same approved profile:
   `bun run deploy -- --profile <preview-profile>`.
4. Recheck health, OpenAPI freshness, docs redirect, cache/error headers, and one activity route.

No deployment, secret insertion, domain adoption, destruction, or rollback has been executed by
this verification.

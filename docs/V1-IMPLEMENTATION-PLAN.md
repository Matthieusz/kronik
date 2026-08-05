# Kronik v1 vertical-slice implementation plan

This plan decomposes v1 into small, end-to-end slices. Except for the minimum shared foundation, each agent delivers one observable capability through every layer it needs: contract, domain policy, GitHub boundary, `UserActivity`, validated Durable Object RPC, public HTTP, documentation, and tests.

An agent must not build a whole horizontal layer “for later.” Extend shared modules only as far as the current slice requires.

## Authority and fixed boundaries

Before changing code, every agent must read these files completely:

1. `/AGENTS.md`
2. `/CONTEXT.md`
3. Every file in `/docs/adr/`
4. This plan
5. Every file it will modify and the nearest tests

Inspect exact APIs rather than relying on memory:

- Effect: `/home/informati/.local/share/effect-solutions/effect`
- OpenCode v2 practices: `/home/informati/.local/share/effect-solutions/opencode`
- Alchemy: current official documentation or installed source
- GitHub: current official documentation, schemas, or inspected responses

Never copy Katib source, fixtures, HTML, prose, or implementation-specific algorithms.

These v1 decisions are fixed unless the user explicitly changes them:

- Kronik is a coherent API, not a wire-compatible Katib clone.
- Public domain routes are exactly:
  - `GET /v1/users/:username/commits`
  - `GET /v1/users/:username/commits/latest`
  - `GET /v1/users/:username/activity`
  - `GET /v1/users/:username/streak`
- Operational routes are `/health`, `/openapi.json`, and a `/docs` redirect.
- `packages/contract` solely owns public schemas, HTTP declarations, RPC declarations, and generated OpenAPI.
- Dependencies point from `packages/contract` into `apps/api`; contract code never imports API runtime, Cloudflare, Alchemy, persistence, or GitHub code.
- HTTP and Worker-to-Durable-Object RPC are separate schema-validated trust boundaries.
- The API is anonymously readable. Kronik owns one least-privilege GitHub credential; callers never submit PATs.
- GitHub Activity means public default-branch commits whose primary author resolves to the Requested User, across repositories of any owner.
- Commits are ordered by committed timestamp descending.
- The Activity Window defaults to exactly 30 inclusive UTC dates and cannot exceed 90.
- Activity aggregation includes at most 100 commits and reports partial coverage explicitly.
- Longest Contribution Streak is bounded to the evaluated trailing 365-day GitHub calendar.
- Runtime stack: Bun, TypeScript 7, Effect v4, Alchemy, and Cloudflare Workers.
- Docs stack: Fumadocs generated from the authoritative OpenAPI document.
- No accounts, caller API keys, webhooks, scheduled refreshes, badges, GraphQL endpoint, generated SDK, custom analytics, D1, KV, or paid observability sink belong in v1.
- No deployment, destruction, custom-domain adoption, secret creation, or Cloudflare mutation occurs without explicit user confirmation.

If implementation evidence contradicts a fixed decision, stop and report it. Do not silently reinterpret domain language, widen scope, add compatibility behavior, or rewrite an ADR.

## Small-agent working protocol

Each agent owns one numbered slice and should not begin the next.

1. Confirm prerequisite slices are complete.
2. Read current code before proposing a seam or dependency.
3. Start from the caller-visible behavior and test through the slice's real interface.
4. Extend shared modules only with behavior immediately exercised by the slice.
5. Decode external, persisted, and process-hop values from `unknown`.
6. Keep HTTP handlers thin; domain sequencing belongs in the deep `UserActivity` module.
7. Use named `Effect.fn`, `Context.Service`, explicit Layers, structured concurrency, and typed expected failures.
8. Never use `any`, non-null assertions, unchecked casts, import aliases, star imports, nested service yields, global environment reads, arbitrary test sleeps, or hand-rolled in-flight maps.
9. Run package-local typechecks/tests for changed packages and root formatting/linting.
10. Regenerate and verify OpenAPI whenever the contract changes.
11. Update the status table and leave a concise handoff: files changed, behavior proved, commands run, unresolved risks.

Do not create commits, branches, PRs, or deployments unless explicitly requested.

## Status

| Slice | Observable increment                                   | Status   |
| ----: | ------------------------------------------------------ | -------- |
|     0 | Baseline contract and decisions                        | Complete |
|     1 | Running health/docs walking skeleton                   | Complete |
|     2 | Latest commit end to end                               | Complete |
|     3 | Paginated commit feed end to end                       | Complete |
|     4 | Activity summary end to end                            | Complete |
|     5 | Contribution streak end to end                         | Complete |
|     6 | Consistent edge/API policy across all routes           | Complete |
|     7 | Full resilience and cross-slice runtime verification   | Complete |
|     8 | CI, documentation completion, and release verification | Complete |

## Slice 0 — Baseline contract and decisions

**State:** Complete.

The repository contains the Bun workspace baseline, TypeScript 7 and Effect tooling, `CONTEXT.md`, ADRs, an initial `packages/contract`, generated OpenAPI, and basic username tests.

The contract compiles, but each later slice must sharpen the schemas it exercises before depending on them. Do not perform a detached “model everything perfectly” rewrite.

## Slice 1 — Running health/docs walking skeleton

**Outcome:** A local Cloudflare Worker answers `/health`, serves `/openapi.json`, redirects `/docs`, and has a separately buildable minimal Fumadocs site. No GitHub call exists yet.

### Contract

- Verify and test `Health` and `HealthGroup` only.
- Confirm OpenAPI metadata identifies Kronik v1.
- Keep the four domain declarations present, but do not invent runtime placeholders for them.
- Add a way to compose/build a health-only API for the walking skeleton if Effect's handler builder requires complete groups. Do not weaken the authoritative full `Api`.

### API application

- Create `apps/api` with strict TypeScript configuration and package-local scripts.
- Add typed Effect `Config` for the future GitHub token, cursor secret, and docs URL, but require only configuration needed by the currently exercised path.
- Wrap future secret values in redaction-safe types and prove test configuration through `ConfigProvider`; never read `process.env` in application logic.
- Build the health-only Effect `HttpApi` once in the Alchemy Worker init phase.
- `/health` returns `{ "status": "ok" }` without probing GitHub or cache infrastructure.
- Serve the generated contract OpenAPI document at `/openapi.json`.
- Redirect `/docs` to configured docs URL.

### Docs application

- Create `apps/docs` as a minimal Kronik Fumadocs app.
- Consume `packages/contract/openapi.json`; never duplicate endpoint schemas.
- Generate/build a minimal landing page and API-reference shell.
- Prefer static output compatible with Alchemy's Cloudflare static-site Worker path.

### Infrastructure declaration

- Add the smallest non-deployed Alchemy stack declaring the API Worker and docs static Worker.
- Keep custom domains absent and optional.
- Add `dev`, `deploy`, `destroy`, `logs`, and `tail` scripts, but do not run mutating commands.
- Use Alchemy profiles for Cloudflare credentials; never request exported account credentials.

### Tests and acceptance

- Test the real health handler, OpenAPI response, and docs redirect.
- Prove health remains independent of missing GitHub credentials.
- Build Fumadocs and verify it reads generated OpenAPI.

Run:

```sh
cd packages/contract && bun run typecheck && bun test && bun run openapi:check
cd apps/api && bun run typecheck && bun test
cd apps/docs && bun run typecheck && bun run build
cd ../.. && bun run format && bun run lint
```

**Do not:** Add GitHub clients, Durable Objects, caches, rate limiting, cursors, or fake domain responses.

## Slice 2 — Latest commit end to end

**Outcome:** `GET /v1/users/:username/commits/latest` works locally through public HTTP -> schema-validated Durable Object RPC -> `UserActivity.latestCommit` -> GitHub adapter, including cache and typed failures.

This slice establishes the reusable vertical path. Later slices extend it rather than creating parallel architectures.

### Contract exercised by this slice

- Harden `GitHubUsername`, `User`, `Repository`, `CommitSha`, `CommitParent`, `CommitSummary`, `LatestCommit`, and latest-commit errors.
- Full SHA only; actual Git parent references only.
- UTC RFC 3339 timestamps.
- Complete headline and body capped at 8 KiB UTF-8, preserving beginning/end with `bodyTruncated`.
- Valid user with no matching commit is distinct from absent user.
- Add the latest-commit RPC procedure and its runtime schema tests.
- Regenerate OpenAPI.

### GitHub boundary, only as deep as latest needs

- Verify current official GitHub REST/GraphQL capabilities before coding.
- Create one GitHub adapter using Effect `HttpClient`.
- Configure base URL, service-owned bearer credential, media type, user agent, safe tracing, and five-second request timeout in its Layer.
- Resolve canonical user identity separately from commit search.
- Search public default-branch commits by primary author and committed date descending.
- Hydrate exact additions, deletions, parent references, repository identity, authored/committed timestamps, and URL with the fewest truthful upstream operations.
- Decode every response body and relevant rate-limit header from `unknown` with Schema.
- Classify absent user, no commit, GitHub rate limit, malformed response, transport failure, timeout, and other status failures.
- Retry idempotent transport failures and `502/503/504` once with bounded jitter. Do not immediately retry GitHub rate limits or ordinary `4xx`.
- Tests use a fake Effect `HttpClient` transport with sanitized minimal fixtures; default tests never call GitHub.

### Domain/application

- Introduce the deep `UserActivity` module with the accepted four-method interface, but assemble/test only the latest-commit capability in this slice. Do not expose fake implementations for unfinished routes.
- Project decoded GitHub evidence into `CommitSummary` through pure domain functions.
- Safely derive `changedLines`; fail on unsafe numeric evidence.
- Include merge commits only when GitHub resolves the Requested User as primary author.

### Durable Object/RPC/cache

- Add a Durable Object keyed by normalized lowercase requested username.
- Use schema-validated Effect RPC, not Alchemy's schemaless bridge.
- Enforce agreement between Durable Object identity and RPC username.
- Define versioned persisted latest-commit cache records and decode storage values from `unknown`.
- Fresh success TTL: 60 seconds. Unknown-user negative TTL: 60 seconds. Eligible stale success: at most one hour. Other failures are not cached.
- Use Effect `Cache` for pending identical lookup deduplication; do not hand-roll an in-flight map.
- Apply a ten-second total cold-workflow deadline; serve eligible stale data after timeout/upstream failure.

### Public HTTP/docs

- Add only the latest-commit handler to the runtime activity composition used by slice tests.
- Handler decodes, delegates, and projects typed errors; it contains no GitHub/domain logic.
- Add Fumadocs conceptual text for commit scope, primary-author attribution, actual parents, message truncation, and latest/no-commit semantics.

### Acceptance

Tests through the public route must prove:

- mixed-case input returns canonical GitHub login;
- invalid syntax is `400` and absent valid user is `404`;
- no matching commit has its own `404` problem;
- result uses committed-time ordering and exact parent references;
- message bounding is Unicode-safe;
- fresh hit, coalesced identical miss, negative cache, stale fallback, timeout, malformed persisted record recovery, and secret redaction work;
- raw GitHub/Effect/Cloudflare failures never cross HTTP.

**Do not:** Implement commit pagination, Activity Summary, streaks, edge cache, per-IP rate limiting, or broad generic GitHub wrappers.

## Slice 3 — Paginated commit feed end to end

**Outcome:** `GET /v1/users/:username/commits` supports stable bidirectional opaque cursor pagination through the same Worker, Durable Object, `UserActivity`, and GitHub path.

### Contract

- Model two valid query modes truthfully:
  - initial request: optional `limit`, default 10, range 1–100;
  - continuation: `cursor` only.
- Reject `cursor` combined with `limit`.
- Keep response `{ user, items, previous, next }`.
- Harden `Cursor`, `CommitPage`, the commits RPC payload, and invalid-cursor problem.
- Regenerate OpenAPI and add examples for initial and continuation requests.

### Cursor domain module

- Implement versioned base64url cursor payloads authenticated with HMAC-SHA-256 via Worker-compatible Web Crypto.
- Carry normalized username, snapshot timestamp, page size, position, and direction.
- Expire after one hour.
- Reject malformed, altered, expired, unsupported-version, wrong-user, and wrong-direction cursors.
- Inject clock and redacted cursor-secret authority for deterministic tests.
- Cursor values/payloads never enter logs.
- No cursor persistence, encryption, compatibility decoder, or multiple signing keys.

### Existing vertical path extension

- Extend the GitHub adapter only with paginated search evidence needed now.
- Initial request captures a snapshot upper bound; later pages preserve it so new commits do not shift results.
- Order by committed timestamp descending.
- Expose previous/next only when supported by actual search evidence.
- Stop at GitHub's searchable 1,000-result boundary and never imply further reach.
- Extend `UserActivity.commits`, the existing validated RPC group, Durable Object cache, public handler, and docs.
- Fresh page TTL: 60 seconds. Cache keys use normalized semantic inputs, not raw query-string order.

### Acceptance

Public-route tests prove initial/default/custom limits, query exclusivity, round-trip cursors, tampering, expiry, cross-user rejection, forward/backward navigation, snapshot stability when a new commit appears, the 1,000-result boundary, coalesced identical page misses, and no cursor leakage.

**Do not:** Add page-number parameters, mutable pagination sessions, database tables, Activity Summary, or streak logic.

## Slice 4 — Activity Summary end to end

**Outcome:** `GET /v1/users/:username/activity` returns bounded, truthful commit totals and Repository Language Breakdown for an Activity Window.

### Contract/domain

- Use branded ISO dates at HTTP and RPC boundaries rather than unchecked strings.
- Resolve default window to UTC today plus the previous 29 dates.
- Explicit `from`/`to` are inclusive and span at most 90 dates.
- Reject malformed, reversed, or otherwise unsupported windows with typed invalid-request problems.
- Add pure date tests for leap days, year boundaries, inclusivity, and controlled time.
- Harden `ActivityWindow`, `ActivityCoverage`, `ActivityTotals`, `Language`, and `ActivitySummary`.

### Existing vertical path extension

- Extend the GitHub adapter only with bounded window search and repository-language operations.
- Aggregate at most 100 commits from one bounded search result.
- Preserve GitHub total count and incomplete-search evidence.
- Set `matchedCommits`, `aggregatedCommits`, and `complete` truthfully; partial aggregates are never called complete totals.
- Sum additions, deletions, and changed lines with safe integer handling.
- Deduplicate repositories before requesting languages.
- Bound independent repository-language requests with structured concurrency and a documented small concurrency limit.
- Keep exact GitHub language bytes; never reweight dominant languages.
- Sort by bytes descending and name tie-breaker.
- Return at most 20 languages; conserve all omitted bytes in `otherBytes`.
- Percentages use total bytes including `otherBytes`.
- Extend `UserActivity.summarize`, validated RPC, Durable Object cache, public handler, and docs.
- Fresh Activity Summary TTL: five minutes; eligible stale success remains bounded to one hour.

### Acceptance

Public-route and interface tests cover default/custom windows, invalid windows, complete/partial/incomplete coverage, no commits, duplicate repositories, absent language data, dominant language, over-20 language tail, stable sorting, exact byte conservation, percentages, bounded concurrency, cache/coalescing, and stale fallback.

Docs must explicitly say repository bytes do not represent code personally authored or language proficiency.

**Do not:** Crawl more than 100 commits, add background jobs, distort language weights, or introduce D1/KV.

## Slice 5 — Contribution Streak end to end

**Outcome:** `GET /v1/users/:username/streak` returns current and longest bounded Contribution Streak through the established path.

### Contract/domain

- Harden `ContributionStreak` and streak RPC schemas.
- Implement a pure streak calculation over decoded ordered GitHub calendar dates.
- Evaluate only the represented trailing 365-day range.
- Ignore today's empty cell once, allowing yesterday's contribution to remain current.
- Any earlier empty date ends the current streak.
- `active` equals `currentStreak > 0`.
- Longest streak is not labeled all-time.

### Existing vertical path extension

- Extend the GitHub adapter only with the contribution-calendar query and schemas.
- Distinguish absent user, valid user with zero contributions, malformed calendar, rate limit, and upstream failure.
- Extend `UserActivity.streak`, validated RPC, Durable Object cache, public handler, and docs.
- Fresh streak TTL: five minutes; eligible stale success remains bounded to one hour.

### Acceptance

Tests through the module and route cover empty calendar, no contributions, today active, today empty/yesterday active, broken streak, longest-streak ties, leap day, year boundary, malformed calendar, canonical user, caching/coalescing, and stale fallback. Use controlled time; never sleep.

**Do not:** Calculate all-time history, infer streak from commits, or use server-local timezone.

## Slice 6 — Consistent edge/API policy across all routes

**Outcome:** The full authoritative `Api` is assembled once, and every route follows the same public HTTP, abuse-protection, cache, error, and observability policy.

This slice applies policy to already working capabilities; it must not rewrite their domain behavior.

### Full runtime assembly

- Assemble all four domain handlers and health under the authoritative `packages/contract` `Api`.
- Build Effect `HttpApi` once in Worker init.
- Keep handlers as decode/delegate/project adapters.
- Serve `/openapi.json` and `/docs` redirect consistently.

### Public edge policy

- Public CORS permits `GET`, `HEAD`, and `OPTIONS`.
- Apply Cloudflare's approximate Rate Limiting binding to all requests, including cache hits: 60 requests/minute per `CF-Connecting-IP`.
- Fail open if the limiter binding fails. Return `429` and `Retry-After` when denied.
- Check Cloudflare edge cache before Durable Object RPC and cache only outcomes allowed by established policies.
- Emit ETags and honor `If-None-Match` with `304`.
- Emit `Cache-Control`, `Age`, and `X-Kronik-Cache: hit|miss|stale`.
- Emit `Warning: 110 - "Response is stale"` for stale success.
- Generate or validate one bounded request ID and return `X-Request-ID`.
- Use `urn:kronik:request:<id>` as problem `instance`; never echo cursor-bearing URLs.
- Project expected failures as stable RFC 9457-compatible `application/problem+json` without internal `_tag`, cause, stack, provider body, or secret.

### Observability

Log/trace only safe fields: request ID, route, canonical username, cache outcome, stale age, GitHub operation/rate evidence, latency, status, and expected error tag.

Never log GitHub token, cursor secret, authorization headers, cursor values/payloads, raw IP addresses, arbitrary request/response bodies, environment objects, or unclassified thrown values.

### Acceptance

Tests cover every route and declared problem, content type, CORS/preflight, HEAD, rate-limit success/denial/binding failure, edge hit/miss/stale, ETag/304, cache headers, request-ID replacement, docs redirect, health independence, redaction, cancellation, and ten-second total cold-workflow deadline.

**Do not:** Add exact global rate counters, API keys, user accounts, or a paid telemetry sink.

## Slice 7 — Full resilience and cross-slice runtime verification

**Outcome:** The complete local Cloudflare runtime proves the architecture's coordination and recovery claims rather than only isolated module behavior.

### Integration scenarios

Use the actual Worker -> validated RPC -> Durable Object -> `UserActivity` -> fake GitHub `HttpClient` path to prove:

- one complete happy path per domain route;
- representative typed failures per route;
- concurrent identical edge misses cause one coordinated upstream lookup;
- different users progress independently;
- one normalized mixed-case username maps to one Durable Object identity;
- RPC payload username must agree with object identity;
- persisted cache values are schema-decoded after reactivation;
- malformed persisted entries are discarded safely;
- fresh and negative TTLs match the accepted table;
- transient failures are not cached;
- eligible stale success survives activation and is used only after timeout/upstream failure;
- invalid input, cursor, and authorization failures never receive stale fallback;
- fibers, streams, and resources do not outlive their owning call scope.

### Opt-in upstream verification

- Add a manually invoked live GitHub smoke test requiring a service token.
- Skip clearly when absent.
- Exclude from default CI.
- Never print token or full provider responses.

### Acceptance

All default tests run without application secrets, live GitHub, real time, arbitrary sleeps, module mocks, global mutation, or private-helper assertions.

## Slice 8 — CI, documentation completion, and release verification

**Outcome:** A clean checkout proves v1 and produces a report suitable for a separately authorized preview deployment.

### CI

Add a non-deploying workflow for:

- root formatting and linting;
- package-local typechecks/tests;
- OpenAPI regeneration/freshness;
- local Cloudflare integration tests;
- Fumadocs static build.

CI must not deploy or require application secrets.

### Documentation completion

Fumadocs must generate endpoint reference from OpenAPI and include concise conceptual pages for:

- public default-branch and primary-author scope;
- actual parent references and message truncation;
- pagination snapshot, opaque cursor, and one-hour expiry;
- Activity Window and partial coverage;
- Repository Language Breakdown semantics;
- trailing-range Contribution Streak semantics;
- cache freshness, stale warning, rate limit, ETags, and errors;
- GitHub attribution and service-owned credential model.

Docs must not claim all branches, all-time streaks, personal language proficiency, complete totals when coverage is partial, caller PAT support, or Katib compatibility.

### Release verification

- Run all checks from a clean checkout.
- Compare generated OpenAPI to actual route/status/content-type behavior.
- Audit logs, errors, snapshots, docs, and generated artifacts for secrets, cursors, and raw IPs.
- Review cache-key normalization, user isolation, cursor expiry, rate limits, and scope ownership.
- Confirm no prohibited v1 capability or storage resource entered dependencies/infrastructure.
- Record unsupported claims, blockers, and residual risks instead of marking them verified.
- Prepare preview deployment and rollback instructions without executing them.

The user must separately approve any Alchemy deployment, Cloudflare resource mutation, secret insertion, or domain adoption.

## Final v1 behavior gate

v1 is incomplete until evidence demonstrates all of the following:

- Mixed-case usernames resolve to GitHub's canonical login and one normalized coordination identity.
- Invalid syntax is `400`; absent valid user is `404`.
- Commits cover public default branches across repository owners and primary-author attribution only.
- Commits order by committed time and pagination preserves an initial snapshot.
- Cursors are opaque, tamper-evident, user-bound, versioned, directional, and expire after one hour.
- Latest commit distinguishes no commit from no user.
- Activity uses a bounded inclusive window and reports partial coverage truthfully.
- Language bytes remain exact, deduplicate repositories, cap at 20 entries, and conserve the remainder.
- Streaks use GitHub calendar dates, tolerate an empty today, and label the 365-day longest streak truthfully.
- Public callers never submit GitHub credentials.
- Identical global misses coalesce per normalized user while different users can progress independently.
- Cache freshness, negative caching, and stale fallback match accepted policy.
- Rate limiting is approximate per-location/per-IP abuse protection and fails open on limiter failure.
- Expected HTTP failures are safe stable problem details with request-scoped instances.
- ETag, CORS, cache, stale, rate-limit, and request-ID headers are consistent.
- OpenAPI comes only from `packages/contract`; Fumadocs consumes it without schema duplication.
- Default tests depend on neither live GitHub nor real time.
- No deployment or Cloudflare mutation occurs without explicit confirmation.

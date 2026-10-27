# Rat Stack assessment for Kronik

## Verdict and scope

Rat Stack is a useful reliability checklist, not a reason to change Kronik's stack. Kronik already implements much of its architectural advice. The strongest improvements are cache retention, shared upstream-budget protection, complete-operation observability, and executable architectural constraints.

This assessment compares first-party Rat Stack documentation with inspected Kronik source. Recommendations below are static-review findings, not reproduced production incidents or proof that Rat Stack's implementations solve them. No application/configuration code or cloud resources were changed. Public documentation/source was fetched; no live activity API or credentialed smoke test was invoked.

## Prioritized improvements

### 1. High: give persisted caches a retention policy

**Lesson:** [Steady state recycles resources](https://ratstack.sh/lore/steady-state-recycles-resources) distinguishes bounded runtime caches from storage retention.

**Local evidence:** `apps/api/src/activity-object.ts` bounds its in-memory caches to 1 or 32 entries and checks persisted freshness/staleness. However, successful page, summary, and streak lookups write distinct persistent keys. Its storage seam only exposes get/put/delete; malformed values are deleted, but valid expired records have no cleanup path. `apps/api/src/cursor.ts` creates a timestamped snapshot for every new feed, which becomes part of the persistent page key. Summary windows and daily streak ranges add other changing keys. Expiry prevents serving old data; it does not remove these records.

**Recommendation:** define bounded persistent retention and a bounded cleanup mechanism, preserving records needed for the one-hour cursor/stale policies. This is cache housekeeping, not a durable-job system. Add a repeated-request test that advances time and checks both retained entry count and surviving cursor/stale behavior. A new alarm or cloud resource would require separate approval.

### 2. High: budget aggregate GitHub work, not only each request

**Lesson:** [Admission control](https://ratstack.sh/lore/admission-controls-new-work) and [retry budgets](https://ratstack.sh/lore/retry-load-needs-a-budget) explain why individually bounded calls can collectively overwhelm a shared dependency.

**Local evidence:** `apps/api/src/github.ts` limits hydration concurrency to 8 and language concurrency to 4 **per lookup**, with one jittered retry. An Activity Summary can issue 1 user lookup + 1 search + up to 100 hydration calls + up to 100 unique-repository language calls: up to 202 calls before retries. This is a static upper bound, not a measured typical cost. `apps/api/src/worker.ts` supplies an approximate per-IP limiter, while `activity-object.ts` coalesces identical keys per requested user. These are useful controls, but they do not establish a credential-wide budget across different users, windows, and locations.

**Recommendation:** first test and measure total attempts across concurrent distinct requests, then choose the smallest suitable admission/cooldown policy for the shared GitHub credential. Explicitly choose its coordination scope; an isolate-local semaphore is not a global quota guarantee. Keep the existing bounded retry owner rather than adding retries at RPC/HTTP layers. Test refusal, bounded outstanding work, and recovery after overload. Do not introduce a global coordinator or circuit breaker without evidence that justifies it.

### 3. Medium: include body decoding in timeout and telemetry semantics

**Lesson:** [Timeouts bound waiting](https://ratstack.sh/lore/timeouts-bound-waiting) calls for complete deadline coverage; [golden signals](https://ratstack.sh/lore/golden-signals-expose-overload) calls for measuring failed as well as successful work.

**Local evidence:** in `apps/api/src/github.ts`, the five-second timeout and `github.request` event wrap `request`, but `requestJson` reads/decodes JSON afterward through `decodeResponse`. A successful HTTP status can therefore emit `outcome: "success"` before an invalid body fails; body-read/decode latency is outside that event and the five-second attempt timeout. The coordinator's ten-second total lookup timeout still bounds live lookup work, so this is not a claim that all GitHub lookups are unbounded. Separately, `apps/api/src/activity-rpc.ts` has no explicit caller deadline around namespace acquisition/RPC; the coordinator timeout begins later and does not cover its storage read before `live`.

**Recommendation:** explicitly distinguish HTTP-status success from decoded-operation success, measure full operation failures/latency, and test a stalled body, malformed JSON, and a stalled coordinator. Choose an end-to-end deadline that covers the intended waits rather than simply raising timeout literals. Keep secrets, URLs, cursors, and raw payloads out of telemetry. No paid metrics backend is required to correct event semantics.

### 4. Medium: enforce the architecture we already document

**Lesson:** Rat Stack's [fence](https://ratstack.sh/systems/fence) and [hexagonal architecture](https://ratstack.sh/lore/hexagonal-architecture) turn import restrictions into tested rules rather than relying on agent instructions.

**Local evidence:** Kronik's `AGENTS.md` prohibits API/runtime/provider dependencies in `packages/contract`. That package currently declares only Effect as a runtime dependency, and `.oxlintrc.json` already has substantial type-aware and anti-slop enforcement. The inspected lint configuration does not contain a package-import restriction expressing this contract rule. A package dependency declaration alone does not prevent a relative source import.

**Recommendation:** add a narrowly scoped import check that rejects API, Cloudflare, GitHub-adapter, and Alchemy imports from the contract package, with accepted/rejected fixtures run in CI. Test the actual gate, including relevant relative paths. On compiler/checker upgrades, negative fixtures can also verify that intended diagnostics still fail CI; do not assume Rat Stack's exact checker instructions apply to Kronik's newer pinned tooling.

### 5. Lower: simplify obsolete construction interfaces and expand sequence tests

**Lessons:** [Keep or cut](https://ratstack.sh/skills/keep-or-cut) rejects speculative retained interfaces; [recovery model tests](https://ratstack.sh/lore/recovery-needs-model-tests) exercise combinations of state transitions.

**Local evidence:** `apps/api/src/user-activity.ts` retains slice-specific interfaces/services alongside the complete interface. `apps/api/src/http.ts` retains four application-layer aliases and optional slice-specific service inputs, explicitly labeled compatibility seams for package-local tests. Missing capabilities can become runtime defects through `unavailable`. Existing runtime tests already cover reactivation, corruption, timeout, stale fallback, identity isolation, and coalescing; this is not an absent test foundation.

**Recommendation:** if simplifying these files, migrate tests to the completed interface and remove historical slice scaffolding without weakening route assertions. For cache work, extend the existing deterministic suite with sequences of lookup, time advance, reactivation, upstream failure/recovery, and cleanup. Check saved timestamps across reactivation and subsequent memory-cache hits, not just immediately after reactivation. There is no need to adopt XState or a new test runner.

## Already strong: keep these

- **Contract ownership:** ADR 0004 makes Effect HttpApi/Schema authoritative; OpenAPI freshness and documentation builds are checked in CI.
- **Process-hop validation:** ADR 0006 deliberately schema-validates Durable Object RPC. Keep it rather than copying schemaless infrastructure conveniences.
- **Coordination:** per-normalized-user Durable Objects, persisted validated values, bounded stale fallback, and deterministic public-route tests already align with Rat Stack's reliability principles.
- **Privacy:** `apps/api/src/observability.ts` has a closed event algebra and fail-open sink; tests check safe logging fields. Improve signal meaning before adding analytics infrastructure.
- **Verification:** `.github/workflows/ci.yml` already runs formatting, lint, typechecks, tests, local Worker integration, OpenAPI freshness, and documentation checks. These local checks do not establish production behavior; deployment instructions live in `README.md`.

## Do not adopt wholesale

Do not import Rat Stack's package layout, multi-surface capability framework, MCP/code execution, XState, Foldkit, auth, analytics pipeline, durable queues, outbox, or deployment state machine merely for stack similarity. Kronik is a focused read-only HTTP product. Its current domain modules and composition roots are proportionate. Rat Stack's own [keep-or-cut guidance](https://ratstack.sh/skills/keep-or-cut) supports keeping less.

Retain explicit approval for Cloudflare mutations and credentialed operational checks. Rat Stack's [shipping guide](https://ratstack.sh/skills/ship) is useful for separating candidate checks, deployment, verification, and rollback evidence, not a reason to automate deployment in this task.

## Verification performed

Run from `apps/api`:

- `bun test test/github.test.ts`: 8 passed.
- `bun test test/runtime.test.ts`: 15 passed; manual live GitHub smoke test skipped.

These are existing-suite baselines, not reproductions or validation of the proposed improvements. The full verification suite and production checks were not run.

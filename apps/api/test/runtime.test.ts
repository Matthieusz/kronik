/* oxlint-disable effecttsgo/strict-effect-provide */

import { beforeEach, describe, expect, test } from "bun:test"
import { CommitPage, GitHubUsername, LatestCommit } from "@kronik/contract/model"
import { StreakRpcs } from "@kronik/contract/rpc"
import { ActivityState, activityRuntime } from "../src/activity-object.js"
import type { ActivityObjectState } from "../src/activity-object.js"
import { ActivityRpcClient } from "../src/activity-rpc.js"
import { Configuration } from "../src/config.js"
import { Cursor } from "../src/cursor.js"
import { GitHub } from "../src/github.js"
import { makeWebHandler } from "../src/http.js"
import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Schema, Scope } from "effect"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { UserActivity } from "../src/user-activity.js"

const httpClientResponseFromWeb = HttpClientResponse.fromWeb

const sha = "0123456789abcdef0123456789abcdef01234567"
const introducedSha = "fedcba9876543210fedcba9876543210fedcba98"
const fixedNow = Date.parse("2026-01-01T12:00:00Z")
let currentTime = fixedNow
let timeoutTimersEnabled = false
const configuration = Configuration.of({
  githubToken: Option.some(Redacted.make("kronik-test-github-token")),
  cursorSecret: Option.none<Redacted.Redacted>(),
  docsUrl: new URL("https://docs.example.test"),
  githubBaseUrl: new URL("https://api.github.test"),
  githubUserAgent: "kronik-runtime-test",
})

const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => currentTime,
  currentTimeMillis: Effect.sync(() => currentTime),
  monotonicTimeNanosUnsafe: () => BigInt(currentTime) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(currentTime) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(currentTime) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(currentTime) * 1_000_000n),
  sleep: (duration) =>
    timeoutTimersEnabled && Duration.toMillis(duration) >= 10_000 ? Effect.void : Effect.never,
}

const runtimeContext: RuntimeContext["Service"] = {
  Type: "test",
  id: "kronik-runtime-test",
  env: {},
  get: () => Effect.succeed(undefined),
  set: (id: string) => Effect.succeed(id),
}

const dateAt = (start: string, index: number): string =>
  new Date(Date.parse(`${start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10)

const contributionDays = Array.from({ length: 365 }, (_, index) => ({
  date: dateAt("2025-01-02", index),
  contributionCount: index >= 362 ? 1 : 0,
}))

interface FakeGitHub {
  readonly client: HttpClient.HttpClient
  readonly calls: {
    readonly total: () => number
    readonly searches: () => number
    readonly graphql: () => number
    readonly pages: () => ReadonlyArray<number>
    readonly snapshots: () => ReadonlyArray<string>
  }
  setMode(
    mode:
      | "normal"
      | "user-not-found"
      | "latest-not-found"
      | "upstream"
      | "rate"
      | "authorization"
      | "malformed-calendar"
      | "hang",
  ): void
  readonly introduceCommit: () => void
}

const makeFakeGitHub = (totalCount = 20): FakeGitHub => {
  let mode:
    | "normal"
    | "user-not-found"
    | "latest-not-found"
    | "upstream"
    | "rate"
    | "authorization"
    | "malformed-calendar"
    | "hang" = "normal"
  let total = 0
  let searches = 0
  let graphql = 0
  let introduced = false
  const pages: Array<number> = []
  const snapshots: Array<string> = []

  const client = HttpClient.make((request, url) => {
    total += 1
    const pathname = url.pathname
    if (mode === "hang") return Effect.never
    if (pathname.startsWith("/users/")) {
      if (mode === "user-not-found")
        return Effect.succeed(
          httpClientResponseFromWeb(
            request,
            new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
          ),
        )
      return Effect.succeed(
        httpClientResponseFromWeb(
          request,
          new Response(
            JSON.stringify({
              login: "MixedUser",
              html_url: "https://github.com/MixedUser",
              avatar_url: "https://avatars.githubusercontent.com/u/1",
            }),
            { status: 200 },
          ),
        ),
      )
    }
    if (pathname === "/search/commits") {
      searches += 1
      const page = Number.parseInt(url.searchParams.get("page") ?? "0", 10)
      pages.push(page)
      const query = url.searchParams.get("q") ?? ""
      const snapshot = query.match(/committer-date:<=([^ ]+)/)?.[1]
      if (snapshot !== undefined) snapshots.push(snapshot)
      if (mode === "latest-not-found")
        return Effect.succeed(
          httpClientResponseFromWeb(
            request,
            new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 }),
          ),
        )
      if (mode === "authorization" || mode === "upstream" || mode === "rate")
        return Effect.succeed(
          httpClientResponseFromWeb(
            request,
            new Response(JSON.stringify({ message: "failure" }), {
              status: mode === "authorization" ? 401 : mode === "rate" ? 429 : 503,
            }),
          ),
        )
      const newCommitVisible =
        introduced && (snapshot === undefined || snapshot >= "2026-01-01T11:30:00Z")
      const visibleSha = newCommitVisible && page === 1 ? introducedSha : sha
      return Effect.succeed(
        httpClientResponseFromWeb(
          request,
          new Response(
            JSON.stringify({
              total_count: totalCount,
              incomplete_results: false,
              items: [
                {
                  sha: visibleSha,
                  html_url: `https://github.com/owner/repo/commit/${visibleSha}`,
                  repository: {
                    full_name: "owner/repo",
                    html_url: "https://github.com/owner/repo",
                  },
                  author: { login: "MixedUser" },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      )
    }
    if (pathname === "/graphql") {
      graphql += 1
      const calendar =
        mode === "malformed-calendar" ? contributionDays.slice(0, 364) : contributionDays
      return Effect.succeed(
        httpClientResponseFromWeb(
          request,
          new Response(
            JSON.stringify({
              data: {
                user: {
                  contributionsCollection: {
                    contributionCalendar: {
                      weeks: Array.from({ length: 53 }, (_, index) => ({
                        contributionDays: calendar.slice(index * 7, index * 7 + 7),
                      })).filter((week) => week.contributionDays.length > 0),
                    },
                  },
                },
              },
            }),
            { status: 200 },
          ),
        ),
      )
    }
    if (pathname.endsWith("/languages"))
      return Effect.succeed(
        httpClientResponseFromWeb(
          request,
          new Response(JSON.stringify({ TypeScript: 100, JavaScript: 50 }), { status: 200 }),
        ),
      )
    const detailSha = url.pathname.endsWith(introducedSha) ? introducedSha : sha
    const committedAt =
      detailSha === introducedSha ? "2026-01-01T11:30:00Z" : "2026-01-01T11:00:00Z"
    return Effect.succeed(
      httpClientResponseFromWeb(
        request,
        new Response(
          JSON.stringify({
            sha: detailSha,
            html_url: `https://github.com/owner/repo/commit/${detailSha}`,
            repository: {
              full_name: "owner/repo",
              html_url: "https://github.com/owner/repo",
            },
            commit: {
              message: "Runtime integration commit\n\nDetails",
              author: { date: "2026-01-01T10:00:00Z" },
              committer: { date: committedAt },
            },
            stats: { additions: 3, deletions: 1 },
            parents: [
              { sha: detailSha, html_url: `https://github.com/owner/repo/commit/${detailSha}` },
            ],
          }),
          { status: 200 },
        ),
      ),
    )
  })

  return {
    client,
    calls: {
      total: () => total,
      searches: () => searches,
      graphql: () => graphql,
      pages: () => [...pages],
      snapshots: () => [...snapshots],
    },
    setMode(nextMode) {
      mode = nextMode
    },
    introduceCommit() {
      introduced = true
    },
  }
}

type TestStorage = ActivityObjectState["storage"] & {
  readonly seed: (key: string, value: unknown) => void
}

const makeStorage = (): TestStorage => {
  const values = new Map<string, unknown>()
  return {
    get: (key) => Effect.succeed(values.get(key)),
    put: (key, value) => Effect.sync(() => void values.set(key, value)),
    delete: (key) => Effect.sync(() => values.delete(key)),
    seed: (key, value) => void values.set(key, value),
  }
}

type ActivityClient = Effect.Success<ReturnType<ActivityRpcClient.ActivityNamespace["getByName"]>>

interface Coordinator {
  readonly client: ActivityClient
  readonly replace: Effect.Effect<void, never, Clock.Clock | Scope.Scope>
  readonly storage: TestStorage
}

const makeCoordinatorImpl = Effect.fn("RuntimeTest.makeCoordinator")(function* (
  objectName: string,
  fakeGitHub: FakeGitHub,
) {
  const storage = makeStorage()
  const runtime = yield* activityRuntime().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ActivityState, { objectName, storage }),
        GitHub.layerWithClient(fakeGitHub.client).pipe(
          Layer.provide(Layer.succeed(Configuration, configuration)),
        ),
        Cursor.layerWithSecret(Redacted.make("runtime-test-secret")).pipe(
          Layer.provide(Layer.succeed(Clock.Clock, clock)),
        ),
        Layer.succeed(Clock.Clock, clock),
        Layer.succeed(RuntimeContext, runtimeContext),
      ),
    ),
  )
  let server = runtime.pipe(Effect.provide(Layer.succeed(Clock.Clock, clock)))

  const transport = HttpClient.make((request) =>
    Effect.gen(function* () {
      const webRequest = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      const webResponse = yield* Effect.scoped(
        server.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(webRequest),
          ),
          Effect.map(HttpServerResponse.toWeb),
        ),
      ).pipe(Effect.orDie)
      return HttpClientResponse.fromWeb(request, webResponse)
    }),
  )
  const protocol = yield* RpcClient.makeProtocolHttp(
    HttpClient.mapRequest(transport, HttpClientRequest.prependUrl("http://local")),
  ).pipe(Effect.provide(RpcSerialization.layerNdjson))
  const client = yield* RpcClient.make(StreakRpcs).pipe(
    Effect.provide(Layer.succeed(RpcClient.Protocol, protocol)),
  )

  const replace = Effect.fn("RuntimeTest.reactivateCoordinator")(function* () {
    const nextRuntime = yield* activityRuntime().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ActivityState, { objectName, storage }),
          GitHub.layerWithClient(fakeGitHub.client).pipe(
            Layer.provide(Layer.succeed(Configuration, configuration)),
          ),
          Cursor.layerWithSecret(Redacted.make("runtime-test-secret")).pipe(
            Layer.provide(Layer.succeed(Clock.Clock, clock)),
          ),
          Layer.succeed(Clock.Clock, clock),
          Layer.succeed(RuntimeContext, runtimeContext),
        ),
      ),
    )
    server = nextRuntime.pipe(Effect.provide(Layer.succeed(Clock.Clock, clock)))
  })

  return {
    client,
    replace: replace().pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    storage,
  }
})

const makeCoordinator = (
  objectName: string,
  fakeGitHub: FakeGitHub,
): Effect.Effect<Coordinator, never, Clock.Clock | Scope.Scope> =>
  makeCoordinatorImpl(objectName, fakeGitHub).pipe(
    Effect.provide(Layer.succeed(Clock.Clock, clock)),
  )

const runJson = (response: Response): Effect.Effect<unknown> =>
  Effect.promise(() => response.json())

const makeWebWithNamespace = (namespace: ActivityRpcClient.ActivityNamespace) =>
  Effect.gen(function* () {
    const activityCache = yield* UserActivity.CacheAwareService
    return yield* makeWebHandler(new URL("https://docs.example.test"), {
      activityCacheService: activityCache,
    })
  }).pipe(Effect.provide(ActivityRpcClient.layerWithNamespace(namespace)))

const clockContext = Context.make(Clock.Clock, clock)
const runWithTestClock = <A>(effect: Effect.Effect<A, never, Clock.Clock>) => {
  // SAFETY: Effect's Clock.Reference uses a default-service identity that beta.103 does not subtract from `R`.
  // @ts-expect-error -- the supplied context provides the only remaining service at this test composition root.
  return Effect.runPromise(Effect.provideContext(effect, clockContext))
}

describe("complete local Worker/RPC/Durable Object runtime", () => {
  beforeEach(() => {
    currentTime = fixedNow
    timeoutTimersEnabled = false
  })
  test("proves one happy path for every public activity route", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const other = yield* makeCoordinator("otheruser", fakeGitHub)
          const coordinators = new Map([
            ["mixeduser", mixed],
            ["otheruser", other],
          ])
          const web = yield* makeWebWithNamespace({
            getByName: (name) => {
              const coordinator = coordinators.get(name)
              return coordinator === undefined
                ? Effect.die(`Missing local coordinator: ${name}`)
                : Effect.succeed(coordinator.client)
            },
          })
          const paths = ["commits/latest", "commits", "activity", "streak"]
          const responses = yield* Effect.forEach(paths, (path) =>
            Effect.promise(() =>
              web.handler(new Request(`https://api.example.test/v1/users/MixedUser/${path}`)),
            ),
          )
          const latestResponse = responses[0]
          if (latestResponse === undefined) return yield* Effect.die("Missing latest response")
          return {
            statuses: responses.map((response) => response.status),
            latest: yield* runJson(latestResponse),
            searches: fakeGitHub.calls.searches(),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result.statuses).toEqual([200, 200, 200, 200])
    expect(result.latest).toMatchObject({ user: { login: "MixedUser" } })
    expect(result.searches).toBeGreaterThan(0)
  })

  test("continues one-item pages through the 1,000-result boundary", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub(1_000)
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const web = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(mixed.client),
          })
          let response = yield* Effect.promise(() =>
            web.handler(
              new Request("https://api.example.test/v1/users/MixedUser/commits?limit=100"),
            ),
          )
          for (let pageNumber = 1; pageNumber <= 9; pageNumber += 1) {
            const page = yield* Schema.decodeUnknownEffect(CommitPage)(
              yield* runJson(response),
            ).pipe(Effect.orDie)
            const next = page.next
            if (next === null) return yield* Effect.die("The test page must have a cursor")
            response = yield* Effect.promise(() =>
              web.handler(
                new Request(
                  `https://api.example.test/v1/users/MixedUser/commits?cursor=${encodeURIComponent(next)}`,
                ),
              ),
            )
          }
          const finalPage = yield* Schema.decodeUnknownEffect(CommitPage)(
            yield* runJson(response),
          ).pipe(Effect.orDie)
          return { next: finalPage.next, pages: fakeGitHub.calls.pages() }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result.next).toBeNull()
    expect(result.pages).toEqual(Array.from({ length: 10 }, (_, index) => index + 1))
  })

  test("navigates backward and preserves one snapshot across pages", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub(20)
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const web = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(mixed.client),
          })
          const first = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits?limit=1")),
          )
          const firstPage = yield* Schema.decodeUnknownEffect(CommitPage)(
            yield* runJson(first),
          ).pipe(Effect.orDie)
          const next = firstPage.next
          if (next === null) return yield* Effect.die("The first page must have a next cursor")
          const second = yield* Effect.promise(() =>
            web.handler(
              new Request(
                `https://api.example.test/v1/users/MixedUser/commits?cursor=${encodeURIComponent(next)}`,
              ),
            ),
          )
          const secondPage = yield* Schema.decodeUnknownEffect(CommitPage)(
            yield* runJson(second),
          ).pipe(Effect.orDie)
          const previous = secondPage.previous
          if (previous === null)
            return yield* Effect.die("The second page must have a previous cursor")
          const back = yield* Effect.promise(() =>
            web.handler(
              new Request(
                `https://api.example.test/v1/users/MixedUser/commits?cursor=${encodeURIComponent(previous)}`,
              ),
            ),
          )
          const backPage = yield* Schema.decodeUnknownEffect(CommitPage)(yield* runJson(back)).pipe(
            Effect.orDie,
          )
          return {
            firstItems: firstPage.items,
            backItems: backPage.items,
            pages: fakeGitHub.calls.pages(),
            snapshots: fakeGitHub.calls.snapshots(),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result.backItems).toEqual(result.firstItems)
    expect(result.pages).toEqual([1, 2])
    expect(result.snapshots).toHaveLength(2)
    expect(new Set(result.snapshots).size).toBe(1)
  })

  test("coalesces identical misses while different object identities progress independently", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const other = yield* makeCoordinator("otheruser", fakeGitHub)
          const namespace: ActivityRpcClient.ActivityNamespace = {
            getByName: (name) => Effect.succeed(name === "mixeduser" ? mixed.client : other.client),
          }
          const web = yield* makeWebWithNamespace(namespace)
          const responses = yield* Effect.promise(() =>
            Promise.all([
              web.handler(
                new Request("https://api.example.test/v1/users/MixedUser/commits/latest"),
              ),
              web.handler(
                new Request("https://api.example.test/v1/users/mixeduser/commits/latest"),
              ),
              web.handler(
                new Request("https://api.example.test/v1/users/OtherUser/commits/latest"),
              ),
            ]),
          )
          return {
            statuses: responses.map((response) => response.status),
            searches: fakeGitHub.calls.searches(),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result.statuses).toEqual([200, 200, 200])
    expect(result.searches).toBe(2)
  })

  test("reactivates from schema-decoded persistence and uses stale success only for upstream failure", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const namespace: ActivityRpcClient.ActivityNamespace = {
            getByName: () => Effect.succeed(mixed.client),
          }
          const web = yield* makeWebWithNamespace(namespace)
          const first = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          currentTime += 60_001
          yield* mixed.replace
          fakeGitHub.setMode("rate")
          const stale = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          return {
            first: first.status,
            stale: stale.status,
            cache: stale.headers.get("x-kronik-cache"),
            warning: stale.headers.get("warning"),
            body: yield* runJson(stale),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result.first).toBe(200)
    expect(result.stale).toBe(200)
    expect(result.cache).toBe("stale")
    expect(result.warning).toBe('110 - "Response is stale"')
    expect(result.body).toMatchObject({ user: { login: "MixedUser" } })
  })

  test("returns stale values when every lookup reaches the total timeout", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const namespace: ActivityRpcClient.ActivityNamespace = {
            getByName: () => Effect.succeed(mixed.client),
          }
          const web = yield* makeWebWithNamespace(namespace)
          const initialPaths = ["commits/latest", "commits", "activity", "streak"] as const
          const initialResponses = yield* Effect.forEach(initialPaths, (path) =>
            Effect.promise(() =>
              web.handler(new Request(`https://api.example.test/v1/users/MixedUser/${path}`)),
            ),
          )
          const firstPageResponse = initialResponses[1]
          if (firstPageResponse === undefined) return yield* Effect.die("Missing initial page")
          const firstPage = yield* Schema.decodeUnknownEffect(CommitPage)(
            yield* runJson(firstPageResponse),
          ).pipe(Effect.orDie)
          const pageCursor = firstPage.next
          if (pageCursor === null) return yield* Effect.die("The test page must have a cursor")
          yield* Effect.promise(() =>
            web.handler(
              new Request(
                `https://api.example.test/v1/users/MixedUser/commits?cursor=${encodeURIComponent(pageCursor)}`,
              ),
            ),
          )
          currentTime += 300_001
          yield* mixed.replace
          timeoutTimersEnabled = true
          fakeGitHub.setMode("hang")
          const stalePaths = [
            "commits/latest",
            `commits?cursor=${encodeURIComponent(pageCursor)}`,
            "activity",
            "streak",
          ] as const
          const responses = yield* Effect.promise(() =>
            Promise.all(
              stalePaths.map((path) =>
                web.handler(new Request(`https://api.example.test/v1/users/MixedUser/${path}`)),
              ),
            ),
          )
          return responses.map((response) => ({
            status: response.status,
            cache: response.headers.get("x-kronik-cache"),
            warning: response.headers.get("warning"),
            age: response.headers.get("age"),
            cacheControl: response.headers.get("cache-control"),
            contentType: response.headers.get("content-type"),
          }))
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result).toEqual([
      {
        status: 200,
        cache: "stale",
        warning: '110 - "Response is stale"',
        age: "0",
        cacheControl: "public, max-age=60, stale-while-revalidate=3600",
        contentType: "application/json",
      },
      {
        status: 200,
        cache: "stale",
        warning: '110 - "Response is stale"',
        age: "0",
        cacheControl: "public, max-age=60, stale-while-revalidate=3600",
        contentType: "application/json",
      },
      {
        status: 200,
        cache: "stale",
        warning: '110 - "Response is stale"',
        age: "0",
        cacheControl: "public, max-age=300, stale-while-revalidate=3600",
        contentType: "application/json",
      },
      {
        status: 200,
        cache: "stale",
        warning: '110 - "Response is stale"',
        age: "0",
        cacheControl: "public, max-age=300, stale-while-revalidate=3600",
        contentType: "application/json",
      },
    ])
  })

  test("does not negatively cache a valid user without a latest commit", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          fakeGitHub.setMode("latest-not-found")
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const web = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(mixed.client),
          })
          const first = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          const second = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          return {
            first: first.status,
            second: second.status,
            searches: fakeGitHub.calls.searches(),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result).toEqual({ first: 404, second: 404, searches: 2 })
  })

  test("discards malformed persistence and does not cache transient failures", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          mixed.storage.seed("latest-commit-v1", { malformed: true })
          const web = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(mixed.client),
          })
          const recovered = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          fakeGitHub.setMode("rate")
          mixed.storage.seed("latest-commit-v1", { malformed: true })
          yield* mixed.replace
          const limited = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          fakeGitHub.setMode("normal")
          yield* mixed.replace
          const retried = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          return {
            recovered: recovered.status,
            limited: limited.status,
            retried: retried.status,
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result).toEqual({ recovered: 200, limited: 429, retried: 200 })
  })

  test("does not use stale success for invalid cursors or authorization failures", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const namespace: ActivityRpcClient.ActivityNamespace = {
            getByName: () => Effect.succeed(mixed.client),
          }
          const web = yield* makeWebWithNamespace(namespace)
          const invalidCursor = yield* Effect.promise(() =>
            web.handler(
              new Request(
                "https://api.example.test/v1/users/MixedUser/commits?cursor=not-a-valid-cursor",
              ),
            ),
          )
          yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          currentTime += 60_001
          yield* mixed.replace
          fakeGitHub.setMode("authorization")
          const authorization = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          return {
            invalidCursor: { status: invalidCursor.status, body: yield* runJson(invalidCursor) },
            authorization: { status: authorization.status, body: yield* runJson(authorization) },
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result.invalidCursor.status).toBe(400)
    expect(result.authorization.status).toBe(502)
  })

  test("keeps the public commit snapshot stable after a new commit appears", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const web = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(mixed.client),
          })
          const first = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits?limit=1")),
          )
          const firstPage = yield* Schema.decodeUnknownEffect(CommitPage)(
            yield* runJson(first),
          ).pipe(Effect.orDie)
          const cursor = firstPage.next
          if (cursor === null) return yield* Effect.die("The first page must have a cursor")
          fakeGitHub.introduceCommit()
          const continuation = yield* Effect.promise(() =>
            web.handler(
              new Request(
                `https://api.example.test/v1/users/MixedUser/commits?cursor=${encodeURIComponent(cursor)}`,
              ),
            ),
          )
          const continuationPage = yield* Schema.decodeUnknownEffect(CommitPage)(
            yield* runJson(continuation),
          ).pipe(Effect.orDie)
          currentTime += 1_000
          const newSnapshot = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits?limit=1")),
          )
          const newSnapshotPage = yield* Schema.decodeUnknownEffect(CommitPage)(
            yield* runJson(newSnapshot),
          ).pipe(Effect.orDie)
          return {
            first: firstPage.items[0]?.sha,
            continuation: continuationPage.items[0]?.sha,
            newSnapshot: newSnapshotPage.items[0]?.sha,
            snapshots: fakeGitHub.calls.snapshots(),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(String(result.first)).toBe(sha)
    expect(String(result.continuation)).toBe(sha)
    expect(String(result.newSnapshot)).toBe(introducedSha)
    expect(result.snapshots).toEqual([
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T12:00:01.000Z",
    ])
  })

  test("coalesces summary and streak public misses independently", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const web = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(mixed.client),
          })
          const responses = yield* Effect.promise(() =>
            Promise.all([
              web.handler(new Request("https://api.example.test/v1/users/MixedUser/activity")),
              web.handler(new Request("https://api.example.test/v1/users/mixeduser/activity")),
              web.handler(new Request("https://api.example.test/v1/users/MixedUser/streak")),
              web.handler(new Request("https://api.example.test/v1/users/mixeduser/streak")),
            ]),
          )
          return {
            statuses: responses.map((response) => response.status),
            searches: fakeGitHub.calls.searches(),
            graphql: fakeGitHub.calls.graphql(),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result).toEqual({ statuses: [200, 200, 200, 200], searches: 1, graphql: 1 })
  })

  test("rejects invalid Activity Windows through the public route", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const web = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(mixed.client),
          })
          const paths = [
            "?from=2026-01-01",
            "?from=2026-01-10&to=2026-01-01",
            "?from=2025-01-01&to=2025-04-01",
          ]
          const responses = yield* Effect.forEach(paths, (query) =>
            Effect.promise(() =>
              web.handler(
                new Request(`https://api.example.test/v1/users/MixedUser/activity${query}`),
              ),
            ),
          )
          return {
            statuses: responses.map((response) => response.status),
            searches: fakeGitHub.calls.searches(),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result).toEqual({ statuses: [400, 400, 400], searches: 0 })
  })

  test("projects malformed contribution calendars as public upstream failures", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          fakeGitHub.setMode("malformed-calendar")
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const web = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(mixed.client),
          })
          const response = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/streak")),
          )
          return { status: response.status, body: yield* runJson(response) }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({
      type: "https://kronik.dev/problems/upstream-failure",
      detail: "GitHub returned an incomplete contribution calendar",
    })
  })

  test("applies the public unknown-user negative TTL", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          const fakeGitHub = makeFakeGitHub()
          fakeGitHub.setMode("user-not-found")
          const mixed = yield* makeCoordinator("mixeduser", fakeGitHub)
          const web = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(mixed.client),
          })
          const first = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          currentTime += 59_999
          yield* mixed.replace
          const withinTtl = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          currentTime += 2
          yield* mixed.replace
          const afterTtl = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits/latest")),
          )
          return {
            statuses: [first.status, withinTtl.status, afterTtl.status],
            upstreamRequests: fakeGitHub.calls.total(),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result).toEqual({ statuses: [404, 404, 404], upstreamRequests: 2 })
  })

  test("verifies freshness for latest, commits, summary, and streak routes", async () => {
    const result = await runWithTestClock(
      Effect.scoped(
        Effect.gen(function* () {
          currentTime = fixedNow
          const latestGitHub = makeFakeGitHub()
          const latest = yield* makeCoordinator("mixeduser", latestGitHub)
          const latestWeb = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(latest.client),
          })
          yield* Effect.promise(() =>
            latestWeb.handler(
              new Request("https://api.example.test/v1/users/MixedUser/commits/latest"),
            ),
          )
          yield* Effect.promise(() =>
            latestWeb.handler(
              new Request("https://api.example.test/v1/users/MixedUser/commits/latest"),
            ),
          )
          currentTime += 59_999
          yield* latest.replace
          yield* Effect.promise(() =>
            latestWeb.handler(
              new Request("https://api.example.test/v1/users/MixedUser/commits/latest"),
            ),
          )
          currentTime += 2
          yield* latest.replace
          yield* Effect.promise(() =>
            latestWeb.handler(
              new Request("https://api.example.test/v1/users/MixedUser/commits/latest"),
            ),
          )

          currentTime = fixedNow
          const commitsGitHub = makeFakeGitHub()
          const commits = yield* makeCoordinator("mixeduser", commitsGitHub)
          const commitsWeb = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(commits.client),
          })
          const firstPageResponse = yield* Effect.promise(() =>
            commitsWeb.handler(
              new Request("https://api.example.test/v1/users/MixedUser/commits?limit=1"),
            ),
          )
          const firstPage = yield* Schema.decodeUnknownEffect(CommitPage)(
            yield* runJson(firstPageResponse),
          ).pipe(Effect.orDie)
          const cursor = firstPage.next
          if (cursor === null) return yield* Effect.die("The first page must have a cursor")
          const continuationUrl = `https://api.example.test/v1/users/MixedUser/commits?cursor=${encodeURIComponent(cursor)}`
          yield* Effect.promise(() => commitsWeb.handler(new Request(continuationUrl)))
          yield* Effect.promise(() => commitsWeb.handler(new Request(continuationUrl)))
          currentTime += 59_999
          yield* commits.replace
          yield* Effect.promise(() => commitsWeb.handler(new Request(continuationUrl)))
          currentTime += 2
          yield* commits.replace
          yield* Effect.promise(() => commitsWeb.handler(new Request(continuationUrl)))

          currentTime = fixedNow
          const summaryGitHub = makeFakeGitHub()
          const summary = yield* makeCoordinator("mixeduser", summaryGitHub)
          const summaryWeb = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(summary.client),
          })
          const summaryUrl = "https://api.example.test/v1/users/MixedUser/activity"
          yield* Effect.promise(() => summaryWeb.handler(new Request(summaryUrl)))
          yield* Effect.promise(() => summaryWeb.handler(new Request(summaryUrl)))
          currentTime += 299_999
          yield* summary.replace
          yield* Effect.promise(() => summaryWeb.handler(new Request(summaryUrl)))
          currentTime += 2
          yield* summary.replace
          yield* Effect.promise(() => summaryWeb.handler(new Request(summaryUrl)))

          currentTime = fixedNow
          const streakGitHub = makeFakeGitHub()
          const streak = yield* makeCoordinator("mixeduser", streakGitHub)
          const streakWeb = yield* makeWebWithNamespace({
            getByName: () => Effect.succeed(streak.client),
          })
          const streakUrl = "https://api.example.test/v1/users/MixedUser/streak"
          yield* Effect.promise(() => streakWeb.handler(new Request(streakUrl)))
          yield* Effect.promise(() => streakWeb.handler(new Request(streakUrl)))
          currentTime += 299_999
          yield* streak.replace
          yield* Effect.promise(() => streakWeb.handler(new Request(streakUrl)))
          currentTime += 2
          yield* streak.replace
          yield* Effect.promise(() => streakWeb.handler(new Request(streakUrl)))

          return {
            latest: latestGitHub.calls.searches(),
            commits: commitsGitHub.calls.searches(),
            summary: summaryGitHub.calls.searches(),
            streak: streakGitHub.calls.graphql(),
          }
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result).toEqual({ latest: 2, commits: 3, summary: 2, streak: 2 })
  })
})

test.skipIf(Bun.env.KRONIK_LIVE_GITHUB !== "1" || Bun.env.GITHUB_TOKEN === undefined)(
  "manual GitHub smoke test",
  async () => {
    const token = Bun.env.GITHUB_TOKEN
    if (token === undefined) return
    const username = Schema.decodeUnknownSync(GitHubUsername)(
      Bun.env.GITHUB_SMOKE_USERNAME ?? "octocat",
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* GitHub.Service
        return yield* github.latestCommit(username)
      }).pipe(
        Effect.provide(
          GitHub.layer.pipe(
            Layer.provide(
              Layer.succeed(Configuration, {
                ...configuration,
                githubToken: Option.some(Redacted.make(token)),
              }),
            ),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      ),
    )
    expect(Schema.is(LatestCommit)(result)).toBe(true)
  },
)

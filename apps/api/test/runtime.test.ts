import { beforeEach, describe, expect, test } from "bun:test"
import { CommitPage, GitHubUsername, LatestCommit } from "@kronik/contract/model"
import { StreakRpcs } from "@kronik/contract/rpc"
import { ActivityState, activityRuntime } from "../src/activity-object.js"
import type { ActivityObjectState } from "../src/activity-object.js"
import * as ActivityRpcClient from "../src/activity-rpc.js"
import { Configuration } from "../src/config.js"
import { Cursor } from "../src/cursor.js"
import { GitHub } from "../src/github.js"
import { makeWebHandler } from "../src/http.js"
import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Schema, Scope } from "effect"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import {
  HttpClient,
  make as makeHttpClient,
  mapRequest as mapHttpClientRequest,
} from "effect/unstable/http/HttpClient"
import { fromWeb as httpClientResponseFromWeb } from "effect/unstable/http/HttpClientResponse"
import {
  HttpServerRequest,
  fromWeb as httpServerRequestFromWeb,
} from "effect/unstable/http/HttpServerRequest"
import { toWeb as httpServerResponseToWeb } from "effect/unstable/http/HttpServerResponse"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import {
  prependUrl as prependHttpClientUrl,
  toWeb as httpClientRequestToWeb,
} from "effect/unstable/http/HttpClientRequest"
import { UserActivity as UserActivityService } from "../src/user-activity.js"

const sha = "0123456789abcdef0123456789abcdef01234567"
const fixedNow = Date.parse("2026-01-01T12:00:00Z")
let currentTime = fixedNow
let timeoutTimersEnabled = false
const configuration = Configuration.of({
  githubToken: Redacted.make("kronik-test-github-token"),
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
  readonly client: HttpClient
  readonly calls: { readonly total: () => number; readonly searches: () => number }
  setMode(
    mode:
      | "normal"
      | "user-not-found"
      | "latest-not-found"
      | "upstream"
      | "rate"
      | "authorization"
      | "hang",
  ): void
}

const makeFakeGitHub = (totalCount = 20): FakeGitHub => {
  let mode:
    | "normal"
    | "user-not-found"
    | "latest-not-found"
    | "upstream"
    | "rate"
    | "authorization"
    | "hang" = "normal"
  let total = 0
  let searches = 0

  const client = makeHttpClient((request, url) => {
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
      return Effect.succeed(
        httpClientResponseFromWeb(
          request,
          new Response(
            JSON.stringify({
              total_count: totalCount,
              incomplete_results: false,
              items: [
                {
                  sha,
                  html_url: `https://github.com/owner/repo/commit/${sha}`,
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
    if (pathname === "/graphql")
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
                        contributionDays: contributionDays.slice(index * 7, index * 7 + 7),
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
    if (pathname.endsWith("/languages"))
      return Effect.succeed(
        httpClientResponseFromWeb(
          request,
          new Response(JSON.stringify({ TypeScript: 100, JavaScript: 50 }), { status: 200 }),
        ),
      )
    return Effect.succeed(
      httpClientResponseFromWeb(
        request,
        new Response(
          JSON.stringify({
            sha,
            html_url: `https://github.com/owner/repo/commit/${sha}`,
            repository: {
              full_name: "owner/repo",
              html_url: "https://github.com/owner/repo",
            },
            commit: {
              message: "Runtime integration commit\n\nDetails",
              author: { date: "2026-01-01T10:00:00Z" },
              committer: { date: "2026-01-01T11:00:00Z" },
            },
            stats: { additions: 3, deletions: 1 },
            parents: [{ sha, html_url: `https://github.com/owner/repo/commit/${sha}` }],
          }),
          { status: 200 },
        ),
      ),
    )
  })

  return {
    client,
    calls: { total: () => total, searches: () => searches },
    setMode(nextMode) {
      mode = nextMode
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

  const transport = makeHttpClient((request) =>
    Effect.gen(function* () {
      const webRequest = yield* httpClientRequestToWeb(request).pipe(Effect.orDie)
      const webResponse = yield* Effect.scoped(
        server.pipe(
          Effect.provideService(HttpServerRequest, httpServerRequestFromWeb(webRequest)),
          Effect.map(httpServerResponseToWeb),
        ),
      ).pipe(Effect.orDie)
      return httpClientResponseFromWeb(request, webResponse)
    }),
  )
  const protocol = yield* RpcClient.makeProtocolHttp(
    mapHttpClientRequest(transport, prependHttpClientUrl("http://local")),
  ).pipe(Effect.provide(RpcSerialization.layerJson))
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
    const activityCache = yield* UserActivityService.CacheAwareService
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
          return {
            statuses: responses.map((response) => response.status),
            latest: yield* runJson(responses[0]!),
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
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/commits?limit=1")),
          )
          for (let pageNumber = 1; pageNumber < 100; pageNumber += 1) {
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
          return finalPage.next
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result).not.toBeNull()
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
          }))
        }),
      ).pipe(Effect.provide(Layer.succeed(Clock.Clock, clock))),
    )

    expect(result).toEqual([
      { status: 200, cache: "stale", warning: '110 - "Response is stale"' },
      { status: 200, cache: "stale", warning: '110 - "Response is stale"' },
      { status: 200, cache: "stale", warning: '110 - "Response is stale"' },
      { status: 200, cache: "stale", warning: '110 - "Response is stale"' },
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
                githubToken: Redacted.make(token),
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

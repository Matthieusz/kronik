import {
  RateLimit,
  RateLimitBinding,
  type RateLimitClient,
  WorkerConfigProvider,
  Worker,
} from "alchemy/Cloudflare"
import { ConfigProvider, Duration, Effect, Layer, Option } from "effect"
import { Clock } from "effect"
import { layer } from "effect/unstable/http/FetchHttpClient"
import { ActivityObject, ActivityObjectLive } from "./activity-object.js"
import { activityRpcLayer } from "./activity-rpc.js"
import { Configuration, configurationLayer } from "./config.js"
import { Cursor } from "./cursor.js"
import { GitHub } from "./github.js"
import { cloudflareEdgeCache, makeHttpEffect, makePublicResponse } from "./http.js"
import { Observability } from "./observability.js"
import { fromWeb } from "effect/unstable/http/HttpServerResponse"
import { HttpServerRequest, toWeb } from "effect/unstable/http/HttpServerRequest"
import { UserActivity } from "./user-activity.js"

/* SAFETY: the Cloudflare generated RateLimit client exposes unknown channels; this adapter catches all failures and parses its result. */
/* oxlint-disable effecttsgo/any-unknown-in-error-context */

const workerConfiguration = Layer.unwrap(
  WorkerConfigProvider().pipe(Effect.map(ConfigProvider.layer)),
)

const isRateLimitSuccess = (value: unknown): boolean =>
  typeof value === "object" && value !== null && Reflect.get(value, "success") === true

const runtimeClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  monotonicTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  sleep: (duration) =>
    Effect.promise(
      () => new Promise<void>((resolve) => setTimeout(resolve, Duration.toMillis(duration))),
    ),
}

const configurationRuntime = configurationLayer.pipe(Layer.provide(workerConfiguration))
const runtimeClockLayer = Layer.succeed(Clock.Clock, runtimeClock)
const githubRuntime = GitHub.layer.pipe(Layer.provide(layer), Layer.provide(configurationRuntime))
const cursorRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const configuration = yield* Configuration
    return Option.match(configuration.cursorSecret, {
      onNone: () =>
        Layer.effectDiscard(Effect.die(new Error("CURSOR_SECRET is required for activity routes"))),
      onSome: (secret) => Cursor.layerWithSecret(secret).pipe(Layer.provide(runtimeClockLayer)),
    })
  }),
).pipe(Layer.provide(configurationRuntime))
const activityObjectRuntime = ActivityObjectLive.pipe(
  Layer.provide(Layer.mergeAll(githubRuntime, cursorRuntime, runtimeClockLayer)),
)
const applicationRuntime = activityRpcLayer.pipe(Layer.provide(activityObjectRuntime))

export class KronikApi extends Worker<KronikApi, {}, ActivityObject>()("KronikApi") {}

/** Apply the same initialized Worker edge policy used by the Cloudflare entrypoint. */
export const makeWorkerResponse = (
  request: Request,
  httpEffect: Parameters<typeof makePublicResponse>[1],
  allowed: boolean,
  observability: Observability.Sink = Observability.consoleSink,
): Promise<Response> =>
  makePublicResponse(request, httpEffect, {
    rateLimiter: { check: async () => allowed },
    edgeCache: cloudflareEdgeCache,
    observability,
  })

export default KronikApi.make(
  {
    main: import.meta.url,
    env: {
      KRONIK_PUBLIC_RATE_LIMIT: RateLimit("KRONIK_PUBLIC_RATE_LIMIT", {
        namespaceId: "kronik-public-v1",
        simple: { limit: 60, period: 60 },
      }),
    },
  },
  Effect.gen(function* () {
    const configuration = yield* Configuration
    const activityCache = yield* UserActivity.CacheAwareService
    const rateLimit: RateLimitClient = yield* RateLimit("KRONIK_PUBLIC_RATE_LIMIT", {
      namespaceId: "kronik-public-v1",
      simple: { limit: 60, period: 60 },
    })
    const fetch = yield* makeHttpEffect(configuration.docsUrl, {
      activityCacheService: activityCache,
    })

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest
        const ip = request.headers["cf-connecting-ip"] ?? "unknown"
        const decision = yield* Effect.catchCause(
          rateLimit.limit({ key: ip }).pipe(Effect.map(isRateLimitSuccess)),
          () => Effect.succeed(true),
        )
        const webRequest = yield* toWeb(request)
        const webResponse = yield* Effect.promise(() =>
          makeWorkerResponse(webRequest, fetch, decision),
        )
        return fromWeb(webResponse)
      }),
    }
  }).pipe(
    Effect.provide(Layer.mergeAll(applicationRuntime, configurationRuntime, RateLimitBinding)),
  ),
)

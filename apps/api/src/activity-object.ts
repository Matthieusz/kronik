// Effect's HTTP/RPC adapters remain unstable in v4; exact versions and integration tests guard upgrades.
/* oxlint-disable effecttsgo/unstable-api-usage */

export * as ActivityObjectModule from "./activity-object.js"

import { ApiError } from "@kronik/contract/errors"
import {
  ActivityWindow,
  CommitPage,
  GitHubUsername,
  IsoDate,
  IsoTimestamp,
} from "@kronik/contract/model"
import { Rpcs } from "@kronik/contract/rpc"
import { DurableObjectState, RpcDurableObject } from "@alchemy.run/cloudflare"
import { Clock, Context, Effect, Layer, Match, Result, Schema, Scope } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { ActivityCache } from "./activity-cache.js"
import type { ActivityStorage } from "./activity-cache.js"
import { ActivityDomain } from "./activity-domain.js"
import { CommitDomain } from "./commit-domain.js"
import { Cursor } from "./cursor.js"
import { GitHub } from "./github.js"
import { StreakDomain } from "./streak-domain.js"

export type { ActivityStorage } from "./activity-cache.js"

/** The state needed by the activity coordinator, independent of Cloudflare's constructor. */
export interface ActivityObjectState {
  /** The Durable Object name, used to bind RPC payloads to the instance. */
  readonly objectName: string | undefined
  /** The Durable Object's persistent storage. */
  readonly storage: ActivityStorage
}

/** Testable state seam for the activity coordinator. */
export class ActivityState extends Context.Service<ActivityState, ActivityObjectState>()(
  "@kronik/api/ActivityState",
) {}

const DefaultPageSize = 10

const SearchBoundary = 1_000

const PageRequest = Schema.Struct({
  username: GitHubUsername,
  snapshot: IsoTimestamp,
  pageSize: Schema.Number,
  position: Schema.Number,
})

type PageRequest = typeof PageRequest.Type

const ActivityRequest = Schema.Struct({
  username: GitHubUsername,
  from: IsoDate,
  to: IsoDate,
})

const StreakRequest = Schema.Struct({
  username: GitHubUsername,
  from: IsoDate,
  to: IsoDate,
})

const invalidRequest = (detail: string) =>
  new ApiError.InvalidRequest({
    type: "https://kronik.dev/problems/invalid-request",
    title: "Invalid request",
    detail,
    instance: "urn:kronik:activity:request",
    status: 400,
  })

const upstreamFailure = (detail: string) =>
  new ApiError.UpstreamFailure({
    type: "https://kronik.dev/problems/upstream-failure",
    title: "GitHub unavailable",
    detail,
    instance: "urn:kronik:activity:commit-page",
    status: 502,
  })

const normalizeActivityError = (error: ApiError.DomainErrors): ApiError.DomainErrors => {
  if (error instanceof ApiError.InvalidRequest) return error

  if (error instanceof ApiError.InvalidCursor) return error

  if (error instanceof ApiError.UserNotFound) return error

  if (error instanceof ApiError.LatestCommitNotFound) return error

  if (error instanceof ApiError.RateLimited) return error

  if (error instanceof ApiError.ServiceUnavailable) return error

  if (error instanceof ApiError.UpstreamFailure) return error

  return new ApiError.UpstreamFailure({
    type: "https://kronik.dev/problems/upstream-failure",
    title: "Activity coordinator failure",
    detail: "Kronik could not complete the activity lookup",
    instance: "urn:kronik:activity:internal",
    status: 502,
  })
}

/** Schema-validated Durable Object keyed by normalized requested username. */
export class ActivityObject extends RpcDurableObject<ActivityObject>()("KronikActivity", {
  schema: Rpcs,
}) {}

const pageKey = (request: PageRequest): string => JSON.stringify(request)

const decodeActivityKey = (key: string) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ActivityRequest))(key).pipe(
      Effect.mapError(() => upstreamFailure("Kronik produced an invalid activity cache key")),
    )
  })

const decodeStreakKey = (key: string) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StreakRequest))(key).pipe(
      Effect.mapError(() => upstreamFailure("Kronik produced an invalid streak cache key")),
    )
  })

const decodePageKey = (key: string) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PageRequest))(key).pipe(
      Effect.mapError(() => upstreamFailure("Kronik produced an invalid page cache key")),
    )
  })

/** Testable RPC implementation with persistent records and scoped lookup deduplication. */
export const activityRuntime = Effect.fn("ActivityObject.runtime")(function* () {
  const state = yield* ActivityState
  const github = yield* GitHub.Service
  const cursor = yield* Cursor.Service

  const cache = yield* ActivityCache.make(state.storage, {
    latestCommit: (username) => github.latestCommit(username),
    commits: Effect.fn("ActivityObject.loadCommitPage")(function* (key) {
      const request = yield* decodePageKey(key)
      const evidence = yield* github.commits(request)

      return yield* buildCommitPage(cursor, evidence, request)
    }),
    summarize: Effect.fn("ActivityObject.loadActivitySummary")(function* (key) {
      const request = yield* decodeActivityKey(key)
      const evidence = yield* github.activity(request)

      return yield* buildActivitySummary(request, evidence)
    }),
    streak: Effect.fn("ActivityObject.loadContributionStreak")(function* (key) {
      const request = yield* decodeStreakKey(key)
      const evidence = yield* github.streak(request)

      return yield* buildContributionStreak(request, evidence)
    }),
  })

  const handlers = Rpcs.toLayer({
    latestCommit: (payload) =>
      Effect.gen(function* () {
        const objectName = state.objectName
        const requestedName = payload.username.toLowerCase()

        if (objectName !== undefined && objectName.toLowerCase() !== requestedName) {
          return yield* Effect.fail(
            invalidRequest("The RPC username does not match the Durable Object identity"),
          )
        }

        const normalizedUsername = yield* Schema.decodeUnknownEffect(GitHubUsername)(
          requestedName,
        ).pipe(Effect.mapError(() => invalidRequest("The RPC username is not valid")))

        return yield* cache
          .latestCommit(normalizedUsername)
          .pipe(Effect.mapError(normalizeActivityError))
      }),
    commits: (payload) =>
      Effect.gen(function* () {
        const objectName = state.objectName
        const requestedName = payload.username.toLowerCase()

        if (objectName !== undefined && objectName.toLowerCase() !== requestedName) {
          return yield* Effect.fail(
            invalidRequest("The RPC username does not match the Durable Object identity"),
          )
        }

        const normalizedUsername = yield* Schema.decodeUnknownEffect(GitHubUsername)(
          requestedName,
        ).pipe(Effect.mapError(() => invalidRequest("The RPC username is not valid")))

        const cursorPayload =
          payload.cursor === undefined
            ? yield* cursor.initial(normalizedUsername, payload.limit ?? DefaultPageSize)
            : yield* cursor.decode(payload.cursor, normalizedUsername)

        if (payload.cursor !== undefined && payload.limit !== undefined) {
          return yield* Effect.fail(invalidRequest("A cursor cannot be combined with a limit"))
        }

        if (cursorPayload.position * cursorPayload.pageSize > SearchBoundary) {
          return yield* Effect.fail(
            new ApiError.InvalidCursor({
              type: "https://kronik.dev/problems/invalid-cursor",
              title: "Invalid cursor",
              detail: "The supplied pagination cursor is beyond GitHub's searchable boundary",
              instance: "urn:kronik:activity:cursor-boundary",
              status: 400,
            }),
          )
        }

        const request: PageRequest = {
          username: normalizedUsername,
          snapshot: cursorPayload.snapshot,
          pageSize: cursorPayload.pageSize,
          position: cursorPayload.position,
        }

        return yield* cache.commits(pageKey(request)).pipe(Effect.mapError(normalizeActivityError))
      }),
    summary: (payload) =>
      Effect.gen(function* () {
        const objectName = state.objectName
        const requestedName = payload.username.toLowerCase()

        if (objectName !== undefined && objectName.toLowerCase() !== requestedName) {
          return yield* Effect.fail(
            invalidRequest("The RPC username does not match the Durable Object identity"),
          )
        }

        const normalizedUsername = yield* Schema.decodeUnknownEffect(GitHubUsername)(
          requestedName,
        ).pipe(Effect.mapError(() => invalidRequest("The RPC username is not valid")))

        const clock = yield* Clock.Clock
        const now = yield* clock.currentTimeMillis

        const windowInput =
          payload.from !== undefined && payload.to !== undefined
            ? { from: payload.from, to: payload.to }
            : payload.from !== undefined
              ? { from: payload.from }
              : payload.to !== undefined
                ? { to: payload.to }
                : {}

        const resolved = ActivityDomain.resolveWindow(windowInput, now)

        if (Result.isFailure(resolved)) {
          const detail = Match.value(resolved.failure).pipe(
            Match.when(
              "window-too-wide",
              () => "The activity window cannot exceed 90 inclusive UTC dates",
            ),
            Match.when("window-reversed", () => "The activity window cannot be reversed"),
            Match.orElse(() => "The activity window requires both from and to bounds"),
          )

          return yield* Effect.fail(invalidRequest(detail))
        }

        const request: typeof ActivityRequest.Type = {
          username: normalizedUsername,
          from: resolved.success.from,
          to: resolved.success.to,
        }

        return yield* cache
          .summarize(JSON.stringify(request))
          .pipe(Effect.mapError(normalizeActivityError))
      }),
    streak: (payload) =>
      Effect.gen(function* () {
        const objectName = state.objectName
        const requestedName = payload.username.toLowerCase()

        if (objectName !== undefined && objectName.toLowerCase() !== requestedName) {
          return yield* Effect.fail(
            invalidRequest("The RPC username does not match the Durable Object identity"),
          )
        }

        const normalizedUsername = yield* Schema.decodeUnknownEffect(GitHubUsername)(
          requestedName,
        ).pipe(Effect.mapError(() => invalidRequest("The RPC username is not valid")))

        const clock = yield* Clock.Clock
        const now = yield* clock.currentTimeMillis
        const range = StreakDomain.resolveRange(now)

        if (Result.isFailure(range))
          return yield* Effect.fail(upstreamFailure("Kronik could not resolve today's UTC date"))

        const request: typeof StreakRequest.Type = {
          username: normalizedUsername,
          from: range.success.from,
          to: range.success.to,
        }

        return yield* cache
          .streak(JSON.stringify(request))
          .pipe(Effect.mapError(normalizeActivityError))
      }),
  })

  return yield* RpcServer.toHttpEffect(Rpcs).pipe(
    // The Durable Object initializer is this RPC server's composition root.
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
  )
})

/** Cloudflare Durable Object adapter for the testable activity coordinator. */
export const ActivityObjectLive = ActivityObject.make(
  Effect.gen(function* () {
    const durableState = yield* DurableObjectState
    // Cloudflare has no Durable Object deactivation hook; this instance scope owns its caches.
    const instanceScope = yield* Scope.make()

    const initialized = activityRuntime().pipe(
      Effect.provideService(ActivityState, {
        get objectName() {
          return durableState.id?.name
        },
        storage: {
          get: (key) => durableState.storage.get(key),
          list: (options) => durableState.storage.list(options),
          put: (key, value) => durableState.storage.put(key, value),
          delete: (key) => durableState.storage.delete(key),
          deleteMany: (keys) => durableState.storage.delete([...keys]),
        },
      }),
      Effect.provideService(Scope.Scope, instanceScope),
    )

    // The RPC Durable Object API requires the HTTP handler inside one more initializer effect.
    // oxlint-disable-next-line effecttsgo/return-effect-in-gen
    return Effect.succeed(initialized)
  }),
)

const buildContributionStreak = Effect.fn("ActivityObject.buildContributionStreak")(function* (
  request: typeof StreakRequest.Type,
  evidence: GitHub.StreakEvidence,
) {
  const projected = StreakDomain.calculate(evidence.user, request.from, request.to, evidence.days)

  if (Result.isFailure(projected))
    return yield* Effect.fail(upstreamFailure("GitHub returned a malformed contribution calendar"))

  return projected.success
})

const buildActivitySummary = Effect.fn("ActivityObject.buildActivitySummary")(function* (
  window: ActivityWindow,
  evidence: GitHub.ActivityEvidence,
) {
  const projected = ActivityDomain.summarize(window, evidence)

  if (Result.isFailure(projected)) {
    return yield* Effect.fail(upstreamFailure("GitHub returned unsafe activity evidence"))
  }

  return projected.success
})

const buildCommitPage = Effect.fn("ActivityObject.buildCommitPage")(function* (
  cursor: Cursor.Interface,
  evidence: GitHub.CommitPageEvidence,
  request: PageRequest,
) {
  const items = yield* Effect.forEach(evidence.items, (item) => {
    const projected = CommitDomain.projectCommit(item)

    if (Result.isFailure(projected)) {
      return Effect.fail(upstreamFailure("GitHub returned unsafe change counts"))
    }

    return Effect.succeed(projected.success)
  })

  const reachable = Math.min(evidence.totalCount, SearchBoundary)
  const pageEnd = request.position * request.pageSize

  const hasNext =
    !evidence.incompleteResults &&
    items.length > 0 &&
    request.position < SearchBoundary &&
    pageEnd < reachable

  const hasPrevious = request.position > 1

  const next = hasNext
    ? yield* cursor.encode({
        version: 1,
        username: request.username,
        snapshot: request.snapshot,
        pageSize: request.pageSize,
        position: request.position + 1,
        direction: "forward",
      })
    : null

  const previous = hasPrevious
    ? yield* cursor.encode({
        version: 1,
        username: request.username,
        snapshot: request.snapshot,
        pageSize: request.pageSize,
        position: request.position - 1,
        direction: "backward",
      })
    : null

  return yield* Schema.decodeUnknownEffect(CommitPage)({
    user: evidence.user,
    items,
    previous,
    next,
  }).pipe(Effect.mapError(() => upstreamFailure("Kronik produced an invalid commit page")))
})

export default ActivityObjectLive

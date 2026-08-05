export * as ActivityObjectModule from "./activity-object.js"

import { ApiError } from "@kronik/contract/errors"
import {
  ActivitySummary,
  ActivityWindow,
  CommitPage,
  GitHubUsername,
  IsoDate,
  IsoTimestamp,
  LatestCommit,
  ContributionStreak,
  User,
} from "@kronik/contract/model"
import { StreakRpcs } from "@kronik/contract/rpc"
import * as Cloudflare from "alchemy/Cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import {
  Cache,
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Result,
  Schema,
} from "effect"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { ActivityDomain } from "./activity-domain.js"
import { CommitDomain } from "./commit-domain.js"
import { Cursor } from "./cursor.js"
import { GitHub } from "./github.js"
import { StreakDomain } from "./streak-domain.js"

/** The persistent operations owned by the activity coordinator. */
export interface ActivityStorage {
  /** Read one persisted value from the Durable Object. */
  readonly get: (key: string) => Effect.Effect<unknown, never, RuntimeContext>
  /** Persist one value in the Durable Object. */
  readonly put: (key: string, value: unknown) => Effect.Effect<void, never, RuntimeContext>
  /** Remove one malformed or obsolete persisted value. */
  readonly delete: (key: string) => Effect.Effect<boolean, never, RuntimeContext>
}

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

const FreshTtlMs = 60_000
const ActivityFreshTtlMs = 300_000
const StreakFreshTtlMs = 300_000
const StaleTtlMs = 3_600_000
const StorageKey = "latest-commit-v1"
const StreakStoragePrefix = "contribution-streak-v1:"
const DefaultPageSize = 10
const SearchBoundary = 1_000

const StoredSuccess = Schema.Struct({
  kind: Schema.Literal("success"),
  savedAt: Schema.Number,
  value: LatestCommit,
})
const StoredNegative = Schema.Struct({
  kind: Schema.Literal("user-not-found"),
  savedAt: Schema.Number,
  user: Schema.optionalKey(User),
})
const StoredRecord = Schema.Union([StoredSuccess, StoredNegative])
type StoredRecord = typeof StoredRecord.Type

const PageRequest = Schema.Struct({
  username: GitHubUsername,
  snapshot: IsoTimestamp,
  pageSize: Schema.Number,
  position: Schema.Number,
})
type PageRequest = typeof PageRequest.Type

const StoredPage = Schema.Struct({
  kind: Schema.Literal("success"),
  savedAt: Schema.Number,
  value: CommitPage,
})
const ActivityRequest = Schema.Struct({
  username: GitHubUsername,
  from: IsoDate,
  to: IsoDate,
})
const StoredSummary = Schema.Struct({
  kind: Schema.Literal("success"),
  savedAt: Schema.Number,
  value: ActivitySummary,
})
const StreakRequest = Schema.Struct({
  username: GitHubUsername,
  from: IsoDate,
  to: IsoDate,
})
const StoredStreak = Schema.Struct({
  kind: Schema.Literal("success"),
  savedAt: Schema.Number,
  value: ContributionStreak,
})

type LookupResult = {
  readonly value: LatestCommit
  readonly cacheState: "fresh" | "stale"
}
type PageLookupResult = {
  readonly value: CommitPage
  readonly cacheState: "fresh" | "stale"
}
type SummaryLookupResult = {
  readonly value: ActivitySummary
  readonly cacheState: "fresh" | "stale"
}
type StreakLookupResult = {
  readonly value: ContributionStreak
  readonly cacheState: "fresh" | "stale"
}

const userNotFound = () =>
  new ApiError.UserNotFound({
    type: "https://kronik.dev/problems/user-not-found",
    title: "User not found",
    detail: "GitHub does not resolve the requested user",
    instance: "urn:kronik:activity:user-not-found",
    status: 404,
  })

const serviceUnavailable = () =>
  new ApiError.ServiceUnavailable({
    type: "https://kronik.dev/problems/service-unavailable",
    title: "Service unavailable",
    detail: "Kronik could not complete the GitHub lookup",
    instance: "urn:kronik:activity:timeout",
    status: 503,
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

const normalizeActivityError = (error: unknown): ApiError.DomainErrors => {
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
export class ActivityObject extends Cloudflare.RpcDurableObject<ActivityObject>()(
  "KronikActivity",
  { schema: StreakRpcs },
) {}

const AuthorizationFailureDetail = "Kronik's GitHub credential was rejected"

const isStaleFallbackFailure = (error: ApiError.DomainErrors): boolean =>
  error instanceof ApiError.RateLimited ||
  (error instanceof ApiError.UpstreamFailure && error.detail !== AuthorizationFailureDetail) ||
  error instanceof ApiError.ServiceUnavailable

const pageKey = (request: PageRequest): string => JSON.stringify(request)

const pageStorageKey = (key: string): string => `commits-page-v1:${key}`

const decodeActivityKey = (key: string) =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(key),
      catch: () => upstreamFailure("Kronik produced an invalid activity cache key"),
    })
    return yield* Schema.decodeUnknownEffect(ActivityRequest)(value).pipe(
      Effect.mapError(() => upstreamFailure("Kronik produced an invalid activity cache key")),
    )
  })

const activityStorageKey = (key: string): string => `activity-summary-v1:${key}`
const streakStorageKey = (key: string): string => `${StreakStoragePrefix}${key}`

const decodeStreakKey = (key: string) =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(key),
      catch: () => upstreamFailure("Kronik produced an invalid streak cache key"),
    })
    return yield* Schema.decodeUnknownEffect(StreakRequest)(value).pipe(
      Effect.mapError(() => upstreamFailure("Kronik produced an invalid streak cache key")),
    )
  })

const decodePageKey = (key: string) =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(key),
      catch: () => upstreamFailure("Kronik produced an invalid page cache key"),
    })
    return yield* Schema.decodeUnknownEffect(PageRequest)(value).pipe(
      Effect.mapError(() => upstreamFailure("Kronik produced an invalid page cache key")),
    )
  })

/** Testable RPC implementation with persistent records and scoped lookup deduplication. */
export const activityRuntime = Effect.fn("ActivityObject.runtime")(function* () {
  const state = yield* ActivityState
  const github = yield* GitHub.Service
  const cursor = yield* Cursor.Service
  const latestCache = yield* Cache.makeWith<
    GitHubUsername,
    LookupResult,
    ApiError.DomainErrors,
    RuntimeContext | Clock.Clock
  >(
    (username: GitHubUsername) =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock
        const now = yield* clock.currentTimeMillis
        const storedValue = yield* state.storage.get(StorageKey)
        const stored =
          storedValue === undefined
            ? Option.none<StoredRecord>()
            : Schema.decodeUnknownOption(StoredRecord)(storedValue)
        if (storedValue !== undefined && Option.isNone(stored)) {
          yield* state.storage.delete(StorageKey)
        }

        const record = Option.isNone(stored) ? undefined : stored.value
        const age = record === undefined ? undefined : now - record.savedAt
        const fresh = age !== undefined && age >= 0 && age <= FreshTtlMs
        const staleEligible = age !== undefined && age > FreshTtlMs && age <= StaleTtlMs

        if (fresh && record !== undefined) {
          if (record.kind !== "success") return yield* Effect.fail(userNotFound())
          return { value: record.value, cacheState: "fresh" as const }
        }

        const persistNegative = () =>
          state.storage.put(StorageKey, {
            kind: "user-not-found",
            savedAt: now,
          })

        const live = github.latestCommit(username).pipe(
          Effect.tapError((error) =>
            error instanceof ApiError.UserNotFound ? persistNegative() : Effect.void,
          ),
          Effect.tap((value) =>
            state.storage.put(StorageKey, { kind: "success", savedAt: now, value }),
          ),
          Effect.map((value) => ({ value, cacheState: "fresh" as const })),
          Effect.timeout("10 seconds"),
          Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(serviceUnavailable())),
        )

        if (staleEligible && record !== undefined && record.kind === "success") {
          return yield* live.pipe(
            Effect.catchIf(isStaleFallbackFailure, () =>
              Effect.succeed({ value: record.value, cacheState: "stale" as const }),
            ),
          )
        }
        return yield* live
      }),
    {
      capacity: 1,
      timeToLive: (exit) => {
        if (Exit.isSuccess(exit))
          return exit.value.cacheState === "fresh" ? Duration.millis(FreshTtlMs) : Duration.zero
        const error = Cause.findError(exit.cause)
        return Result.isSuccess(error) && error.success instanceof ApiError.UserNotFound
          ? Duration.millis(FreshTtlMs)
          : Duration.zero
      },
    },
  )

  const pageCache = yield* Cache.makeWith<
    string,
    PageLookupResult,
    ApiError.DomainErrors,
    RuntimeContext | Clock.Clock
  >(
    (key: string) =>
      Effect.gen(function* () {
        const request = yield* decodePageKey(key)
        const clock = yield* Clock.Clock
        const now = yield* clock.currentTimeMillis
        const storageKey = pageStorageKey(key)
        const storedValue = yield* state.storage.get(storageKey)
        const stored =
          storedValue === undefined
            ? Option.none<typeof StoredPage.Type>()
            : Schema.decodeUnknownOption(StoredPage)(storedValue)
        if (storedValue !== undefined && Option.isNone(stored)) {
          yield* state.storage.delete(storageKey)
        }

        const record = Option.isNone(stored) ? undefined : stored.value
        const age = record === undefined ? undefined : now - record.savedAt
        const fresh = age !== undefined && age >= 0 && age <= FreshTtlMs
        const staleEligible = age !== undefined && age > FreshTtlMs && age <= StaleTtlMs
        if (fresh && record !== undefined) {
          return { value: record.value, cacheState: "fresh" as const }
        }

        const live = github
          .commits({
            username: request.username,
            snapshot: request.snapshot,
            pageSize: request.pageSize,
            position: request.position,
          })
          .pipe(
            Effect.flatMap((evidence) => buildCommitPage(cursor, evidence, request)),
            Effect.tap((value) =>
              state.storage.put(storageKey, { kind: "success", savedAt: now, value }),
            ),
            Effect.map((value) => ({ value, cacheState: "fresh" as const })),
            Effect.timeout("10 seconds"),
            Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(serviceUnavailable())),
          )

        if (staleEligible && record !== undefined) {
          return yield* live.pipe(
            Effect.catchIf(isStaleFallbackFailure, () =>
              Effect.succeed({ value: record.value, cacheState: "stale" as const }),
            ),
          )
        }
        return yield* live
      }),
    {
      capacity: 32,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.cacheState === "fresh"
          ? Duration.millis(FreshTtlMs)
          : Duration.zero,
    },
  )

  const summaryCache = yield* Cache.makeWith<
    string,
    SummaryLookupResult,
    ApiError.DomainErrors,
    RuntimeContext | Clock.Clock
  >(
    (key: string) =>
      Effect.gen(function* () {
        const request = yield* decodeActivityKey(key)
        const clock = yield* Clock.Clock
        const now = yield* clock.currentTimeMillis
        const storageKey = activityStorageKey(key)
        const storedValue = yield* state.storage.get(storageKey)
        const stored =
          storedValue === undefined
            ? Option.none<typeof StoredSummary.Type>()
            : Schema.decodeUnknownOption(StoredSummary)(storedValue)
        if (storedValue !== undefined && Option.isNone(stored)) {
          yield* state.storage.delete(storageKey)
        }

        const record = Option.isNone(stored) ? undefined : stored.value
        const age = record === undefined ? undefined : now - record.savedAt
        const fresh = age !== undefined && age >= 0 && age <= ActivityFreshTtlMs
        const staleEligible = age !== undefined && age > ActivityFreshTtlMs && age <= StaleTtlMs
        if (fresh && record !== undefined) {
          return { value: record.value, cacheState: "fresh" as const }
        }

        const live = github
          .activity({ username: request.username, from: request.from, to: request.to })
          .pipe(
            Effect.flatMap((evidence) => buildActivitySummary(request, evidence)),
            Effect.tap((value) =>
              state.storage.put(storageKey, { kind: "success", savedAt: now, value }),
            ),
            Effect.map((value) => ({ value, cacheState: "fresh" as const })),
            Effect.timeout("10 seconds"),
            Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(serviceUnavailable())),
          )

        if (staleEligible && record !== undefined) {
          return yield* live.pipe(
            Effect.catchIf(isStaleFallbackFailure, () =>
              Effect.succeed({ value: record.value, cacheState: "stale" as const }),
            ),
          )
        }
        return yield* live
      }),
    {
      capacity: 32,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.cacheState === "fresh"
          ? Duration.millis(ActivityFreshTtlMs)
          : Duration.zero,
    },
  )

  const streakCache = yield* Cache.makeWith<
    string,
    StreakLookupResult,
    ApiError.DomainErrors,
    RuntimeContext | Clock.Clock
  >(
    (key: string) =>
      Effect.gen(function* () {
        const request = yield* decodeStreakKey(key)
        const clock = yield* Clock.Clock
        const now = yield* clock.currentTimeMillis
        const storageKey = streakStorageKey(key)
        const storedValue = yield* state.storage.get(storageKey)
        const stored =
          storedValue === undefined
            ? Option.none<typeof StoredStreak.Type>()
            : Schema.decodeUnknownOption(StoredStreak)(storedValue)
        if (storedValue !== undefined && Option.isNone(stored)) {
          yield* state.storage.delete(storageKey)
        }

        const record = Option.isNone(stored) ? undefined : stored.value
        const age = record === undefined ? undefined : now - record.savedAt
        const fresh = age !== undefined && age >= 0 && age <= StreakFreshTtlMs
        const staleEligible = age !== undefined && age > StreakFreshTtlMs && age <= StaleTtlMs
        if (fresh && record !== undefined) {
          return { value: record.value, cacheState: "fresh" as const }
        }

        const live = github.streak(request).pipe(
          Effect.flatMap((evidence) => buildContributionStreak(request, evidence)),
          Effect.tap((value) =>
            state.storage.put(storageKey, { kind: "success", savedAt: now, value }),
          ),
          Effect.map((value) => ({ value, cacheState: "fresh" as const })),
          Effect.timeout("10 seconds"),
          Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(serviceUnavailable())),
        )

        if (staleEligible && record !== undefined) {
          return yield* live.pipe(
            Effect.catchIf(isStaleFallbackFailure, () =>
              Effect.succeed({ value: record.value, cacheState: "stale" as const }),
            ),
          )
        }
        return yield* live
      }),
    {
      capacity: 32,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.cacheState === "fresh"
          ? Duration.millis(StreakFreshTtlMs)
          : Duration.zero,
    },
  )

  const handlers = StreakRpcs.toLayer({
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
        return yield* Cache.get(latestCache, normalizedUsername).pipe(
          Effect.mapError(normalizeActivityError),
        )
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
        return yield* Cache.get(pageCache, pageKey(request)).pipe(
          Effect.mapError(normalizeActivityError),
        )
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
          const detail =
            resolved.failure === "window-too-wide"
              ? "The activity window cannot exceed 90 inclusive UTC dates"
              : resolved.failure === "window-reversed"
                ? "The activity window cannot be reversed"
                : "The activity window requires both from and to bounds"
          return yield* Effect.fail(invalidRequest(detail))
        }
        const request: typeof ActivityRequest.Type = {
          username: normalizedUsername,
          from: resolved.success.from,
          to: resolved.success.to,
        }
        return yield* Cache.get(summaryCache, JSON.stringify(request)).pipe(
          Effect.mapError(normalizeActivityError),
        )
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
        return yield* Cache.get(streakCache, JSON.stringify(request)).pipe(
          Effect.mapError(normalizeActivityError),
        )
      }),
  })
  return yield* RpcServer.toHttpEffect(StreakRpcs).pipe(
    Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)),
  )
})

/** Cloudflare Durable Object adapter for the testable activity coordinator. */
export const ActivityObjectLive = ActivityObject.make(
  Effect.gen(function* () {
    const durableState = yield* Cloudflare.DurableObjectState
    const runtime = yield* activityRuntime().pipe(
      Effect.provideService(ActivityState, {
        objectName: durableState.id.name,
        storage: durableState.storage,
      }),
    )
    return Effect.succeed(Effect.succeed(runtime))
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
    if (projected._tag === "Failure") {
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

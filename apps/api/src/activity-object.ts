// Effect's HTTP/RPC adapters remain unstable in v4; exact versions and integration tests guard upgrades.
/* oxlint-disable effecttsgo/unstable-api-usage */

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
import { DurableObjectState, RpcDurableObject } from "@alchemy.run/cloudflare"
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
  Match,
  Option,
  Result,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { ActivityDomain } from "./activity-domain.js"
import { CommitDomain } from "./commit-domain.js"
import { Cursor } from "./cursor.js"
import { GitHub } from "./github.js"
import { StreakDomain } from "./streak-domain.js"

/** The persistent operations owned by the activity coordinator. */
export interface ActivityStorage {
  /** Read one persisted value from the Durable Object. */
  readonly get: (key: string) => Effect.Effect<unknown, never, RuntimeContext>
  /** List an ordered, bounded page of persisted values. */
  readonly list: (options: {
    readonly limit: number
    readonly startAfter?: string
  }) => Effect.Effect<ReadonlyMap<string, unknown>, never, RuntimeContext>
  /** Persist one cache record or cleanup cursor in the Durable Object. */
  readonly put: (
    key: string,
    value:
      | StoredRecord
      | typeof StoredPage.Type
      | typeof StoredSummary.Type
      | typeof StoredStreak.Type
      | string,
  ) => Effect.Effect<void, never, RuntimeContext>
  /** Remove one malformed or obsolete persisted value. */
  readonly delete: (key: string) => Effect.Effect<boolean, never, RuntimeContext>
  /** Remove a bounded batch of obsolete persisted values. */
  readonly deleteMany: (keys: ReadonlyArray<string>) => Effect.Effect<number, never, RuntimeContext>
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

const PageStoragePrefix = "commits-page-v1:"

const SummaryStoragePrefix = "activity-summary-v1:"

const StreakStoragePrefix = "contribution-streak-v1:"

const CleanupCursorKey = "cache-cleanup-cursor-v1"

const CleanupBatchSize = 32

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
  schema: StreakRpcs,
}) {}

const AuthorizationFailureDetail = "Kronik's GitHub credential was rejected"

const isStaleFallbackFailure = (error: ApiError.DomainErrors): boolean =>
  error instanceof ApiError.RateLimited ||
  (error instanceof ApiError.UpstreamFailure && error.detail !== AuthorizationFailureDetail) ||
  error instanceof ApiError.ServiceUnavailable

const pageKey = (request: PageRequest): string => JSON.stringify(request)

const pageStorageKey = (key: string): string => `${PageStoragePrefix}${key}`

const decodeActivityKey = (key: string) =>
  Effect.gen(function* () {
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ActivityRequest))(key).pipe(
      Effect.mapError(() => upstreamFailure("Kronik produced an invalid activity cache key")),
    )
  })

const activityStorageKey = (key: string): string => `${SummaryStoragePrefix}${key}`

const streakStorageKey = (key: string): string => `${StreakStoragePrefix}${key}`

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

type StoredExpiry = {
  readonly savedAt: number
  readonly maxAge: number
}

const staleExpiry = (record: { readonly savedAt: number }): StoredExpiry => ({
  savedAt: record.savedAt,
  maxAge: StaleTtlMs,
})

// Storage list values must be decoded according to their cache namespace.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const storedExpiry = (key: string, value: unknown): Option.Option<StoredExpiry> | undefined => {
  if (key === StorageKey)
    return Schema.decodeUnknownOption(StoredRecord)(value).pipe(
      Option.map((record) => ({
        savedAt: record.savedAt,
        maxAge: record.kind === "success" ? StaleTtlMs : FreshTtlMs,
      })),
    )

  if (key.startsWith(PageStoragePrefix))
    return Schema.decodeUnknownOption(StoredPage)(value).pipe(Option.map(staleExpiry))

  if (key.startsWith(SummaryStoragePrefix))
    return Schema.decodeUnknownOption(StoredSummary)(value).pipe(Option.map(staleExpiry))

  if (key.startsWith(StreakStoragePrefix))
    return Schema.decodeUnknownOption(StoredStreak)(value).pipe(Option.map(staleExpiry))

  return undefined
}

/** Testable RPC implementation with persistent records and scoped lookup deduplication. */
export const activityRuntime = Effect.fn("ActivityObject.runtime")(function* () {
  const state = yield* ActivityState
  const github = yield* GitHub.Service
  const cursor = yield* Cursor.Service
  // A sweep must not delete a record that a concurrent lookup has just refreshed.
  const storageLock = yield* Semaphore.make(1)

  // The supplied decoder parses the value read from persistent storage.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  const readStored = <A>(key: string, decode: (value: unknown) => Option.Option<A>) =>
    storageLock.withPermit(
      Effect.gen(function* () {
        const value = yield* state.storage.get(key)

        if (value === undefined) return Option.none<A>()

        const record = decode(value)

        if (Option.isNone(record)) yield* state.storage.delete(key)

        return record
      }),
    )

  const writeStored: ActivityStorage["put"] = (key, value) =>
    storageLock.withPermit(state.storage.put(key, value))

  // Active requests advance a bounded scan; the cursor survives object reactivation.
  const cleanup = Effect.fn("ActivityObject.cleanup")(function* () {
    yield* storageLock.withPermit(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock
        const now = yield* clock.currentTimeMillis
        const cursorValue = yield* state.storage.get(CleanupCursorKey)

        const savedCursor = Schema.decodeUnknownOption(Schema.String)(cursorValue)

        const entries = yield* state.storage.list(
          Option.isSome(savedCursor)
            ? { limit: CleanupBatchSize, startAfter: savedCursor.value }
            : { limit: CleanupBatchSize },
        )

        const expired: Array<string> = []
        let lastKey: string | undefined

        for (const [key, value] of entries) {
          lastKey = key

          const expiry = storedExpiry(key, value)

          if (
            expiry !== undefined &&
            (Option.isNone(expiry) ||
              !Number.isFinite(expiry.value.savedAt) ||
              now - expiry.value.savedAt > expiry.value.maxAge)
          )
            expired.push(key)
        }

        if (expired.length > 0) yield* state.storage.deleteMany(expired)

        if (entries.size === CleanupBatchSize && lastKey !== undefined) {
          yield* state.storage.put(CleanupCursorKey, lastKey)

          return
        }

        if (cursorValue !== undefined) yield* state.storage.delete(CleanupCursorKey)
      }),
    )
  })

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
        const stored = yield* readStored(StorageKey, Schema.decodeUnknownOption(StoredRecord))

        const record = Option.isNone(stored) ? undefined : stored.value
        const age = record === undefined ? undefined : now - record.savedAt
        const fresh = age !== undefined && age >= 0 && age <= FreshTtlMs
        const staleEligible = age !== undefined && age > FreshTtlMs && age <= StaleTtlMs

        if (fresh && record !== undefined) {
          if (record.kind !== "success") return yield* Effect.fail(userNotFound())

          return { value: record.value, cacheState: "fresh" as const }
        }

        const persistNegative = () =>
          writeStored(StorageKey, {
            kind: "user-not-found",
            savedAt: now,
          })

        const live = github.latestCommit(username).pipe(
          Effect.tapError((error) =>
            error instanceof ApiError.UserNotFound ? persistNegative() : Effect.void,
          ),
          Effect.tap((value) => writeStored(StorageKey, { kind: "success", savedAt: now, value })),
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
        const stored = yield* readStored(storageKey, Schema.decodeUnknownOption(StoredPage))

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
              writeStored(storageKey, { kind: "success", savedAt: now, value }),
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
        const stored = yield* readStored(storageKey, Schema.decodeUnknownOption(StoredSummary))

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
              writeStored(storageKey, { kind: "success", savedAt: now, value }),
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
        const stored = yield* readStored(storageKey, Schema.decodeUnknownOption(StoredStreak))

        const record = Option.isNone(stored) ? undefined : stored.value
        const age = record === undefined ? undefined : now - record.savedAt
        const fresh = age !== undefined && age >= 0 && age <= StreakFreshTtlMs
        const staleEligible = age !== undefined && age > StreakFreshTtlMs && age <= StaleTtlMs

        if (fresh && record !== undefined) {
          return { value: record.value, cacheState: "fresh" as const }
        }

        const live = github.streak(request).pipe(
          Effect.flatMap((evidence) => buildContributionStreak(request, evidence)),
          Effect.tap((value) => writeStored(storageKey, { kind: "success", savedAt: now, value })),
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

        yield* cleanup()

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

        yield* cleanup()

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

        yield* cleanup()

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

        yield* cleanup()

        return yield* Cache.get(streakCache, JSON.stringify(request)).pipe(
          Effect.mapError(normalizeActivityError),
        )
      }),
  })

  return yield* RpcServer.toHttpEffect(StreakRpcs).pipe(
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

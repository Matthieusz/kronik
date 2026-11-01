export * as ActivityCache from "./activity-cache.js"

import { ApiError } from "@kronik/contract/errors"
import {
  ActivitySummary,
  CommitPage,
  ContributionStreak,
  GitHubUsername,
  LatestCommit,
  User,
} from "@kronik/contract/model"
import { RuntimeContext } from "alchemy/RuntimeContext"
import {
  Cache,
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Option,
  Result,
  Schema,
  Semaphore,
} from "effect"
import { UserActivity } from "./user-activity.js"

const StoredNegative = Schema.Struct({
  kind: Schema.Literal("user-not-found"),
  savedAt: Schema.Number,
  user: Schema.optionalKey(User),
})

const StoredLatest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("success"), savedAt: Schema.Number, value: LatestCommit }),
  StoredNegative,
])

const StoredPage = Schema.Struct({
  kind: Schema.Literal("success"),
  savedAt: Schema.Number,
  value: CommitPage,
})

const StoredSummary = Schema.Struct({
  kind: Schema.Literal("success"),
  savedAt: Schema.Number,
  value: ActivitySummary,
})

const StoredStreak = Schema.Struct({
  kind: Schema.Literal("success"),
  savedAt: Schema.Number,
  value: ContributionStreak,
})

type CachedValue = LatestCommit | CommitPage | ActivitySummary | ContributionStreak

type StoredRecord<A> =
  | { readonly kind: "success"; readonly savedAt: number; readonly value: A }
  | typeof StoredNegative.Type

/** Persistent operations used by the private Requested User cache lifecycle. */
export interface ActivityStorage {
  /** Read a persisted value for schema decoding. */
  readonly get: (key: string) => Effect.Effect<unknown, never, RuntimeContext>
  /** List an ordered, bounded page of persisted values. */
  readonly list: (options: {
    readonly limit: number
    readonly startAfter?: string
  }) => Effect.Effect<ReadonlyMap<string, unknown>, never, RuntimeContext>
  /** Persist a cache record or cleanup cursor. */
  readonly put: (
    key: string,
    value: StoredRecord<CachedValue> | string,
  ) => Effect.Effect<void, never, RuntimeContext>
  /** Remove a malformed record or completed cleanup cursor. */
  readonly delete: (key: string) => Effect.Effect<boolean, never, RuntimeContext>
  /** Remove a bounded batch of obsolete records. */
  readonly deleteMany: (keys: ReadonlyArray<string>) => Effect.Effect<number, never, RuntimeContext>
}

interface Policy<A> {
  readonly prefix: string
  readonly freshTtl: number
  readonly retention: number
  readonly capacity: number
  readonly cacheUserNotFound: boolean
  // Persisted values are decoded before lifecycle decisions; malformed records are discarded.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  readonly decode: (value: unknown) => Option.Option<StoredRecord<A>>
}

const latestPolicy: Policy<LatestCommit> = {
  prefix: "latest-commit-v1",
  freshTtl: 60_000,
  retention: 3_600_000,
  capacity: 1,
  cacheUserNotFound: true,
  decode: Schema.decodeUnknownOption(StoredLatest),
}

const pagePolicy: Policy<CommitPage> = {
  prefix: "commits-page-v1:",
  freshTtl: 60_000,
  retention: 3_600_000,
  capacity: 32,
  cacheUserNotFound: false,
  decode: Schema.decodeUnknownOption(StoredPage),
}

const summaryPolicy: Policy<ActivitySummary> = {
  prefix: "activity-summary-v1:",
  freshTtl: 300_000,
  retention: 3_600_000,
  capacity: 32,
  cacheUserNotFound: false,
  decode: Schema.decodeUnknownOption(StoredSummary),
}

const streakPolicy: Policy<ContributionStreak> = {
  prefix: "contribution-streak-v1:",
  freshTtl: 300_000,
  retention: 3_600_000,
  capacity: 32,
  cacheUserNotFound: false,
  decode: Schema.decodeUnknownOption(StoredStreak),
}

const CleanupCursorKey = "cache-cleanup-cursor-v1"

const CleanupBatchSize = 32

const AuthorizationFailureDetail = "Kronik's GitHub credential was rejected"

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

const isStaleFallbackFailure = (error: ApiError.DomainErrors): boolean =>
  error instanceof ApiError.RateLimited ||
  (error instanceof ApiError.UpstreamFailure && error.detail !== AuthorizationFailureDetail) ||
  error instanceof ApiError.ServiceUnavailable

const policyForKey = (key: string): Policy<CachedValue> | undefined => {
  if (key === latestPolicy.prefix) return latestPolicy

  if (key.startsWith(pagePolicy.prefix)) return pagePolicy

  if (key.startsWith(summaryPolicy.prefix)) return summaryPolicy

  if (key.startsWith(streakPolicy.prefix)) return streakPolicy

  return undefined
}

/** Domain projections supplied by the coordinator; keys have already passed request validation. */
export interface Loaders {
  /** Fetch the latest matching commit for a normalized Requested User. */
  readonly latestCommit: (
    username: GitHubUsername,
  ) => Effect.Effect<LatestCommit, ApiError.DomainErrors>
  /** Decode a page key, fetch evidence, and project its Commit Summaries. */
  readonly commits: (key: string) => Effect.Effect<CommitPage, ApiError.DomainErrors>
  /** Decode an Activity Window key and project its Activity Summary. */
  readonly summarize: (key: string) => Effect.Effect<ActivitySummary, ApiError.DomainErrors>
  /** Decode a calendar-range key and project its Contribution Streak. */
  readonly streak: (key: string) => Effect.Effect<ContributionStreak, ApiError.DomainErrors>
}

/**
 * Build caches once per coordinator instance, sharing storage serialization with bounded cleanup.
 * Lookups retain domain failures, translate total timeouts, and mark eligible stale fallbacks.
 */
export const make = Effect.fn("ActivityCache.make")(function* (
  storage: ActivityStorage,
  loaders: Loaders,
) {
  // A sweep must not delete a record that a concurrent lookup has just refreshed.
  const storageLock = yield* Semaphore.make(1)

  const writeStored: ActivityStorage["put"] = (key, value) =>
    storageLock.withPermit(storage.put(key, value))

  const cleanup = Effect.fn("ActivityCache.cleanup")(function* () {
    yield* storageLock.withPermit(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock
        const now = yield* clock.currentTimeMillis
        const cursorValue = yield* storage.get(CleanupCursorKey)
        const savedCursor = Schema.decodeUnknownOption(Schema.String)(cursorValue)

        const entries = yield* storage.list(
          Option.isSome(savedCursor)
            ? { limit: CleanupBatchSize, startAfter: savedCursor.value }
            : { limit: CleanupBatchSize },
        )

        const expired: Array<string> = []
        let lastKey: string | undefined

        for (const [key, value] of entries) {
          lastKey = key
          const policy = policyForKey(key)

          if (policy === undefined) continue
          const record = policy.decode(value)

          if (Option.isNone(record)) {
            expired.push(key)
            continue
          }

          const maxAge = record.value.kind === "user-not-found" ? policy.freshTtl : policy.retention

          if (!Number.isFinite(record.value.savedAt) || now - record.value.savedAt > maxAge)
            expired.push(key)
        }

        if (expired.length > 0) yield* storage.deleteMany(expired)

        if (entries.size === CleanupBatchSize && lastKey !== undefined) {
          yield* storage.put(CleanupCursorKey, lastKey)

          return
        }

        if (cursorValue !== undefined) yield* storage.delete(CleanupCursorKey)
      }),
    )
  })

  const makeLookup = <A extends CachedValue, K extends string>(
    policy: Policy<A>,
    load: (key: K) => Effect.Effect<A, ApiError.DomainErrors>,
  ) =>
    Cache.makeWith(
      (key: K) =>
        Effect.gen(function* () {
          const clock = yield* Clock.Clock
          const now = yield* clock.currentTimeMillis
          const storageKey = policy === latestPolicy ? policy.prefix : `${policy.prefix}${key}`

          const stored = yield* storageLock.withPermit(
            Effect.gen(function* () {
              const value = yield* storage.get(storageKey)

              if (value === undefined) return Option.none<StoredRecord<A>>()
              const decoded = policy.decode(value)

              if (Option.isNone(decoded)) yield* storage.delete(storageKey)

              return decoded
            }),
          )

          const record = Option.isSome(stored) ? stored.value : undefined
          const age = record === undefined ? undefined : now - record.savedAt
          const fresh = age !== undefined && age >= 0 && age <= policy.freshTtl

          const staleEligible =
            age !== undefined && age > policy.freshTtl && age <= policy.retention

          if (fresh && record !== undefined) {
            if (record.kind === "user-not-found") return yield* Effect.fail(userNotFound())

            return { value: record.value, cacheState: "fresh" as const }
          }

          const live = load(key).pipe(
            Effect.tapError((error) =>
              policy.cacheUserNotFound && error instanceof ApiError.UserNotFound
                ? writeStored(storageKey, { kind: "user-not-found", savedAt: now })
                : Effect.void,
            ),
            Effect.tap((value) =>
              writeStored(storageKey, { kind: "success", savedAt: now, value }),
            ),
            Effect.map((value): UserActivity.LookupResult<A> => ({ value, cacheState: "fresh" })),
            Effect.timeout("10 seconds"),
            Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(serviceUnavailable())),
          )

          if (staleEligible && record !== undefined && record.kind === "success")
            return yield* live.pipe(
              Effect.catchIf(isStaleFallbackFailure, () =>
                Effect.succeed({ value: record.value, cacheState: "stale" as const }),
              ),
            )

          return yield* live
        }),
      {
        capacity: policy.capacity,
        timeToLive: (exit) => {
          if (Exit.isSuccess(exit))
            return exit.value.cacheState === "fresh"
              ? Duration.millis(policy.freshTtl)
              : Duration.zero
          const error = Cause.findError(exit.cause)

          return policy.cacheUserNotFound &&
            Result.isSuccess(error) &&
            error.success instanceof ApiError.UserNotFound
            ? Duration.millis(policy.freshTtl)
            : Duration.zero
        },
      },
    ).pipe(
      Effect.map((cache) =>
        Effect.fn("ActivityCache.lookup")(function* (key: K) {
          yield* cleanup()

          return yield* Cache.get(cache, key)
        }),
      ),
    )

  const latestCommit = yield* makeLookup(latestPolicy, loaders.latestCommit)
  const commits = yield* makeLookup(pagePolicy, loaders.commits)
  const summarize = yield* makeLookup(summaryPolicy, loaders.summarize)
  const streak = yield* makeLookup(streakPolicy, loaders.streak)

  return { latestCommit, commits, summarize, streak }
})

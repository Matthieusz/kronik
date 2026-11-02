export * as UserActivity from "./user-activity.js"

import { ApiError } from "@kronik/contract/errors"
import type {
  ActivitySummary,
  ContributionStreak,
  Cursor,
  LatestCommit,
} from "@kronik/contract/model"
import {
  ActivityWindow,
  CommitPage,
  GitHubUsername,
  IsoDate,
  IsoTimestamp,
} from "@kronik/contract/model"
import { Clock, Context, Effect, Layer, Match, Result, Schema } from "effect"
import { ActivityCache } from "./activity-cache.js"
import type { ActivityStorage } from "./activity-cache.js"
import { ActivityDomain } from "./activity-domain.js"
import { CommitDomain } from "./commit-domain.js"
import type { Interface } from "./cursor.js"
import { Service } from "./cursor.js"
import { GitHub } from "./github.js"
import { StreakDomain } from "./streak-domain.js"

/** Cache provenance returned by the Durable Object coordinator. */
export type CacheState = "fresh" | "stale"

/** An activity result with its coordinator cache provenance preserved. */
export interface LookupResult<A> {
  readonly value: A
  readonly cacheState: CacheState
}

/** The complete Requested User activity interface, including cache provenance. */
export interface CacheAwareInterface {
  /** Resolve the most recently committed matching public commit. */
  readonly latestCommit: (
    username: GitHubUsername,
  ) => Effect.Effect<LookupResult<LatestCommit>, ApiError.DomainErrors>
  /** List matching commits using the v1 cursor contract. */
  readonly commits: (input: {
    readonly username: GitHubUsername
    readonly limit?: number
    readonly cursor?: Cursor
  }) => Effect.Effect<LookupResult<CommitPage>, ApiError.DomainErrors>
  /** Summarize bounded activity over an inclusive Activity Window. */
  readonly summarize: (input: {
    readonly username: GitHubUsername
    readonly from?: IsoDate
    readonly to?: IsoDate
  }) => Effect.Effect<LookupResult<ActivitySummary>, ApiError.DomainErrors>
  /** Calculate the bounded Contribution Streak. */
  readonly streak: (
    username: GitHubUsername,
  ) => Effect.Effect<LookupResult<ContributionStreak>, ApiError.DomainErrors>
}

/** Effect tag for the complete activity interface used by production and tests. */
export class CacheAwareService extends Context.Service<CacheAwareService, CacheAwareInterface>()(
  "@kronik/api/UserActivity.CacheAwareService",
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

const normalizeUsername = Effect.fn("UserActivity.normalizeUsername")(function* (
  username: GitHubUsername,
) {
  return yield* Schema.decodeUnknownEffect(GitHubUsername)(username.toLowerCase()).pipe(
    Effect.mapError(() => invalidRequest("The requested username is not valid")),
  )
})

/** Build one per-user lookup module; its scope owns coalescing caches and persistence policy. */
export const make = Effect.fn("UserActivity.make")(function* (storage: ActivityStorage) {
  const github = yield* GitHub.Service
  const cursor = yield* Service

  const cache = yield* ActivityCache.make(storage, {
    latestCommit: (username) => github.latestCommit(username),
    commits: Effect.fn("UserActivity.loadCommitPage")(function* (key) {
      const request = yield* decodePageKey(key)
      const evidence = yield* github.commits(request)

      return yield* buildCommitPage(cursor, evidence, request)
    }),
    summarize: Effect.fn("UserActivity.loadActivitySummary")(function* (key) {
      const request = yield* decodeActivityKey(key)
      const evidence = yield* github.activity(request)

      return yield* buildActivitySummary(request, evidence)
    }),
    streak: Effect.fn("UserActivity.loadContributionStreak")(function* (key) {
      const request = yield* decodeStreakKey(key)
      const evidence = yield* github.streak(request)

      return yield* buildContributionStreak(request, evidence)
    }),
  })

  return CacheAwareService.of({
    latestCommit: Effect.fn("UserActivity.latestCommit")(function* (username) {
      const normalizedUsername = yield* normalizeUsername(username)

      return yield* cache.latestCommit(normalizedUsername)
    }),
    commits: Effect.fn("UserActivity.commits")(function* (payload) {
      const normalizedUsername = yield* normalizeUsername(payload.username)

      if (payload.cursor !== undefined && payload.limit !== undefined) {
        return yield* Effect.fail(invalidRequest("A cursor cannot be combined with a limit"))
      }

      const cursorPayload =
        payload.cursor === undefined
          ? yield* cursor.initial(normalizedUsername, payload.limit ?? DefaultPageSize)
          : yield* cursor.decode(payload.cursor, normalizedUsername)

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

      return yield* cache.commits(pageKey(request))
    }),
    summarize: Effect.fn("UserActivity.summarize")(function* (payload) {
      const normalizedUsername = yield* normalizeUsername(payload.username)

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

      return yield* cache.summarize(JSON.stringify(request))
    }),
    streak: Effect.fn("UserActivity.streak")(function* (username) {
      const normalizedUsername = yield* normalizeUsername(username)

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

      return yield* cache.streak(JSON.stringify(request))
    }),
  })
})

/** Provide the per-user lookup implementation using the owning storage adapter. */
export const layer = (storage: ActivityStorage) => Layer.effect(CacheAwareService, make(storage))

const buildContributionStreak = Effect.fn("UserActivity.buildContributionStreak")(function* (
  request: typeof StreakRequest.Type,
  evidence: GitHub.StreakEvidence,
) {
  const projected = StreakDomain.calculate(evidence.user, request.from, request.to, evidence.days)

  if (Result.isFailure(projected))
    return yield* Effect.fail(upstreamFailure("GitHub returned a malformed contribution calendar"))

  return projected.success
})

const buildActivitySummary = Effect.fn("UserActivity.buildActivitySummary")(function* (
  window: ActivityWindow,
  evidence: GitHub.ActivityEvidence,
) {
  const projected = ActivityDomain.summarize(window, evidence)

  if (Result.isFailure(projected)) {
    return yield* Effect.fail(upstreamFailure("GitHub returned unsafe activity evidence"))
  }

  return projected.success
})

const buildCommitPage = Effect.fn("UserActivity.buildCommitPage")(function* (
  cursor: Interface,
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

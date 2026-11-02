/* oxlint-disable effecttsgo/strict-effect-provide */
import { describe, expect, test } from "bun:test"
import { ApiError } from "@kronik/contract/errors"
import { Cursor, GitHubUsername, IsoDate, LatestCommit } from "@kronik/contract/model"
import { Effect, Layer, Redacted, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { ActivityStorage } from "../src/activity-cache.js"
import { Service, layerWithSecret } from "../src/cursor.js"
import { GitHub } from "../src/github.js"
import { UserActivity } from "../src/user-activity.js"

const latest = Schema.decodeUnknownSync(LatestCommit)({
  user: {
    login: "CanonicalUser",
    url: "https://github.com/CanonicalUser",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  },
  commit: {
    sha: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/owner/repo/commit/0123456789abcdef0123456789abcdef01234567",
    repository: {
      nameWithOwner: "owner/repo",
      url: "https://github.com/owner/repo",
    },
    headline: "Implement latest commit",
    body: "Details",
    bodyTruncated: false,
    authoredAt: "2026-01-02T03:04:05Z",
    committedAt: "2026-01-02T03:05:06Z",
    additions: 3,
    deletions: 1,
    changedLines: 4,
    parents: [],
  },
})

const username = Schema.decodeUnknownSync(GitHubUsername)("MixedUser")

const from = Schema.decodeUnknownSync(IsoDate)("2025-12-03")

const to = Schema.decodeUnknownSync(IsoDate)("2026-01-01")

const invalidCursor = Schema.decodeUnknownSync(Cursor)("invalid-cursor")

const unused = () => Effect.die("Unexpected GitHub lookup")

const now = Date.parse("2026-01-01T12:00:00Z")

const makeStorage = (): ActivityStorage => {
  const values = new Map<string, unknown>()

  return {
    get: (key) => Effect.sync(() => values.get(key)),
    list: ({ limit, startAfter }) =>
      Effect.sync(
        () =>
          new Map(
            [...values.entries()]
              .toSorted(([a], [b]) => a.localeCompare(b))
              .filter(([key]) => startAfter === undefined || key > startAfter)
              .slice(0, limit),
          ),
      ),
    put: (key, value) => Effect.sync(() => void values.set(key, value)),
    delete: (key) => Effect.sync(() => values.delete(key)),
    deleteMany: (keys) => Effect.sync(() => keys.filter((key) => values.delete(key)).length),
  }
}

describe("Requested User lookup module", () => {
  test("projects and caches all lookups; typed credential rejection forbids stale independently of prose", async () => {
    let failure: GitHub.Failure | undefined
    const requestedUsers: Array<string> = []

    const github: GitHub.Interface = {
      latestCommit: (name) =>
        Effect.suspend(() => {
          requestedUsers.push(name)

          return failure === undefined ? Effect.succeed(latest) : Effect.fail(failure)
        }),
      commits: (input) =>
        Effect.suspend(() => {
          requestedUsers.push(input.username)

          return failure === undefined
            ? Effect.succeed({
                user: latest.user,
                items: [],
                totalCount: 0,
                incompleteResults: false,
              })
            : Effect.fail(failure)
        }),
      activity: (input) =>
        Effect.suspend(() => {
          requestedUsers.push(input.username)

          return failure === undefined
            ? Effect.succeed({
                user: latest.user,
                items: [],
                matchedCommits: 0,
                incompleteResults: false,
                repositories: [],
              })
            : Effect.fail(failure)
        }),
      streak: (input) =>
        Effect.suspend(() => {
          requestedUsers.push(input.username)

          return failure === undefined
            ? Effect.succeed({
                user: latest.user,
                days: Array.from({ length: 365 }, (_, index) => ({
                  date: Schema.decodeUnknownSync(IsoDate)(
                    new Date(Date.parse(`${input.from}T00:00:00Z`) + index * 86_400_000)
                      .toISOString()
                      .slice(0, 10),
                  ),
                  contributionCount: 0,
                })),
              })
            : Effect.fail(failure)
        }),
    }

    const lookupLayer = UserActivity.layer(makeStorage()).pipe(
      Layer.provide(Layer.succeed(GitHub.Service, github)),
      Layer.provideMerge(layerWithSecret(Redacted.make("lookup-test-secret"))),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(now)
          const cursor = yield* Service
          const initial = yield* cursor.initial(username, 10)
          const token = yield* cursor.encode(initial)
          const activity = yield* UserActivity.CacheAwareService

          const lookups: ReadonlyArray<
            Effect.Effect<UserActivity.LookupResult<unknown>, ApiError.DomainErrors>
          > = [
            activity.latestCommit(username),
            activity.commits({ username, cursor: token }),
            activity.summarize({ username, from, to }),
            activity.streak(username),
          ]

          const fresh = yield* Effect.all(lookups)
          expect(fresh.map((result) => result.cacheState)).toEqual([
            "fresh",
            "fresh",
            "fresh",
            "fresh",
          ])
          expect(fresh[1]?.value).toMatchObject({ items: [], next: null, previous: null })
          expect(fresh[2]?.value).toMatchObject({ window: { from, to }, totals: { commits: 0 } })
          expect(fresh[3]?.value).toMatchObject({ currentStreak: 0, longestStreak: 0 })
          expect(requestedUsers).toEqual(["mixeduser", "mixeduser", "mixeduser", "mixeduser"])
          yield* TestClock.setTime(now + 300_001)
          failure = new GitHub.CredentialRejected({})

          for (const lookup of lookups) {
            const result = yield* Effect.result(lookup)
            expect(Result.isFailure(result)).toBe(true)

            if (Result.isFailure(result))
              expect(result.failure).toBeInstanceOf(ApiError.UpstreamFailure)
          }

          failure = new ApiError.UpstreamFailure({
            type: "https://kronik.dev/problems/upstream-failure",
            title: "GitHub unavailable",
            detail: "Kronik's GitHub credential was rejected",
            instance: "urn:test",
            status: 502,
          })
          const stale = yield* Effect.all(lookups)
          expect(stale.map((result) => result.cacheState)).toEqual([
            "stale",
            "stale",
            "stale",
            "stale",
          ])
        }),
      ).pipe(Effect.provide(lookupLayer.pipe(Layer.provideMerge(TestClock.layer())))),
    )
  })

  test("rejects conflicting pagination and invalid windows before fetching evidence", async () => {
    const github: GitHub.Interface = {
      latestCommit: unused,
      commits: unused,
      activity: unused,
      streak: unused,
    }

    const lookupLayer = UserActivity.layer(makeStorage()).pipe(
      Layer.provide(Layer.succeed(GitHub.Service, github)),
      Layer.provideMerge(layerWithSecret(Redacted.make("lookup-test-secret"))),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const activity = yield* UserActivity.CacheAwareService

          const conflict = yield* Effect.result(
            activity
              .commits({
                username,
                cursor: invalidCursor,
                limit: 10,
              })
              .pipe(Effect.asVoid),
          )

          const reversed = yield* Effect.result(
            activity.summarize({ username, from: to, to: from }).pipe(Effect.asVoid),
          )

          for (const result of [conflict, reversed]) {
            expect(Result.isFailure(result)).toBe(true)

            if (Result.isFailure(result))
              expect(result.failure).toBeInstanceOf(ApiError.InvalidRequest)
          }
        }),
      ).pipe(Effect.provide(lookupLayer.pipe(Layer.provideMerge(TestClock.layer())))),
    )
  })
})

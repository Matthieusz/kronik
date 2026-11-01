/* oxlint-disable effecttsgo/strict-effect-provide */

import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { GitHubUsername, LatestCommit } from "@kronik/contract/model"
import { CommitDomain } from "../src/commit-domain.js"
import { activityTestLayer, unusedActivity } from "./activity-rpc-test-layer.js"
import { makeWebHandler } from "../src/http.js"
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

describe("latest commit public route", () => {
  test.each(["fresh", "stale"] as const)(
    "preserves %s provenance through schema-validated RPC",
    async (cacheState) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const activity = yield* UserActivity.CacheAwareService

            const web = yield* makeWebHandler(new URL("https://docs.example.test"), {
              activityCacheService: activity,
            })

            const response = yield* Effect.promise(() =>
              web.handler(
                new Request("https://api.example.test/v1/users/canonicaluser/commits/latest"),
              ),
            )

            return {
              status: response.status,
              body: yield* Effect.promise(() => response.json()),
              cache: response.headers.get("x-kronik-cache"),
              warning: response.headers.get("warning"),
            }
          }).pipe(
            Effect.provide(
              activityTestLayer({
                ...unusedActivity,
                latestCommit: () => Effect.succeed({ value: latest, cacheState }),
              }),
            ),
          ),
        ),
      )

      expect(result.status).toBe(200)
      expect(result.body).toEqual(latest)
      expect(result.cache).toBe(cacheState === "stale" ? "stale" : "miss")
      expect(result.warning).toBe(cacheState === "stale" ? '110 - "Response is stale"' : null)
    },
  )

  test("rejects an invalid result at the serialized RPC seam", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const activity = yield* UserActivity.CacheAwareService
          const username = yield* Schema.decodeUnknownEffect(GitHubUsername)("canonicaluser")

          return yield* Effect.exit(activity.latestCommit(username))
        }).pipe(
          Effect.provide(
            activityTestLayer({
              ...unusedActivity,
              latestCommit: () =>
                Effect.succeed({
                  value: {
                    ...latest,
                    commit: { ...latest.commit, additions: -1 },
                  },
                  cacheState: "fresh",
                }),
            }),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
  })

  test("bounds UTF-8 messages without splitting Unicode", () => {
    const body = "🙂".repeat(5000)
    const bounded = CommitDomain.truncateUtf8(body)

    expect(bounded.truncated).toBe(true)
    expect(new TextEncoder().encode(bounded.value).length).toBeLessThanOrEqual(8192)
    expect(Array.from(bounded.value).every((character) => character !== "\ud800")).toBe(true)
  })
})

/* oxlint-disable effecttsgo/strict-effect-provide */

import { describe, expect, test } from "bun:test"
import { ActivitySummary } from "@kronik/contract/model"
import { Effect, Schema } from "effect"
import { activityTestLayer, unusedActivity } from "./activity-rpc-test-layer.js"
import { makeWebHandler } from "../src/http.js"
import { UserActivity } from "../src/user-activity.js"

const summary = Schema.decodeUnknownSync(ActivitySummary)({
  user: {
    login: "CanonicalUser",
    url: "https://github.com/CanonicalUser",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  },
  window: { from: "2024-02-01", to: "2024-03-01" },
  coverage: { complete: true, matchedCommits: 0, aggregatedCommits: 0 },
  totals: { commits: 0, additions: 0, deletions: 0, changedLines: 0 },
  languages: [],
  otherBytes: 0,
})

describe("activity summary public route", () => {
  test.each(["fresh", "stale"] as const)(
    "passes inclusive bounds and %s provenance through schema-validated RPC",
    async (cacheState) => {
      const inputs: Array<unknown> = []

      const service: UserActivity.CacheAwareInterface = {
        ...unusedActivity,
        summarize: (input) => {
          inputs.push(input)

          return Effect.succeed({ value: summary, cacheState })
        },
      }

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const activity = yield* UserActivity.CacheAwareService

            const web = yield* makeWebHandler(new URL("https://docs.example.test"), {
              activityCacheService: activity,
            })

            const response = yield* Effect.promise(() =>
              web.handler(
                new Request(
                  "https://api.example.test/v1/users/MixedUser/activity?from=2024-02-01&to=2024-03-01",
                ),
              ),
            )

            return {
              status: response.status,
              body: yield* Effect.promise(() => response.json()),
              cache: response.headers.get("x-kronik-cache"),
              warning: response.headers.get("warning"),
            }
          }).pipe(Effect.provide(activityTestLayer(service))),
        ),
      )

      expect(result.status).toBe(200)
      expect(result.body).toEqual(summary)
      expect(result.cache).toBe(cacheState === "stale" ? "stale" : "miss")
      expect(result.warning).toBe(cacheState === "stale" ? '110 - "Response is stale"' : null)
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({
        username: "MixedUser",
        from: "2024-02-01",
        to: "2024-03-01",
      })
    },
  )
})

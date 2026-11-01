/* oxlint-disable effecttsgo/strict-effect-provide */

import { describe, expect, test } from "bun:test"
import { ContributionStreak } from "@kronik/contract/model"
import { Effect, Schema } from "effect"
import { activityTestLayer, unusedActivity } from "./activity-rpc-test-layer.js"
import { makeWebHandler } from "../src/http.js"
import { UserActivity } from "../src/user-activity.js"

const streak = Schema.decodeUnknownSync(ContributionStreak)({
  user: {
    login: "CanonicalUser",
    url: "https://github.com/CanonicalUser",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  },
  from: "2024-01-01",
  to: "2024-12-30",
  currentStreak: 2,
  longestStreak: 8,
  active: true,
})

describe("contribution streak public route", () => {
  test.each(["fresh", "stale"] as const)(
    "preserves %s provenance through schema-validated RPC",
    async (cacheState) => {
      const inputs: Array<unknown> = []

      const service: UserActivity.CacheAwareInterface = {
        ...unusedActivity,
        streak: (username) => {
          inputs.push(username)

          return Effect.succeed({ value: streak, cacheState })
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
              web.handler(new Request("https://api.example.test/v1/users/MixedUser/streak")),
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
      expect(result.body).toEqual(streak)
      expect(result.cache).toBe(cacheState === "stale" ? "stale" : "miss")
      expect(result.warning).toBe(cacheState === "stale" ? '110 - "Response is stale"' : null)
      expect(inputs).toEqual(["MixedUser"])
    },
  )
})

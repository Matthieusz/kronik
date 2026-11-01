/* oxlint-disable effecttsgo/strict-effect-provide */

import { describe, expect, test } from "bun:test"
import { CommitPage, Cursor } from "@kronik/contract/model"
import { Effect, Schema } from "effect"
import { activityTestLayer, unusedActivity } from "./activity-rpc-test-layer.js"
import { makeWebHandler } from "../src/http.js"
import { UserActivity } from "../src/user-activity.js"

const page = Schema.decodeUnknownSync(CommitPage)({
  user: {
    login: "CanonicalUser",
    url: "https://github.com/CanonicalUser",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  },
  items: [],
  previous: null,
  next: "opaque-next-cursor",
})

const runRoute = async (url: string, service: UserActivity.CacheAwareInterface) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const activity = yield* UserActivity.CacheAwareService

        const web = yield* makeWebHandler(new URL("https://docs.example.test"), {
          activityCacheService: activity,
        })

        const response = yield* Effect.promise(() => web.handler(new Request(url)))

        return {
          status: response.status,
          body: yield* Effect.promise(() => response.json()),
          cache: response.headers.get("x-kronik-cache"),
          warning: response.headers.get("warning"),
        }
      }).pipe(Effect.provide(activityTestLayer(service))),
    ),
  )

describe("paginated commits public route", () => {
  test.each(["fresh", "stale"] as const)(
    "supports query modes with %s provenance",
    async (cacheState) => {
      const inputs: Array<unknown> = []

      const service: UserActivity.CacheAwareInterface = {
        ...unusedActivity,
        commits: (input) => {
          inputs.push(input)

          return Effect.succeed({ value: page, cacheState })
        },
      }

      const initial = await runRoute("https://api.example.test/v1/users/MixedUser/commits", service)

      const custom = await runRoute(
        "https://api.example.test/v1/users/MixedUser/commits?limit=25",
        service,
      )

      const continuation = await runRoute(
        "https://api.example.test/v1/users/MixedUser/commits?cursor=opaque-next-cursor",
        service,
      )

      expect(initial.status).toBe(200)
      expect(custom.status).toBe(200)
      expect(continuation.status).toBe(200)

      for (const response of [initial, custom, continuation]) {
        expect(response.body).toEqual(page)
        expect(response.cache).toBe(cacheState === "stale" ? "stale" : "miss")
        expect(response.warning).toBe(cacheState === "stale" ? '110 - "Response is stale"' : null)
      }

      expect(inputs).toEqual([
        { username: "MixedUser" },
        { username: "MixedUser", limit: 25 },
        {
          username: "MixedUser",
          cursor: Schema.decodeUnknownSync(Cursor)("opaque-next-cursor"),
        },
      ])
    },
  )

  test("rejects a cursor combined with a limit", async () => {
    const result = await runRoute(
      "https://api.example.test/v1/users/MixedUser/commits?limit=25&cursor=opaque-next-cursor",
      {
        ...unusedActivity,
        commits: () => Effect.succeed({ value: page, cacheState: "fresh" }),
      },
    )

    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({
      type: "https://kronik.dev/problems/invalid-request",
      status: 400,
    })
    expect(result.body).not.toHaveProperty("_tag")
  })
})

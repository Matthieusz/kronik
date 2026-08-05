import { describe, expect, test } from "bun:test"
import { ContributionStreak } from "@kronik/contract/model"
import { Effect, Schema } from "effect"
import * as ActivityRpcClient from "../src/activity-rpc.js"
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
  test("delegates through the schema-aware RPC client", async () => {
    const inputs: Array<unknown> = []
    const service: UserActivity.StreakInterface = {
      latestCommit: () => Effect.die("not used"),
      commits: () => Effect.die("not used"),
      summarize: () => Effect.die("not used"),
      streak: (username) => {
        inputs.push(username)
        return Effect.succeed(streak)
      },
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const activity = yield* UserActivity.StreakService
          const web = yield* makeWebHandler(new URL("https://docs.example.test"), {
            streakService: activity,
          })
          const response = yield* Effect.promise(() =>
            web.handler(new Request("https://api.example.test/v1/users/MixedUser/streak")),
          )
          return {
            status: response.status,
            body: yield* Effect.promise(() => response.json()),
          }
        }).pipe(Effect.provide(ActivityRpcClient.streakTestLayer(service))),
      ),
    )

    expect(result.status).toBe(200)
    expect(result.body).toEqual(streak)
    expect(inputs).toEqual(["MixedUser"])
  })
})

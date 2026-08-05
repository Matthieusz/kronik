import { describe, expect, test } from "bun:test"
import { ActivitySummary } from "@kronik/contract/model"
import { Effect, Schema } from "effect"
import * as ActivityRpcClient from "../src/activity-rpc.js"
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
  test("passes inclusive bounds through the schema-aware RPC client", async () => {
    const inputs: Array<unknown> = []
    const service: UserActivity.SummaryInterface = {
      latestCommit: () => Effect.die("not used"),
      commits: () => Effect.die("not used"),
      summarize: (input) => {
        inputs.push(input)
        return Effect.succeed(summary)
      },
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const activity = yield* UserActivity.SummaryService
          const web = yield* makeWebHandler(new URL("https://docs.example.test"), {
            summaryService: activity,
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
          }
        }).pipe(Effect.provide(ActivityRpcClient.summaryTestLayer(service))),
      ),
    )

    expect(result.status).toBe(200)
    expect(result.body).toEqual(summary)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ username: "MixedUser", from: "2024-02-01", to: "2024-03-01" })
  })
})

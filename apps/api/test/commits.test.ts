import { describe, expect, test } from "bun:test"
import { CommitPage, Cursor, LatestCommit } from "@kronik/contract/model"
import { Effect, Schema } from "effect"
import * as ActivityRpcClient from "../src/activity-rpc.js"
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
const latest = Schema.decodeUnknownSync(LatestCommit)({
  user: page.user,
  commit: {
    sha: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/owner/repo/commit/0123456789abcdef0123456789abcdef01234567",
    repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" },
    headline: "Commit",
    body: "",
    bodyTruncated: false,
    authoredAt: "2026-01-02T03:04:05Z",
    committedAt: "2026-01-02T03:05:06Z",
    additions: 1,
    deletions: 0,
    changedLines: 1,
    parents: [],
  },
})

const runRoute = async (url: string, service: UserActivity.CommitsInterface) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const activity = yield* UserActivity.CommitsService
        const web = yield* makeWebHandler(new URL("https://docs.example.test"), {
          commitsService: activity,
        })
        const response = yield* Effect.promise(() => web.handler(new Request(url)))
        return { status: response.status, body: yield* Effect.promise(() => response.json()) }
      }).pipe(Effect.provide(ActivityRpcClient.commitsTestLayer(service))),
    ),
  )

describe("paginated commits public route", () => {
  test("supports initial, default, and continuation query modes", async () => {
    const inputs: Array<unknown> = []
    const service: UserActivity.CommitsInterface = {
      latestCommit: () => Effect.succeed(latest),
      commits: (input) => {
        inputs.push(input)
        return Effect.succeed(page)
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
    expect(inputs).toEqual([
      { username: "MixedUser" },
      { username: "MixedUser", limit: 25 },
      {
        username: "MixedUser",
        cursor: Schema.decodeUnknownSync(Cursor)("opaque-next-cursor"),
      },
    ])
  })

  test("rejects a cursor combined with a limit", async () => {
    const result = await runRoute(
      "https://api.example.test/v1/users/MixedUser/commits?limit=25&cursor=opaque-next-cursor",
      {
        latestCommit: () => Effect.succeed(latest),
        commits: () => Effect.succeed(page),
      },
    )

    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({
      type: "https://kronik.dev/problems/invalid-request",
      status: 400,
    })
    expect(result.body._tag).toBeUndefined()
  })
})

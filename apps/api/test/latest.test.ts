import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { LatestCommit } from "@kronik/contract/model"
import { CommitDomain } from "../src/commit-domain.js"
import * as ActivityRpcClient from "../src/activity-rpc.js"
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
  test("delegates through the schema-aware RPC client", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const latestService = yield* UserActivity.LatestService
          const web = yield* makeWebHandler(new URL("https://docs.example.test"), {
            latestService,
          })
          const response = yield* Effect.promise(() =>
            web.handler(
              new Request("https://api.example.test/v1/users/canonicaluser/commits/latest"),
            ),
          )
          return {
            status: response.status,
            body: yield* Effect.promise(() => response.json()),
          }
        }).pipe(
          Effect.provide(
            ActivityRpcClient.testLayer({
              latestCommit: () => Effect.succeed(latest),
            }),
          ),
        ),
      ),
    )

    expect(result.status).toBe(200)
    expect(result.body).toEqual(latest)
  })

  test("bounds UTF-8 messages without splitting Unicode", () => {
    const body = "🙂".repeat(5000)
    const bounded = CommitDomain.truncateUtf8(body)

    expect(bounded.truncated).toBe(true)
    expect(new TextEncoder().encode(bounded.value).length).toBeLessThanOrEqual(8192)
    expect(Array.from(bounded.value).every((character) => character !== "\ud800")).toBe(true)
  })
})

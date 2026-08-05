import { describe, expect, test } from "bun:test"
import { ApiError } from "@kronik/contract/errors"
import { Effect } from "effect"
import { makeWebHandler } from "../src/http.js"
import { UserActivity } from "../src/user-activity.js"

const problem = (kind: string): ApiError.DomainErrors => {
  if (kind === "InvalidRequest")
    return new ApiError.InvalidRequest({
      type: "https://kronik.dev/problems/invalid-request",
      title: "Invalid request",
      detail: "The request is invalid",
      instance: "urn:kronik:test",
      status: 400,
    })
  if (kind === "InvalidCursor")
    return new ApiError.InvalidCursor({
      type: "https://kronik.dev/problems/invalid-cursor",
      title: "Invalid cursor",
      detail: "The cursor is invalid",
      instance: "urn:kronik:test",
      status: 400,
    })
  if (kind === "UserNotFound")
    return new ApiError.UserNotFound({
      type: "https://kronik.dev/problems/user-not-found",
      title: "User not found",
      detail: "The user is not found",
      instance: "urn:kronik:test",
      status: 404,
    })
  if (kind === "LatestCommitNotFound")
    return new ApiError.LatestCommitNotFound({
      type: "https://kronik.dev/problems/latest-commit-not-found",
      title: "Latest commit not found",
      detail: "No matching commit exists",
      instance: "urn:kronik:test",
      status: 404,
    })
  if (kind === "RateLimited")
    return new ApiError.RateLimited({
      type: "https://kronik.dev/problems/rate-limited",
      title: "Rate limited",
      detail: "The upstream budget is exhausted",
      instance: "urn:kronik:test",
      status: 429,
      retryAfterSeconds: 17,
    })
  if (kind === "UpstreamFailure")
    return new ApiError.UpstreamFailure({
      type: "https://kronik.dev/problems/upstream-failure",
      title: "Upstream failure",
      detail: "The upstream failed",
      instance: "urn:kronik:test",
      status: 502,
    })
  return new ApiError.ServiceUnavailable({
    type: "https://kronik.dev/problems/service-unavailable",
    title: "Service unavailable",
    detail: "The service timed out",
    instance: "urn:kronik:test",
    status: 503,
  })
}

const failingService = (error: ApiError.DomainErrors): UserActivity.Interface => ({
  latestCommit: () => Effect.fail(error),
  commits: () => Effect.fail(error),
  summarize: () => Effect.fail(error),
  streak: () => Effect.fail(error),
})

const routes = ["commits/latest", "commits", "activity", "streak"] as const

const problems = [
  ["InvalidRequest", 400],
  ["InvalidCursor", 400],
  ["UserNotFound", 404],
  ["LatestCommitNotFound", 404],
  ["RateLimited", 429],
  ["UpstreamFailure", 502],
  ["ServiceUnavailable", 503],
] as const

describe("public problem projection", () => {
  test("projects every declared problem on every activity route", async () => {
    for (const [kind, status] of problems) {
      const web = await Effect.runPromise(
        Effect.scoped(
          makeWebHandler(new URL("https://docs.example.test"), {
            activityService: failingService(problem(kind)),
            requestId: () => "problem-test",
          }),
        ),
      )
      for (const route of routes) {
        const response = await web.handler(
          new Request(`https://api.example.test/v1/users/MixedUser/${route}`),
        )
        const body = await response.json()

        expect(response.status).toBe(status)
        expect(response.headers.get("content-type")).toContain("application/problem+json")
        expect(body).toMatchObject({
          type: `https://kronik.dev/problems/${kind
            .replace("InvalidRequest", "invalid-request")
            .replace("InvalidCursor", "invalid-cursor")
            .replace("UserNotFound", "user-not-found")
            .replace("LatestCommitNotFound", "latest-commit-not-found")
            .replace("RateLimited", "rate-limited")
            .replace("UpstreamFailure", "upstream-failure")
            .replace("ServiceUnavailable", "service-unavailable")}`,
          status,
          instance: "urn:kronik:request:problem-test",
        })
        expect(Reflect.get(body, "_tag")).toBeUndefined()
      }
      await web.dispose()
    }
  })
})

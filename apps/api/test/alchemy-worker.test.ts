import { expect } from "bun:test"
import { providers } from "alchemy/Cloudflare"
import { make } from "alchemy/Test/Bun"
import { Effect } from "effect"
import KronikRuntimeVerification from "./alchemy-runtime.fixture.js"

const sha = "0123456789abcdef0123456789abcdef01234567"
let fakeGitHubRequests = 0
const fakeGitHub = Bun.serve({
  hostname: "127.0.0.1",
  port: 43119,
  fetch(request) {
    fakeGitHubRequests += 1
    const url = new URL(request.url)
    if (url.pathname === "/users/mixeduser")
      return Response.json({
        login: "MixedUser",
        html_url: "https://github.com/MixedUser",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
      })
    if (url.pathname === "/search/commits")
      return Response.json({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            sha,
            html_url: `https://github.com/owner/repo/commit/${sha}`,
            repository: {
              full_name: "owner/repo",
              html_url: "https://github.com/owner/repo",
            },
            author: { login: "MixedUser" },
          },
        ],
      })
    if (url.pathname === `/repos/owner/repo/commits/${sha}`)
      return Response.json({
        sha,
        html_url: `https://github.com/owner/repo/commit/${sha}`,
        repository: {
          full_name: "owner/repo",
          html_url: "https://github.com/owner/repo",
        },
        commit: {
          message: "Initialized Worker integration",
          author: { date: "2026-01-01T10:00:00Z" },
          committer: { date: "2026-01-01T11:00:00Z" },
        },
        stats: { additions: 3, deletions: 1 },
        parents: [],
      })
    return Response.json({ message: "Not Found" }, { status: 404 })
  },
})

const { afterAll, beforeAll, deploy, destroy, test } = make({
  providers: providers(),
  dev: true,
  stage: `runtime-test-${process.pid}`,
})
const worker = beforeAll(deploy(KronikRuntimeVerification))
afterAll(destroy(KronikRuntimeVerification))
afterAll(Effect.promise(() => fakeGitHub.stop(true)))

const workerUrl = Effect.fn("AlchemyWorkerTest.workerUrl")(function* (path: string) {
  const deployed = yield* worker
  if (deployed.api === undefined) return yield* Effect.die("Alchemy Worker has no local URL")
  return new URL(path, deployed.api)
})

test(
  "initialized Alchemy Worker serves activity through its real Durable Object namespace",
  Effect.gen(function* () {
    const url = yield* workerUrl("/v1/users/MixedUser/commits/latest")
    const response = yield* Effect.promise(() =>
      fetch(url, { headers: { "cf-connecting-ip": "192.0.2.1" } }),
    )
    const body = yield* Effect.promise(() => response.json())

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ user: { login: "MixedUser" } })
    expect(fakeGitHubRequests).toBe(3)
  }),
  { timeout: 120_000 },
)

test(
  "initialized Alchemy Worker enforces its real Rate Limit binding",
  Effect.gen(function* () {
    const url = yield* workerUrl("/health")
    const responses = yield* Effect.promise(() =>
      Promise.all(
        Array.from({ length: 61 }, () =>
          fetch(url, { headers: { "cf-connecting-ip": "192.0.2.2" } }),
        ),
      ),
    )

    expect(responses.filter((response) => response.status === 200)).toHaveLength(60)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1)
  }),
  { timeout: 120_000 },
)

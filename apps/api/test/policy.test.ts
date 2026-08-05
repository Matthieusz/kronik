import { describe, expect, test } from "bun:test"
import {
  ActivitySummary,
  CommitPage,
  ContributionStreak,
  LatestCommit,
} from "@kronik/contract/model"
import { Effect, Schema } from "effect"
import { makeHttpEffect, makeMemoryEdgeCache, makeWebHandler } from "../src/http.js"
import { makeWorkerResponse } from "../src/worker.js"
import { Observability } from "../src/observability.js"

const latest = Schema.decodeUnknownSync(LatestCommit)({
  user: {
    login: "CanonicalUser",
    url: "https://github.com/CanonicalUser",
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  },
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
const page = Schema.decodeUnknownSync(CommitPage)({
  user: latest.user,
  items: [],
  previous: null,
  next: null,
})
const summary = Schema.decodeUnknownSync(ActivitySummary)({
  user: latest.user,
  window: { from: "2026-01-01", to: "2026-01-30" },
  coverage: { complete: true, matchedCommits: 0, aggregatedCommits: 0 },
  totals: { commits: 0, additions: 0, deletions: 0, changedLines: 0 },
  languages: [],
  otherBytes: 0,
})
const streak = Schema.decodeUnknownSync(ContributionStreak)({
  user: latest.user,
  from: "2025-01-02",
  to: "2026-01-01",
  currentStreak: 0,
  longestStreak: 0,
  active: false,
})

describe("public edge policy", () => {
  test("uses the initialized Worker policy composition", async () => {
    const httpEffect = await Effect.runPromise(
      Effect.scoped(
        makeHttpEffect(new URL("https://docs.example.test"), {
          latestService: { latestCommit: () => Effect.succeed(latest) },
        }),
      ),
    )
    const events: Array<Observability.Event> = []
    const response = await makeWorkerResponse(
      new Request("https://api.example.test/health"),
      httpEffect,
      true,
      { record: (event) => void events.push(event) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("x-request-id")).toBeTruthy()
    expect(events[0]).toMatchObject({ kind: "http.request", route: "health", status: 200 })
  })

  test("applies CORS, request IDs, HEAD, and preflight consistently", async () => {
    const web = await Effect.runPromise(
      Effect.scoped(
        makeWebHandler(new URL("https://docs.example.test"), {
          requestId: () => "generated-id",
        }),
      ),
    )
    const options = await web.handler(
      new Request("https://api.example.test/health", { method: "OPTIONS" }),
    )
    const head = await web.handler(
      new Request("https://api.example.test/health", {
        method: "HEAD",
        headers: { "x-request-id": "caller-id" },
      }),
    )

    expect(options.status).toBe(204)
    expect(options.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS")
    expect(head.status).toBe(200)
    expect(head.headers.get("x-request-id")).toBe("caller-id")
    expect(head.headers.get("access-control-allow-origin")).toBe("*")
    expect(await head.text()).toBe("")
    await web.dispose()
  })

  test("releases request-scoped activity resources when the response completes", async () => {
    let releases = 0
    const web = await Effect.runPromise(
      Effect.scoped(
        makeWebHandler(new URL("https://docs.example.test"), {
          activityService: {
            latestCommit: () =>
              Effect.scoped(
                Effect.acquireRelease(Effect.succeed(latest), () =>
                  Effect.sync(() => {
                    releases += 1
                  }),
                ),
              ),
            commits: () => Effect.die("not used"),
            summarize: () => Effect.die("not used"),
            streak: () => Effect.die("not used"),
          },
        }),
      ),
    )

    const response = await web.handler(
      new Request("https://api.example.test/v1/users/MixedUser/commits/latest"),
    )

    expect(response.status).toBe(200)
    expect(releases).toBe(1)
    await web.dispose()
  })

  test("interrupts an already-cancelled request before cold work starts", async () => {
    let calls = 0
    const web = await Effect.runPromise(
      Effect.scoped(
        makeWebHandler(new URL("https://docs.example.test"), {
          latestService: {
            latestCommit: () => {
              calls += 1
              return Effect.succeed(latest)
            },
          },
        }),
      ),
    )
    const controller = new AbortController()
    controller.abort()

    const cancelled = await web
      .handler(
        new Request("https://api.example.test/v1/users/MixedUser/commits/latest", {
          signal: controller.signal,
        }),
      )
      .then(
        () => false,
        () => true,
      )
    expect(cancelled).toBe(true)
    expect(calls).toBe(0)
    await web.dispose()
  })

  test("emits only bounded safe request telemetry", async () => {
    const events: Array<Observability.Event> = []
    const web = await Effect.runPromise(
      Effect.scoped(
        makeWebHandler(new URL("https://docs.example.test"), {
          latestService: { latestCommit: () => Effect.succeed(latest) },
          observability: {
            record: (event) => {
              events.push(event)
            },
          },
          requestId: () => "observability-test",
        }),
      ),
    )
    const response = await web.handler(
      new Request(
        "https://api.example.test/v1/users/MixedUser/commits/latest?cursor=secret-cursor",
        {
          headers: {
            authorization: "Bearer secret-token",
            "cf-connecting-ip": "203.0.113.10",
          },
        },
      ),
    )

    expect(response.status).toBe(200)
    expect(events).toEqual([
      {
        kind: "http.request",
        requestId: "observability-test",
        route: "latestCommit",
        canonicalUsername: "CanonicalUser",
        cacheOutcome: "miss",
        latencyMs: expect.any(Number),
        status: 200,
      },
    ])
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("secret-cursor")
    expect(serialized).not.toContain("secret-token")
    expect(serialized).not.toContain("203.0.113.10")
    expect(serialized).not.toContain("Implement latest")
    await web.dispose()
  })

  test("rate limits every request and fails open on binding failure", async () => {
    let calls = 0
    const events: Array<Observability.Event> = []
    const web = await Effect.runPromise(
      Effect.scoped(
        makeWebHandler(new URL("https://docs.example.test"), {
          rateLimiter: {
            check: async () => {
              calls += 1
              if (calls === 3) throw new Error("binding unavailable")
              return calls !== 1
            },
          },
          requestId: () => "rate-test",
          observability: {
            record: (event) => {
              events.push(event)
            },
          },
        }),
      ),
    )
    const denied = await web.handler(new Request("https://api.example.test/health"))
    const allowed = await web.handler(new Request("https://api.example.test/health"))
    const failOpen = await web.handler(new Request("https://api.example.test/health"))

    expect(denied.status).toBe(429)
    expect(denied.headers.get("retry-after")).toBe("60")
    expect(allowed.status).toBe(200)
    expect(failOpen.status).toBe(200)
    expect(calls).toBe(3)
    expect(events[0]).toMatchObject({
      kind: "http.request",
      status: 429,
      expectedErrorTag: "RateLimited",
    })
    await web.dispose()
  })

  test("uses the declared edge TTL for every activity capability", async () => {
    let now = 0
    const web = await Effect.runPromise(
      Effect.scoped(
        makeWebHandler(new URL("https://docs.example.test"), {
          activityService: {
            latestCommit: () => Effect.succeed(latest),
            commits: () => Effect.succeed(page),
            summarize: () => Effect.succeed(summary),
            streak: () => Effect.succeed(streak),
          },
          edgeCache: makeMemoryEdgeCache(() => now),
          requestId: () => "ttl-test",
        }),
      ),
    )

    const responses = await Promise.all(
      ["commits/latest", "commits", "activity", "streak"].map((path) =>
        web.handler(new Request(`https://api.example.test/v1/users/MixedUser/${path}`)),
      ),
    )

    expect(responses.map((response) => response.headers.get("cache-control"))).toEqual([
      "public, max-age=60, stale-while-revalidate=3600",
      "public, max-age=60, stale-while-revalidate=3600",
      "public, max-age=300, stale-while-revalidate=3600",
      "public, max-age=300, stale-while-revalidate=3600",
    ])
    expect(responses.every((response) => response.headers.get("age") === "0")).toBe(true)
    now = 301_000
    const stale = await web.handler(
      new Request("https://api.example.test/v1/users/MixedUser/activity"),
    )
    expect(stale.headers.get("x-kronik-cache")).toBe("stale")
    expect(stale.headers.get("age")).toBe("301")
    await web.dispose()
  })

  test("normalizes edge keys and honors ETags without another activity lookup", async () => {
    let calls = 0
    let now = 0
    const events: Array<Observability.Event> = []
    const web = await Effect.runPromise(
      Effect.scoped(
        makeWebHandler(new URL("https://docs.example.test"), {
          latestService: {
            latestCommit: () => {
              calls += 1
              return Effect.succeed(latest)
            },
          },
          edgeCache: makeMemoryEdgeCache(() => now),
          requestId: () => "cache-test",
          observability: {
            record: (event) => {
              events.push(event)
            },
          },
        }),
      ),
    )
    const first = await web.handler(
      new Request("https://api.example.test/v1/users/MixedUser/commits/latest"),
    )
    const second = await web.handler(
      new Request("https://api.example.test/v1/users/mixeduser/commits/latest"),
    )
    const notModified = await web.handler(
      new Request("https://api.example.test/v1/users/MIXEDUSER/commits/latest", {
        headers: { "if-none-match": first.headers.get("etag") ?? "" },
      }),
    )

    now = 61_000
    const stale = await web.handler(
      new Request("https://api.example.test/v1/users/mixeduser/commits/latest"),
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.headers.get("x-kronik-cache")).toBe("hit")
    expect(notModified.status).toBe(304)
    expect(stale.headers.get("x-kronik-cache")).toBe("stale")
    expect(events.at(-1)).toMatchObject({
      kind: "http.request",
      canonicalUsername: "CanonicalUser",
      cacheOutcome: "stale",
      staleAgeSeconds: 61,
    })
    expect(calls).toBe(1)
    await web.dispose()
  })
})

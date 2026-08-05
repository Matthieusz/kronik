import { beforeEach, describe, expect, test } from "bun:test"
import { GitHubUsername } from "@kronik/contract/model"
import { Clock, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { Cursor } from "../src/cursor.js"

const username = Schema.decodeUnknownSync(GitHubUsername)("MixedUser")
let now = 1_735_776_000_000

const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.sync(() => now),
  monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  sleep: () => Effect.void,
}

const cursorLayer = Cursor.layerWithSecret(Redacted.make("test-cursor-secret")).pipe(
  Layer.provide(Layer.succeed(Clock.Clock, clock)),
)

describe("commit cursor authority", () => {
  beforeEach(() => {
    now = 1_735_776_000_000
  })
  test("round-trips authenticated, user-bound navigation state", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Cursor.Service
        const initial = yield* service.initial(username, 10)
        const value = yield* service.encode(initial)
        const decoded = yield* service.decode(value, username, "forward")
        return { value, decoded }
      }).pipe(Effect.provide(cursorLayer)),
    )

    expect(result.value).toContain(".")
    expect(String(result.decoded.username)).toBe("mixeduser")
    expect(result.decoded.pageSize).toBe(10)
  })

  test("rejects tampering, another user, and the wrong direction", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Cursor.Service
        const initial = yield* service.initial(username, 10)
        const value = yield* service.encode(initial)
        const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`
        const otherUsername = Schema.decodeUnknownSync(GitHubUsername)("otheruser")
        const altered = yield* Effect.exit(service.decode(tampered, username))
        const otherUser = yield* Effect.exit(service.decode(value, otherUsername))
        const wrongDirection = yield* Effect.exit(service.decode(value, username, "backward"))
        return { altered, otherUser, wrongDirection }
      }).pipe(Effect.provide(cursorLayer)),
    )

    expect(Exit.isFailure(result.altered)).toBe(true)
    expect(Exit.isFailure(result.otherUser)).toBe(true)
    expect(Exit.isFailure(result.wrongDirection)).toBe(true)
  })

  test("supports the final searchable position for a one-item page", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Cursor.Service
        const initial = yield* service.initial(username, 1)
        const final = Cursor.Payload.make({
          version: initial.version,
          username: initial.username,
          snapshot: initial.snapshot,
          pageSize: initial.pageSize,
          position: 1_000,
          direction: initial.direction,
        })
        const value = yield* service.encode(final)
        return yield* service.decode(value, username)
      }).pipe(Effect.provide(cursorLayer)),
    )

    expect(result.position).toBe(1_000)
  })

  test("expires after one hour", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Cursor.Service
        const initial = yield* service.initial(username, 10)
        const value = yield* service.encode(initial)
        now += 60 * 60 * 1000 + 1
        return yield* Effect.exit(service.decode(value, username))
      }).pipe(Effect.provide(cursorLayer)),
    )

    expect(Exit.isFailure(result)).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { StreakEndpoint, StreakApi } from "../src/api.js"
import { ContributionStreak } from "../src/model.js"
import { StreakPayload, StreakRpcs } from "../src/rpc.js"

describe("contribution streak contract", () => {
  test("declares the public route and full slice API", () => {
    expect(StreakEndpoint.path).toBe("/v1/users/:username/streak")
    expect(StreakApi.groups.streakActivity.identifier).toBe("streakActivity")
  })

  test("requires a 365-day range and derives active from current streak", () => {
    const procedure = StreakRpcs.requests.get("streak")
    if (procedure === undefined) throw new Error("streak RPC is not declared")

    const payload = Schema.decodeUnknownResult(procedure.payloadSchema)({ username: "OctoCat" })
    const valid = Schema.decodeUnknownResult(ContributionStreak)({
      user: {
        login: "OctoCat",
        url: "https://github.com/OctoCat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
      },
      from: "2024-01-01",
      to: "2024-12-30",
      currentStreak: 0,
      longestStreak: 0,
      active: false,
    })
    const invalidRange = Schema.decodeUnknownResult(ContributionStreak)({
      user: {
        login: "OctoCat",
        url: "https://github.com/OctoCat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
      },
      from: "2024-01-01",
      to: "2024-01-01",
      currentStreak: 1,
      longestStreak: 1,
      active: true,
    })
    const invalidActive = Schema.decodeUnknownResult(ContributionStreak)({
      user: {
        login: "OctoCat",
        url: "https://github.com/OctoCat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
      },
      from: "2024-01-01",
      to: "2024-12-30",
      currentStreak: 0,
      longestStreak: 1,
      active: true,
    })

    expect(Result.isSuccess(payload)).toBe(true)
    expect(Result.isSuccess(valid)).toBe(true)
    expect(Result.isFailure(invalidRange)).toBe(true)
    expect(Result.isFailure(invalidActive)).toBe(true)
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(StreakPayload)({ username: "OctoCat" })),
    ).toBe(true)
  })
})

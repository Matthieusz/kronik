import { describe, expect, test } from "bun:test"
import { IsoDate, User } from "@kronik/contract/model"
import { Result, Schema } from "effect"
import { StreakDomain } from "../src/streak-domain.js"

const user = Schema.decodeUnknownSync(User)({
  login: "Octocat",
  url: "https://github.com/Octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/1",
})
const start = Schema.decodeUnknownSync(IsoDate)("2024-01-01")
const end = Schema.decodeUnknownSync(IsoDate)("2024-12-30")

const calendar = (counts: Readonly<Record<number, number>> = {}) =>
  Array.from({ length: 365 }, (_, index) => {
    const date = Schema.decodeUnknownSync(IsoDate)(
      new Date(Date.parse(`${String(start)}T00:00:00Z`) + index * 86_400_000)
        .toISOString()
        .slice(0, 10),
    )
    return { date, contributionCount: counts[index] ?? 0 }
  })

describe("contribution streak domain", () => {
  test("resolves a trailing 365-day UTC range across a leap day and year boundary", () => {
    const result = StreakDomain.resolveRange(Date.parse("2025-01-01T23:00:00Z"))

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(String(result.success.from)).toBe("2024-01-03")
      expect(String(result.success.to)).toBe("2025-01-01")
    }
  })

  test("returns zero for an empty calendar", () => {
    const result = StreakDomain.calculate(user, start, end, calendar())

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result))
      expect(result.success).toMatchObject({ currentStreak: 0, longestStreak: 0, active: false })
  })

  test("calculates active, broken, and tied longest streaks", () => {
    const active = StreakDomain.calculate(user, start, end, calendar({ 362: 1, 363: 1, 364: 1 }))
    const broken = StreakDomain.calculate(user, start, end, calendar({ 362: 1, 364: 1 }))
    const tied = StreakDomain.calculate(
      user,
      start,
      end,
      calendar({ 0: 1, 1: 1, 10: 1, 11: 1, 12: 1, 363: 1, 364: 1 }),
    )

    expect(Result.isSuccess(active)).toBe(true)
    expect(Result.isSuccess(broken)).toBe(true)
    expect(Result.isSuccess(tied)).toBe(true)
    if (Result.isSuccess(active))
      expect(active.success).toMatchObject({ currentStreak: 3, longestStreak: 3, active: true })
    if (Result.isSuccess(broken))
      expect(broken.success).toMatchObject({ currentStreak: 1, longestStreak: 1, active: true })
    if (Result.isSuccess(tied))
      expect(tied.success).toMatchObject({ currentStreak: 2, longestStreak: 3, active: true })
  })

  test("ignores today's empty cell once", () => {
    const result = StreakDomain.calculate(user, start, end, calendar({ 362: 1, 363: 1 }))

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result))
      expect(result.success).toMatchObject({ currentStreak: 2, longestStreak: 2, active: true })
  })

  test("rejects an incomplete or unsafe calendar", () => {
    const incomplete = StreakDomain.calculate(user, start, end, calendar().slice(0, 364))
    const unsafe = StreakDomain.calculate(user, start, end, calendar({ 0: -1 }))

    expect(Result.isFailure(incomplete)).toBe(true)
    expect(Result.isFailure(unsafe)).toBe(true)
  })
})

export * as StreakDomain from "./streak-domain.js"

import { ContributionStreak, IsoDate } from "@kronik/contract/model"
import type { User } from "@kronik/contract/model"
import { Result, Schema } from "effect"

const DayMillis = 86_400_000
const StreakDays = 365

/** One decoded GitHub contribution-calendar cell. */
export interface CalendarDay {
  readonly date: IsoDate
  readonly contributionCount: number
}

/** Pure failures produced while interpreting a contribution calendar. */
export type Error = "malformed-calendar" | "unsafe-streak"

const dateMillis = (value: IsoDate): number => Date.parse(`${value}T00:00:00Z`)

const makeIsoDate = (value: string): Result.Result<IsoDate, "invalid-date"> => {
  const result = Schema.decodeUnknownResult(IsoDate)(value)
  return Result.isSuccess(result) ? Result.succeed(result.success) : Result.fail("invalid-date")
}

const addDays = (value: IsoDate, days: number): Result.Result<IsoDate, "invalid-date"> => {
  const millis = dateMillis(value)
  if (!Number.isFinite(millis)) return Result.fail("invalid-date")
  return makeIsoDate(new Date(millis + days * DayMillis).toISOString().slice(0, 10))
}

/** Resolve the UTC range ending today and containing exactly 365 calendar dates. */
export const resolveRange = (
  nowMillis: number,
): Result.Result<{ readonly from: IsoDate; readonly to: IsoDate }, "invalid-date"> => {
  const today = makeIsoDate(new Date(nowMillis).toISOString().slice(0, 10))
  if (Result.isFailure(today)) return Result.fail("invalid-date")
  const from = addDays(today.success, -(StreakDays - 1))
  if (Result.isFailure(from)) return Result.fail("invalid-date")
  return Result.succeed({ from: from.success, to: today.success })
}

/** Check that GitHub supplied every date in the requested trailing range exactly once. */
export const isRepresentedRange = (
  from: IsoDate,
  to: IsoDate,
  days: ReadonlyArray<CalendarDay>,
): boolean => {
  const rangeSpan = (dateMillis(to) - dateMillis(from)) / DayMillis + 1
  if (rangeSpan !== StreakDays || days.length !== StreakDays) return false
  return days.every((day, index) => {
    const expected = addDays(from, index)
    return (
      Result.isSuccess(expected) &&
      day.date === expected.success &&
      Number.isSafeInteger(day.contributionCount) &&
      day.contributionCount >= 0
    )
  })
}

/** Calculate current and longest streaks without consulting a clock or server timezone. */
export const calculate = (
  user: User,
  from: IsoDate,
  to: IsoDate,
  days: ReadonlyArray<CalendarDay>,
): Result.Result<ContributionStreak, Error> => {
  if (!isRepresentedRange(from, to, days)) return Result.fail("malformed-calendar")

  let longest = 0
  let run = 0
  for (const day of days) {
    if (day.contributionCount > 0) {
      run += 1
      longest = Math.max(longest, run)
    }
    if (day.contributionCount === 0) run = 0
  }

  const lastIndex = days.length - 1
  const lastDay = days[lastIndex]
  if (lastDay === undefined) return Result.fail("malformed-calendar")
  const currentStart = lastDay.contributionCount > 0 ? lastIndex : lastIndex - 1
  let current = 0
  for (let index = currentStart; index >= 0; index -= 1) {
    const day = days[index]
    if (day === undefined || day.contributionCount === 0) break
    current += 1
  }

  const result = Schema.decodeUnknownResult(ContributionStreak)({
    user,
    from,
    to,
    currentStreak: current,
    longestStreak: longest,
    active: current > 0,
  })
  return Result.isSuccess(result) ? Result.succeed(result.success) : Result.fail("unsafe-streak")
}

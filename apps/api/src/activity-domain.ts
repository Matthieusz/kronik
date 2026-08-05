export * as ActivityDomain from "./activity-domain.js"

import { IsoDate } from "@kronik/contract/model"
import type { ActivitySummary, ActivityWindow, Language, User } from "@kronik/contract/model"
import { Result, Schema } from "effect"
import { CommitDomain } from "./commit-domain.js"

const DayMillis = 86_400_000
const DefaultWindowDays = 30
const MaximumWindowDays = 90
const MaximumAggregatedCommits = 100
const MaximumLanguages = 20

/** Bounds supplied to the Activity Summary use case. */
export interface WindowInput {
  readonly from?: typeof IsoDate.Type
  readonly to?: typeof IsoDate.Type
}

/** Evidence returned by GitHub for one bounded activity search. */
export interface Evidence {
  readonly user: User
  readonly items: ReadonlyArray<CommitDomain.Evidence>
  readonly matchedCommits: number
  readonly incompleteResults: boolean
  readonly repositories: ReadonlyArray<RepositoryLanguages>
}

/** Language bytes returned for one unique repository in the activity window. */
export interface RepositoryLanguages {
  readonly nameWithOwner: string
  readonly languages: ReadonlyArray<LanguageEvidence>
}

/** Exact language-byte evidence from GitHub's repository languages endpoint. */
export interface LanguageEvidence {
  readonly name: string
  readonly bytes: number
}

/** Pure failure values for Activity Window construction and aggregate projection. */
export type Error =
  | "window-bounds-required"
  | "window-reversed"
  | "window-too-wide"
  | "unsafe-aggregate"

const dateMillis = (value: typeof IsoDate.Type): number => Date.parse(`${value}T00:00:00Z`)

const makeIsoDate = (value: string): Result.Result<typeof IsoDate.Type, "invalid-date"> => {
  const result = Schema.decodeUnknownResult(IsoDate)(value)
  return Result.isSuccess(result) ? Result.succeed(result.success) : Result.fail("invalid-date")
}

const addDays = (
  value: typeof IsoDate.Type,
  days: number,
): Result.Result<typeof IsoDate.Type, "invalid-date"> => {
  const millis = dateMillis(value)
  if (!Number.isFinite(millis)) return Result.fail("invalid-date")
  return makeIsoDate(new Date(millis + days * DayMillis).toISOString().slice(0, 10))
}

/** Resolve an inclusive Activity Window using an injected UTC millisecond clock value. */
export const resolveWindow = (
  input: WindowInput,
  nowMillis: number,
): Result.Result<ActivityWindow, Error> => {
  const hasFrom = input.from !== undefined
  const hasTo = input.to !== undefined
  if (hasFrom !== hasTo) return Result.fail("window-bounds-required")

  if (!hasFrom && !hasTo) {
    const todayResult = makeIsoDate(new Date(nowMillis).toISOString().slice(0, 10))
    if (Result.isFailure(todayResult)) return Result.fail("window-bounds-required")
    const fromResult = addDays(todayResult.success, -(DefaultWindowDays - 1))
    if (Result.isFailure(fromResult)) return Result.fail("window-bounds-required")
    return Result.succeed({ from: fromResult.success, to: todayResult.success })
  }

  const from = input.from
  const to = input.to
  if (from === undefined || to === undefined) return Result.fail("window-bounds-required")
  const span = (dateMillis(to) - dateMillis(from)) / DayMillis + 1
  if (span < 1) return Result.fail("window-reversed")
  if (span > MaximumWindowDays) return Result.fail("window-too-wide")
  return Result.succeed({ from, to })
}

const addSafe = (left: number, right: number): Result.Result<number, "unsafe-aggregate"> => {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right))
    return Result.fail("unsafe-aggregate")
  const result = left + right
  return Number.isSafeInteger(result) ? Result.succeed(result) : Result.fail("unsafe-aggregate")
}

const sumSafe = (values: ReadonlyArray<number>): Result.Result<number, "unsafe-aggregate"> => {
  let result = 0
  for (const value of values) {
    const next = addSafe(result, value)
    if (Result.isFailure(next)) return next
    result = next.success
  }
  return Result.succeed(result)
}

const projectLanguages = (
  repositories: ReadonlyArray<RepositoryLanguages>,
): Result.Result<
  { readonly languages: ReadonlyArray<Language>; readonly otherBytes: number },
  Error
> => {
  const totals = new Map<string, number>()
  const seenRepositories = new Set<string>()
  for (const repository of repositories) {
    if (seenRepositories.has(repository.nameWithOwner)) continue
    seenRepositories.add(repository.nameWithOwner)
    for (const language of repository.languages) {
      const current = totals.get(language.name) ?? 0
      const next = addSafe(current, language.bytes)
      if (Result.isFailure(next)) return Result.fail(next.failure)
      totals.set(language.name, next.success)
    }
  }

  const ordered = [...totals.entries()].toSorted(
    ([leftName, leftBytes], [rightName, rightBytes]) =>
      rightBytes - leftBytes || leftName.localeCompare(rightName),
  )
  const listed = ordered.slice(0, MaximumLanguages)
  const omitted = ordered.slice(MaximumLanguages).map(([, bytes]) => bytes)
  const otherBytes = sumSafe(omitted)
  if (Result.isFailure(otherBytes)) return Result.fail(otherBytes.failure)
  const totalBytes = sumSafe(ordered.map(([, bytes]) => bytes))
  if (Result.isFailure(totalBytes)) return Result.fail(totalBytes.failure)

  return Result.succeed({
    languages: listed.map(([name, bytes]) => ({
      name,
      color: null,
      bytes,
      percentage: totalBytes.success === 0 ? 0 : (bytes / totalBytes.success) * 100,
    })),
    otherBytes: otherBytes.success,
  })
}

/** Project bounded GitHub evidence into the truthful Activity Summary contract. */
export const summarize = (
  window: ActivityWindow,
  evidence: Evidence,
): Result.Result<ActivitySummary, Error> => {
  if (evidence.items.length > MaximumAggregatedCommits) return Result.fail("unsafe-aggregate")

  let additions = 0
  let deletions = 0
  let changedLines = 0
  for (const item of evidence.items) {
    const projected = CommitDomain.projectCommit(item)
    if (Result.isFailure(projected)) return Result.fail("unsafe-aggregate")
    const nextAdditions = addSafe(additions, projected.success.additions)
    const nextDeletions = addSafe(deletions, projected.success.deletions)
    const nextChangedLines = addSafe(changedLines, projected.success.changedLines)
    if (
      Result.isFailure(nextAdditions) ||
      Result.isFailure(nextDeletions) ||
      Result.isFailure(nextChangedLines)
    )
      return Result.fail("unsafe-aggregate")
    additions = nextAdditions.success
    deletions = nextDeletions.success
    changedLines = nextChangedLines.success
  }

  const languages = projectLanguages(evidence.repositories)
  if (Result.isFailure(languages)) return Result.fail(languages.failure)
  const matchedCommits = evidence.matchedCommits
  if (
    !Number.isSafeInteger(matchedCommits) ||
    matchedCommits < 0 ||
    matchedCommits < evidence.items.length
  ) {
    return Result.fail("unsafe-aggregate")
  }

  return Result.succeed({
    user: evidence.user,
    window,
    coverage: {
      complete:
        !evidence.incompleteResults &&
        matchedCommits <= MaximumAggregatedCommits &&
        matchedCommits === evidence.items.length,
      matchedCommits,
      aggregatedCommits: evidence.items.length,
    },
    totals: {
      commits: evidence.items.length,
      additions,
      deletions,
      changedLines,
    },
    languages: languages.success.languages,
    otherBytes: languages.success.otherBytes,
  })
}

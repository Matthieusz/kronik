export * as CommitDomain from "./commit-domain.js"

import type { CommitSummary, LatestCommit, User } from "@kronik/contract/model"
import { Result } from "effect"

const MaxUtf8Bytes = 8192
const TruncationMarker = "…"

type CommitEvidence = {
  readonly user: User
  readonly sha: CommitSummary["sha"]
  readonly url: string
  readonly repository: CommitSummary["repository"]
  readonly message: string
  readonly authoredAt: CommitSummary["authoredAt"]
  readonly committedAt: CommitSummary["committedAt"]
  readonly additions: number
  readonly deletions: number
  readonly parents: CommitSummary["parents"]
}

/** Evidence projected by the GitHub adapter before public bounding rules apply. */
export type Evidence = CommitEvidence

/** A projection failure means upstream numeric evidence cannot be represented safely. */
export type ProjectionError = "unsafe-change-count"

const utf8Length = (value: string): number => new TextEncoder().encode(value).length

const takePrefix = (characters: ReadonlyArray<string>, budget: number): string => {
  let bytes = 0
  let result = ""
  for (const character of characters) {
    const characterBytes = utf8Length(character)
    if (bytes + characterBytes > budget) return result
    result += character
    bytes += characterBytes
  }
  return result
}

const takeSuffix = (characters: ReadonlyArray<string>, budget: number): string => {
  let bytes = 0
  let result = ""
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]
    if (character === undefined) return result
    const characterBytes = utf8Length(character)
    if (bytes + characterBytes > budget) return result
    result = character + result
    bytes += characterBytes
  }
  return result
}

/** Bound a message without splitting a Unicode code point or losing its edges. */
export const truncateUtf8 = (
  value: string,
): { readonly value: string; readonly truncated: boolean } => {
  if (utf8Length(value) <= MaxUtf8Bytes) return { value, truncated: false }

  const characters = Array.from(value)
  const markerBytes = utf8Length(TruncationMarker)
  const edgeBudget = Math.floor((MaxUtf8Bytes - markerBytes) / 2)
  let prefix = takePrefix(characters, edgeBudget)
  let suffix = takeSuffix(characters, edgeBudget)
  let result = `${prefix}${TruncationMarker}${suffix}`

  while (utf8Length(result) > MaxUtf8Bytes && prefix.length > 0) {
    prefix = Array.from(prefix).slice(0, -1).join("")
    result = `${prefix}${TruncationMarker}${suffix}`
  }
  while (utf8Length(result) > MaxUtf8Bytes && suffix.length > 0) {
    suffix = Array.from(suffix).slice(1).join("")
    result = `${prefix}${TruncationMarker}${suffix}`
  }

  return { value: result, truncated: true }
}

const splitMessage = (message: string): { readonly headline: string; readonly body: string } => {
  const newline = message.indexOf("\n")
  return newline < 0
    ? { headline: message, body: "" }
    : { headline: message.slice(0, newline), body: message.slice(newline + 1).replace(/^\n/, "") }
}

const safeChangedLines = (
  additions: number,
  deletions: number,
): Result.Result<number, ProjectionError> => {
  if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) {
    return Result.fail("unsafe-change-count")
  }
  const changedLines = additions + deletions
  return Number.isSafeInteger(changedLines)
    ? Result.succeed(changedLines)
    : Result.fail("unsafe-change-count")
}

/** Project GitHub evidence into the bounded public commit summary. */
export const projectCommit = (
  evidence: Evidence,
): Result.Result<CommitSummary, ProjectionError> => {
  const changedLines = safeChangedLines(evidence.additions, evidence.deletions)
  if (Result.isFailure(changedLines)) return Result.fail(changedLines.failure)

  const message = splitMessage(evidence.message)
  const boundedBody = truncateUtf8(message.body)
  const boundedHeadline = truncateUtf8(message.headline)

  return Result.succeed({
    sha: evidence.sha,
    url: evidence.url,
    repository: evidence.repository,
    headline: boundedHeadline.value,
    body: boundedBody.value,
    bodyTruncated: boundedBody.truncated,
    authoredAt: evidence.authoredAt,
    committedAt: evidence.committedAt,
    additions: evidence.additions,
    deletions: evidence.deletions,
    changedLines: changedLines.success,
    parents: evidence.parents,
  })
}

/** Project one decoded GitHub commit into the latest-commit response. */
export const projectLatest = (evidence: Evidence): Result.Result<LatestCommit, ProjectionError> => {
  const commit = projectCommit(evidence)
  return Result.isFailure(commit)
    ? Result.fail(commit.failure)
    : Result.succeed({ user: evidence.user, commit: commit.success })
}

import { describe, expect, test } from "bun:test"
import { ActivityWindow, CommitSha, IsoDate, IsoTimestamp, User } from "@kronik/contract/model"
import { Result, Schema } from "effect"
import { ActivityDomain } from "../src/activity-domain.js"
import { CommitDomain } from "../src/commit-domain.js"

const user = Schema.decodeUnknownSync(User)({
  login: "Octocat",
  url: "https://github.com/Octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/1",
})
const sha = "0123456789abcdef0123456789abcdef01234567"
const timestamp = Schema.decodeUnknownSync(IsoTimestamp)("2024-02-29T12:00:00Z")
const commit = {
  user,
  sha: Schema.decodeUnknownSync(CommitSha)(sha),
  url: `https://github.com/owner/repo/commit/${sha}`,
  repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" },
  message: "One change",
  authoredAt: timestamp,
  committedAt: timestamp,
  additions: 3,
  deletions: 2,
  parents: [],
} satisfies CommitDomain.Evidence

const evidence: ActivityDomain.Evidence = {
  user,
  items: [commit],
  matchedCommits: 1,
  incompleteResults: false,
  repositories: [
    {
      nameWithOwner: "owner/repo",
      languages: [
        { name: "TypeScript", bytes: 80 },
        { name: "JavaScript", bytes: 20 },
      ],
    },
    {
      nameWithOwner: "other/repo",
      languages: [{ name: "TypeScript", bytes: 20 }],
    },
  ],
}

describe("activity window", () => {
  test("defaults to exactly 30 UTC dates across a leap day", () => {
    const result = ActivityDomain.resolveWindow({}, Date.parse("2024-03-01T23:00:00Z"))

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(String(result.success.from)).toBe("2024-02-01")
      expect(String(result.success.to)).toBe("2024-03-01")
    }
  })

  test("requires ordered inclusive bounds of at most 90 dates", () => {
    const from = Schema.decodeUnknownSync(IsoDate)("2024-01-01")
    const to = Schema.decodeUnknownSync(IsoDate)("2024-03-30")
    const tooWideTo = Schema.decodeUnknownSync(IsoDate)("2024-04-01")
    const reversed = ActivityDomain.resolveWindow({ from: to, to: from }, 0)
    const tooWide = ActivityDomain.resolveWindow({ from, to: tooWideTo }, 0)
    const incomplete = ActivityDomain.resolveWindow({ from }, 0)

    expect(Result.isFailure(reversed)).toBe(true)
    expect(Result.isFailure(tooWide)).toBe(true)
    expect(Result.isFailure(incomplete)).toBe(true)
  })
})

describe("activity summary projection", () => {
  test("deduplicates repositories and conserves exact language bytes", () => {
    const window = Schema.decodeUnknownSync(ActivityWindow)({
      from: "2024-02-01",
      to: "2024-03-01",
    })
    const result = ActivityDomain.summarize(window, evidence)

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.totals).toEqual({
        commits: 1,
        additions: 3,
        deletions: 2,
        changedLines: 5,
      })
      expect(result.success.languages.map((language) => [language.name, language.bytes])).toEqual([
        ["TypeScript", 100],
        ["JavaScript", 20],
      ])
      expect(result.success.languages[0]?.percentage).toBeCloseTo(100 / 1.2)
      expect(result.success.languages[1]?.percentage).toBeCloseTo(100 / 6)
      expect(result.success.otherBytes).toBe(0)
    }
  })

  test("marks incomplete and over-bound aggregates as partial", () => {
    const window = Schema.decodeUnknownSync(ActivityWindow)({
      from: "2024-02-01",
      to: "2024-03-01",
    })
    const result = ActivityDomain.summarize(window, {
      ...evidence,
      matchedCommits: 125,
      incompleteResults: true,
    })

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.coverage).toEqual({
        complete: false,
        matchedCommits: 125,
        aggregatedCommits: 1,
      })
      expect(result.success.totals.commits).toBe(1)
    }
  })

  test("keeps the twenty largest languages and conserves the tail", () => {
    const window = Schema.decodeUnknownSync(ActivityWindow)({
      from: "2024-02-01",
      to: "2024-03-01",
    })
    const languages = Array.from({ length: 21 }, (_, index) => ({
      name: `Language${String(index).padStart(2, "0")}`,
      bytes: index + 1,
    }))
    const result = ActivityDomain.summarize(window, {
      ...evidence,
      repositories: [{ nameWithOwner: "owner/repo", languages }],
    })

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.languages).toHaveLength(20)
      expect(result.success.languages[0]?.name).toBe("Language20")
      expect(result.success.languages.at(-1)?.name).toBe("Language01")
      expect(result.success.otherBytes).toBe(1)
      expect(
        result.success.languages.reduce((total, language) => total + language.bytes, 0) +
          result.success.otherBytes,
      ).toBe(231)
    }
  })

  test("represents an empty complete window without language data", () => {
    const window = Schema.decodeUnknownSync(ActivityWindow)({
      from: "2024-02-01",
      to: "2024-03-01",
    })
    const result = ActivityDomain.summarize(window, {
      user,
      items: [],
      matchedCommits: 0,
      incompleteResults: false,
      repositories: [],
    })

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.coverage.complete).toBe(true)
      expect(result.success.languages).toEqual([])
      expect(result.success.otherBytes).toBe(0)
    }
  })
})

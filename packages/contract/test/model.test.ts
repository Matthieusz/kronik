import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { ActivitySummary, CommitSummary, GitHubUsername, IsoDate } from "../src/model.js"

const decode = Schema.decodeUnknownResult(GitHubUsername)

describe("IsoDate", () => {
  test("accepts leap days and rejects impossible calendar dates", () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(IsoDate)("2024-02-29"))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(IsoDate)("2023-02-29"))).toBe(false)
    expect(Result.isSuccess(Schema.decodeUnknownResult(IsoDate)("2024-04-31"))).toBe(false)
  })
})

describe("ActivitySummary", () => {
  test("keeps the language breakdown bounded", () => {
    const summary = {
      user: {
        login: "octocat",
        url: "https://github.com/octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
      },
      window: { from: "2024-01-01", to: "2024-01-30" },
      coverage: { complete: true, matchedCommits: 0, aggregatedCommits: 0 },
      totals: { commits: 0, additions: 0, deletions: 0, changedLines: 0 },
      languages: Array.from({ length: 21 }, (_, index) => ({
        name: `Language${index}`,
        color: null,
        bytes: 1,
        percentage: 100 / 21,
      })),
      otherBytes: 0,
    }

    expect(Result.isFailure(Schema.decodeUnknownResult(ActivitySummary)(summary))).toBe(true)
  })
})

describe("GitHubUsername", () => {
  test("accepts canonical GitHub syntax", () => {
    expect(Result.isSuccess(decode("octocat"))).toBe(true)
    expect(Result.isSuccess(decode("Some-User"))).toBe(true)
  })

  test("rejects qualifier injection and invalid hyphens", () => {
    expect(Result.isFailure(decode("octocat is:private"))).toBe(true)
    expect(Result.isFailure(decode("-octocat"))).toBe(true)
    expect(Result.isFailure(decode("octo--cat"))).toBe(true)
  })
})

describe("commit file counts", () => {
  const commit = {
    sha: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/owner/repo/commit/0123456789abcdef0123456789abcdef01234567",
    repository: { nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" },
    headline: "Update files",
    body: "",
    bodyTruncated: false,
    authoredAt: "2026-01-01T00:00:00Z",
    committedAt: "2026-01-01T00:00:00Z",
    additions: 1,
    deletions: 0,
    changedLines: 1,
    parents: [],
  }

  test.each([0, 5, null])(
    "accepts a count or an explicit unavailable value: %s",
    (filesChanged) => {
      expect(
        Result.isSuccess(Schema.decodeUnknownResult(CommitSummary)({ ...commit, filesChanged })),
      ).toBe(true)
    },
  )

  test.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects missing or invalid counts: %s",
    (filesChanged) => {
      expect(
        Result.isFailure(Schema.decodeUnknownResult(CommitSummary)({ ...commit, filesChanged })),
      ).toBe(true)
    },
  )
})

import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { ActivitySummary, GitHubUsername, IsoDate } from "../src/model.js"

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

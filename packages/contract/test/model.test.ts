import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { GitHubUsername } from "../src/model.js"

const decode = Schema.decodeUnknownResult(GitHubUsername)

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

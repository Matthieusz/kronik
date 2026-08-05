import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import {
  CommitQuery,
  CommitsEndpoint,
  LatestActivityGroup,
  LatestCommitEndpoint,
} from "../src/api.js"
import { CommitRpcs, LatestCommitRpcs } from "../src/rpc.js"

const latest = {
  username: "OctoCat",
}

describe("latest commit contract", () => {
  test("declares the public latest route", () => {
    expect(LatestActivityGroup.endpoints.latestCommit.path).toBe(
      "/v1/users/:username/commits/latest",
    )
    expect(LatestCommitEndpoint.identifier).toBe("latestCommit")
  })

  test("declares the paginated commit route and rejects mixed RPC modes", () => {
    expect(CommitsEndpoint.path).toBe("/v1/users/:username/commits")
    const procedure = CommitRpcs.requests.get("commits")
    if (procedure === undefined) throw new Error("commits RPC is not declared")

    const initial = Schema.decodeUnknownResult(procedure.payloadSchema)({
      username: "OctoCat",
      limit: 25,
    })
    const continuation = Schema.decodeUnknownResult(procedure.payloadSchema)({
      username: "OctoCat",
      cursor: "opaque-cursor",
    })
    const mixed = Schema.decodeUnknownResult(procedure.payloadSchema)({
      username: "OctoCat",
      limit: 25,
      cursor: "opaque-cursor",
    })
    const invalidQuery = Schema.decodeUnknownResult(CommitQuery)({
      limit: "25",
      cursor: "opaque-cursor",
    })
    expect(Result.isSuccess(initial)).toBe(true)
    expect(Result.isSuccess(continuation)).toBe(true)
    expect(Result.isFailure(mixed)).toBe(true)
    expect(Result.isFailure(invalidQuery)).toBe(true)
  })

  test("decodes the latest RPC payload at runtime", () => {
    const procedure = LatestCommitRpcs.requests.get("latestCommit")
    if (procedure === undefined) throw new Error("latestCommit RPC is not declared")

    const valid = Schema.decodeUnknownResult(procedure.payloadSchema)(latest)
    const invalid = Schema.decodeUnknownResult(procedure.payloadSchema)({ username: "octo cat" })

    expect(Result.isSuccess(valid)).toBe(true)
    expect(Result.isFailure(invalid)).toBe(true)
  })
})

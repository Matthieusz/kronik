import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { HealthApi, HealthGroup } from "../src/api.js"
import { Health } from "../src/model.js"

describe("health contract", () => {
  test("decodes the health response", () => {
    const result = Schema.decodeUnknownResult(Health)({ status: "ok" })

    expect(Result.isSuccess(result)).toBe(true)
  })

  test("declares a Kronik v1 health endpoint", () => {
    expect(HealthGroup.endpoints.get.path).toBe("/health")

    const document = OpenApi.fromApi(HealthApi)

    expect(document.info.title).toBe("Kronik API")
    expect(document.info.version).toBe("1.0.0")
    expect(document.paths["/health"]?.get?.operationId).toBe("health.get")
  })
})

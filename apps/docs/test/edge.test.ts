import { describe, expect, test } from "bun:test"
import { gatewayResponse } from "../lib/edge.js"
import type { GatewayBindings } from "../lib/edge.js"

const gateway = () => {
  const apiRequests: Request[] = []
  const assetRequests: Request[] = []
  const apiResponse = new Response("api", { status: 201, headers: { "x-request-id": "test" } })
  const bindings: GatewayBindings = {
    API: {
      fetch: async (request) => {
        apiRequests.push(request)

        return apiResponse
      },
    },
    ASSETS: {
      fetch: async (request) => {
        assetRequests.push(request)

        return new Response("docs")
      },
    },
  }

  return { bindings, apiRequests, assetRequests, apiResponse }
}

describe("documentation gateway", () => {
  test("strips only the API prefix and preserves the request and response", async () => {
    const { bindings, apiRequests, assetRequests, apiResponse } = gateway()
    const request = new Request("https://kronik.informati.dev/api/v1/users/octocat/commits?limit=1", {
      method: "POST",
      headers: { "x-request-id": "test", "cf-connecting-ip": "192.0.2.1" },
      body: "payload",
    })
    const response = await gatewayResponse(request, bindings)
    const forwarded = apiRequests[0]

    expect(forwarded).toBeDefined()
    expect(forwarded?.url).toBe("https://kronik.informati.dev/v1/users/octocat/commits?limit=1")
    expect(forwarded?.method).toBe("POST")
    expect(forwarded?.headers.get("cf-connecting-ip")).toBe("192.0.2.1")
    expect(forwarded?.headers.get("x-request-id")).toBe("test")
    expect(await forwarded?.text()).toBe("payload")
    expect(response).toBe(apiResponse)
    expect(assetRequests).toHaveLength(0)
  })

  test("forwards operational API routes and the prefix root", async () => {
    for (const [path, target] of [["/api/health", "/health"], ["/api/openapi.json", "/openapi.json"], ["/api", "/"], ["/api/", "/"]]) {
      const { bindings, apiRequests } = gateway()
      await gatewayResponse(new Request(`https://kronik.informati.dev${path}`), bindings)

      expect(apiRequests[0]?.url).toBe(`https://kronik.informati.dev${target}`)
    }
  })

  test("serves docs and similarly named paths without forwarding to the API", async () => {
    for (const path of ["/", "/api-reference", "/api/search", "/openapi.json", "/apiary", "/_next/static/app.js"]) {
      const { bindings, apiRequests, assetRequests } = gateway()
      const request = new Request(`https://kronik.informati.dev${path}`)
      const response = await gatewayResponse(request, bindings)

      expect(await response.text()).toBe("docs")
      expect(assetRequests).toEqual([request])
      expect(apiRequests).toHaveLength(0)
    }
  })
})

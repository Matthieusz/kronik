/** Fetch capability supplied by a Worker service or static-assets binding. */
export interface FetchBinding {
  /** Forward a request to the bound Worker or asset store. */
  readonly fetch: (request: Request) => Promise<Response>
}

/** Platform capabilities used by the documentation gateway. */
export interface GatewayBindings {
  readonly API: FetchBinding
  readonly ASSETS: FetchBinding
}

/** Serve documentation assets or forward /api requests with the prefix removed. */
export const gatewayResponse = (request: Request, bindings: GatewayBindings): Promise<Response> => {
  const url = new URL(request.url)

  // Fumadocs' generated search index is a documentation asset, not an API endpoint.
  if (url.pathname === "/api/search") return bindings.ASSETS.fetch(request)

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    url.pathname = url.pathname.slice(4) || "/"

    return bindings.API.fetch(new Request(url, request))
  }

  return bindings.ASSETS.fetch(request)
}

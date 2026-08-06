"use client"

import type { ComponentProps } from "react"
import { createOpenAPIPage } from "fumadocs-openapi/ui"

const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL
const apiServer =
  configuredApiUrl === undefined || configuredApiUrl.length === 0
    ? undefined
    : new URL(configuredApiUrl).toString()
const GeneratedOpenAPIPage = createOpenAPIPage({
  showResponseSchema: false,
  playground: { enabled: apiServer !== undefined },
})
type OpenAPIPageProps = ComponentProps<typeof GeneratedOpenAPIPage>

/** Render an OpenAPI operation against the deployed API when its public URL is configured. */
export default function OpenAPIPage(props: OpenAPIPageProps) {
  if (apiServer === undefined || !("payload" in props)) {
    return <GeneratedOpenAPIPage {...props} />
  }

  return (
    <GeneratedOpenAPIPage
      {...props}
      payload={{
        ...props.payload,
        bundled: {
          ...props.payload.bundled,
          servers: [{ url: apiServer }],
        },
      }}
    />
  )
}

import { notFound } from "next/navigation"
import OpenAPIPage from "../openapi-page"
import { DocsBody, DocsPage } from "fumadocs-ui/page"
import { apiReference } from "../../../lib/api-reference"

/** Ensure every generated operation page is included in the static export. */
export const dynamicParams = false

/** Return the OpenAPI operation slugs that Next.js should prerender. */
export function generateStaticParams() {
  return apiReference.generateParams()
}

/** Render one generated OpenAPI operation page. */
export default async function ApiOperationPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string[] }>
}) {
  const { slug } = await params
  const page = apiReference.getPage(slug)

  if (page === undefined) {
    notFound()
  }

  return (
    <DocsPage full toc={page.data.toc}>
      <DocsBody>
        <OpenAPIPage {...page.data.getOpenAPIPageProps()} />
      </DocsBody>
    </DocsPage>
  )
}

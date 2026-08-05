import type { Metadata } from "next"
import type { ReactNode } from "react"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { RootProvider } from "fumadocs-ui/provider/next"
import { apiReference } from "../lib/api-reference"
import "./globals.css"

export const metadata: Metadata = {
  title: "Kronik API",
  description: "Portfolio-friendly summaries of public GitHub activity.",
}

/** Root document shell for the static Kronik documentation site. */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <RootProvider>
          <DocsLayout tree={apiReference.pageTree}>{children}</DocsLayout>
        </RootProvider>
      </body>
    </html>
  )
}

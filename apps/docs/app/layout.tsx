import type { Metadata } from "next"
import type { ReactNode } from "react"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { RootProvider } from "fumadocs-ui/provider/next"
import { apiReference } from "../lib/api-reference"
import "./globals.css"

export const metadata: Metadata = {
  title: {
    default: "Kronik documentation",
    template: "%s · Kronik",
  },
  description: "Portfolio-friendly summaries of public GitHub activity.",
}

/** Root document shell for the static Kronik documentation site. */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ options: { type: "static", api: "/api/search" } }}>
          <DocsLayout
            tree={apiReference.pageTree}
            nav={{ title: "Kronik", url: "/" }}
            githubUrl="https://github.com/Matthieusz/kronik"
            links={[
              { text: "Concepts", url: "/concepts" },
              { text: "API reference", url: "/api-reference", active: "nested-url" },
            ]}
          >
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  )
}

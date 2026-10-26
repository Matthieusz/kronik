import { defineConfig } from "blume"
import { openapi } from "blume/reference"

/** Static documentation generated from the shared Kronik HTTP contract. */
export default defineConfig({
  title: "Kronik",
  description: "Portfolio-friendly summaries of public GitHub activity.",
  content: { root: "content" },
  github: { owner: "Matthieusz", repo: "kronik", dir: "apps/docs" },
  deployment: { site: "https://kronik.informati.dev" },
  navigation: {
    actions: [{ label: "Concepts", href: "/concepts" }],
    tabs: [
      { label: "Documentation", path: "/" },
      { label: "API reference", path: "/api-reference" },
    ],
  },
  // /api belongs to the Worker gateway; /openapi.json remains Kronik's contract.
  agents: { api: false },
  reference: [
    openapi({
      spec: "../../packages/contract/openapi.json",
      route: "/api-reference",
      overlays: ["./.generated/api-server.json"],
    }),
  ],
  redirects: [
    { from: "/api-reference/health.get", to: "/api-reference/health/health-get" },
    {
      from: "/api-reference/v1.activity.commits",
      to: "/api-reference/activity/v1-activity-commits",
    },
    {
      from: "/api-reference/v1.activity.latestCommit",
      to: "/api-reference/activity/v1-activity-latest-commit",
    },
    {
      from: "/api-reference/v1.activity.summary",
      to: "/api-reference/activity/v1-activity-summary",
    },
    { from: "/api-reference/v1.activity.streak", to: "/api-reference/activity/v1-activity-streak" },
  ],
})

import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page"

export default function HomePage() {
  return (
    <DocsPage breadcrumb={{ enabled: false }} tableOfContent={{ enabled: false }}>
      <DocsBody className="kronik-home">
        <section className="kronik-hero">
          <p className="kronik-eyebrow">Kronik v1</p>
          <DocsTitle>Public GitHub activity, presented clearly.</DocsTitle>
          <DocsDescription className="kronik-lede">
            A focused API for turning a GitHub user&apos;s public default-branch activity into
            portfolio-friendly summaries.
          </DocsDescription>
          <div className="kronik-actions not-prose">
            <a className="kronik-button" href="/api-reference">
              Explore the API
            </a>
            <a className="kronik-button kronik-button-secondary" href="/concepts">
              Read the concepts
            </a>
          </div>
        </section>

        <section className="kronik-section not-prose">
          <h2 className="kronik-section-heading">Built around useful answers</h2>
          <p className="kronik-section-lede">
            Kronik keeps its scope explicit, bounded, and easy to consume.
          </p>
          <div className="kronik-card-grid">
            <a className="kronik-card" href="/api-reference/v1.activity.commits">
              <h3>Commit feed</h3>
              <p>
                Browse matching public commits with authenticated, user-bound cursor pagination.
              </p>
            </a>
            <a className="kronik-card" href="/api-reference/v1.activity.summary">
              <h3>Activity summary</h3>
              <p>
                Aggregate changes and repository language bytes over a precise UTC activity window.
              </p>
            </a>
            <a className="kronik-card" href="/api-reference/v1.activity.streak">
              <h3>Contribution streaks</h3>
              <p>
                Evaluate current and longest streaks over GitHub&apos;s trailing 365-day calendar.
              </p>
            </a>
          </div>
        </section>

        <section className="kronik-section not-prose">
          <h2 className="kronik-section-heading">Know what the data means</h2>
          <p className="kronik-section-lede">
            Read the rules behind attribution, coverage, caching, rate limits, and credentials.
          </p>
          <div className="kronik-actions">
            <a className="kronik-button kronik-button-secondary" href="/concepts">
              Understand Kronik&apos;s model →
            </a>
          </div>
        </section>
      </DocsBody>
    </DocsPage>
  )
}

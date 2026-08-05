# Use Cloudflare Worker edge handling with per-user coordination

Kronik will deploy through Alchemy as a Cloudflare Worker that handles the HTTP contract, approximate per-IP rate limiting, and edge caching. On a cache miss it delegates to a Durable Object keyed by normalized GitHub username so identical requests coalesce globally and bounded stale successes remain available without duplicating GitHub quota across regions.

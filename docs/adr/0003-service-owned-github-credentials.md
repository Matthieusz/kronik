# Keep GitHub credentials service-owned

Kronik will call GitHub with a least-privilege service credential stored as a Cloudflare secret rather than accepting personal access tokens from public callers. This avoids asking users to disclose credentials to a third party; caching, request coalescing, bounded aggregation, and public rate limiting protect the shared upstream budget.

# Generate documentation from the Effect HTTP contract

Kronik will use a Bun workspace with separate API and Fumadocs applications, but the API’s Effect `HttpApi` and `Schema` definitions remain the sole contract source. The docs build consumes generated OpenAPI output and CI rejects stale generated specifications, preventing hand-maintained documentation from drifting away from runtime behavior.

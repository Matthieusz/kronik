# Schema-validate Durable Object RPC

Kronik will use Effect RPC with schemas for Worker-to-Durable-Object communication instead of Alchemy’s recommended schemaless typed bridge. The additional contract is deliberate because every process and serialization hop must parse its inputs, outputs, and expected failures at runtime rather than relying only on TypeScript inference.

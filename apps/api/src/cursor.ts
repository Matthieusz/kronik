export * as Cursor from "./cursor.js"

import { ApiError } from "@kronik/contract/errors"
import { Cursor, GitHubUsername, IsoTimestamp } from "@kronik/contract/model"
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"

const CursorLifetimeMs = 60 * 60 * 1000
const PageNumber = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
)
const PageSize = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
)

/** The authenticated state carried by a commit-feed cursor. */
export const Payload = Schema.Struct({
  version: Schema.Literal(1),
  username: GitHubUsername,
  snapshot: IsoTimestamp,
  pageSize: PageSize,
  position: PageNumber,
  direction: Schema.Literals(["forward", "backward"]),
}).annotate({ identifier: "CursorPayload" })
export interface Payload extends Schema.Schema.Type<typeof Payload> {}

/** Direction encoded by a navigation cursor. */
export type Direction = Payload["direction"]

/** Redaction-safe authority used to sign and verify cursors. */
export class Secret extends Context.Service<Secret, { readonly value: Redacted.Redacted }>()(
  "@kronik/api/Cursor.Secret",
) {}

/** Cursor operations used by the Durable Object boundary. */
export interface Interface {
  /** Create the first page state using the injected UTC clock. */
  readonly initial: (
    username: GitHubUsername,
    pageSize: number,
  ) => Effect.Effect<Payload, ApiError.InvalidCursor>
  /** Authenticate and validate an opaque cursor for a requested user. */
  readonly decode: (
    value: string,
    username: GitHubUsername,
    direction?: Direction,
  ) => Effect.Effect<Payload, ApiError.InvalidCursor>
  /** Sign validated cursor state without exposing its payload. */
  readonly encode: (payload: Payload) => Effect.Effect<Cursor, ApiError.InvalidCursor>
}

/** Effect service for versioned HMAC-authenticated cursors. */
export class Service extends Context.Service<Service, Interface>()("@kronik/api/Cursor") {}

const invalidCursor = () =>
  new ApiError.InvalidCursor({
    type: "https://kronik.dev/problems/invalid-cursor",
    title: "Invalid cursor",
    detail: "The supplied pagination cursor is invalid or expired",
    instance: "urn:kronik:cursor",
    status: 400,
  })

const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url")
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
  const padding = (4 - (padded.length % 4)) % 4
  const binary = atob(`${padded}${"=".repeat(padding)}`)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const payloadBytes = (payload: Payload): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(payload))

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

const importKey = (secret: Redacted.Redacted) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        asArrayBuffer(new TextEncoder().encode(Redacted.value(secret))),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    catch: () => invalidCursor(),
  })

const sign = (secret: Redacted.Redacted, payload: Payload) =>
  Effect.gen(function* () {
    const key = yield* importKey(secret)
    const signature = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, asArrayBuffer(payloadBytes(payload))),
      catch: () => invalidCursor(),
    })
    return encodeBase64Url(new Uint8Array(signature))
  })

const verify = (secret: Redacted.Redacted, payloadPart: string, signaturePart: string) =>
  Effect.gen(function* () {
    const key = yield* importKey(secret)
    const signature = yield* Effect.try({
      try: () => decodeBase64Url(signaturePart),
      catch: () => invalidCursor(),
    })
    const payload = yield* Effect.try({
      try: () => decodeBase64Url(payloadPart),
      catch: () => invalidCursor(),
    })
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.verify("HMAC", key, asArrayBuffer(signature), asArrayBuffer(payload)),
      catch: () => invalidCursor(),
    })
  })

const decodePayload = (value: Uint8Array) =>
  Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(value),
      catch: () => invalidCursor(),
    })
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => invalidCursor(),
    })
    return yield* Schema.decodeUnknownEffect(Payload)(json).pipe(
      Effect.mapError(() => invalidCursor()),
    )
  })

const makeSnapshot = (millis: number) =>
  Schema.decodeUnknownEffect(IsoTimestamp)(new Date(millis).toISOString()).pipe(
    Effect.mapError(() => invalidCursor()),
  )

/** Build the live cursor authority from an explicit redacted secret. */
export const layerWithSecret = (secret: Redacted.Redacted) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const initial = Effect.fn("Cursor.initial")(function* (
        username: GitHubUsername,
        pageSize: number,
      ) {
        const validPageSize = yield* Schema.decodeUnknownEffect(PageSize)(pageSize).pipe(
          Effect.mapError(() => invalidCursor()),
        )
        const now = yield* clock.currentTimeMillis
        const snapshot = yield* makeSnapshot(now)
        const normalizedUsername = yield* Schema.decodeUnknownEffect(GitHubUsername)(
          username.toLowerCase(),
        ).pipe(Effect.mapError(() => invalidCursor()))
        return Payload.make({
          version: 1,
          username: normalizedUsername,
          snapshot,
          pageSize: validPageSize,
          position: 1,
          direction: "forward",
        })
      })
      const encode = Effect.fn("Cursor.encode")(function* (payload: Payload) {
        const validated = yield* Schema.decodeUnknownEffect(Payload)(payload).pipe(
          Effect.mapError(() => invalidCursor()),
        )
        const encodedPayload = encodeBase64Url(payloadBytes(validated))
        const signature = yield* sign(secret, validated)
        return yield* Schema.decodeUnknownEffect(Cursor)(`${encodedPayload}.${signature}`).pipe(
          Effect.mapError(() => invalidCursor()),
        )
      })
      const decode = Effect.fn("Cursor.decode")(function* (
        value: string,
        username: GitHubUsername,
        direction?: Direction,
      ) {
        const parts = value.split(".")
        const payloadPart = parts[0]
        const signaturePart = parts[1]
        if (parts.length !== 2 || payloadPart === undefined || signaturePart === undefined) {
          return yield* Effect.fail(invalidCursor())
        }
        const authenticated = yield* verify(secret, payloadPart, signaturePart)
        if (!authenticated) return yield* Effect.fail(invalidCursor())
        const encodedPayload = yield* Effect.try({
          try: () => decodeBase64Url(payloadPart),
          catch: () => invalidCursor(),
        })
        const payload = yield* decodePayload(encodedPayload)
        if (payload.username.toLowerCase() !== username.toLowerCase()) {
          return yield* Effect.fail(invalidCursor())
        }
        if (direction !== undefined && payload.direction !== direction) {
          return yield* Effect.fail(invalidCursor())
        }
        const now = yield* clock.currentTimeMillis
        const snapshotMillis = Date.parse(payload.snapshot)
        if (!Number.isFinite(snapshotMillis) || now - snapshotMillis > CursorLifetimeMs) {
          return yield* Effect.fail(invalidCursor())
        }
        return payload
      })
      return Service.of({ initial, encode, decode })
    }),
  )

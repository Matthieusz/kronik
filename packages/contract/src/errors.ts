export * as ApiError from "./errors.js"

import { Schema } from "effect"

const fields = {
  type: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  instance: Schema.String,
}

/** The request failed local contract validation. */
export class InvalidRequest extends Schema.TaggedErrorClass<InvalidRequest>()(
  "InvalidRequest",
  { ...fields, status: Schema.Literal(400) },
  { httpApiStatus: 400 },
) {}

/** The supplied pagination cursor is invalid, expired, or belongs to another user. */
export class InvalidCursor extends Schema.TaggedErrorClass<InvalidCursor>()(
  "InvalidCursor",
  { ...fields, status: Schema.Literal(400) },
  { httpApiStatus: 400 },
) {}

/** GitHub does not resolve the requested user. */
export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
  "UserNotFound",
  { ...fields, status: Schema.Literal(404) },
  { httpApiStatus: 404 },
) {}

/** The requested user has no matching public default-branch commit. */
export class LatestCommitNotFound extends Schema.TaggedErrorClass<LatestCommitNotFound>()(
  "LatestCommitNotFound",
  { ...fields, status: Schema.Literal(404) },
  { httpApiStatus: 404 },
) {}

/** The anonymous caller exceeded Kronik's public request budget. */
export class RateLimited extends Schema.TaggedErrorClass<RateLimited>()(
  "RateLimited",
  {
    ...fields,
    status: Schema.Literal(429),
    retryAfterSeconds: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  },
  { httpApiStatus: 429 },
) {}

/** GitHub rejected or could not satisfy Kronik's upstream request. */
export class UpstreamFailure extends Schema.TaggedErrorClass<UpstreamFailure>()(
  "UpstreamFailure",
  { ...fields, status: Schema.Literal(502) },
  { httpApiStatus: 502 },
) {}

/** Kronik could not complete the request within its availability policy. */
export class ServiceUnavailable extends Schema.TaggedErrorClass<ServiceUnavailable>()(
  "ServiceUnavailable",
  { ...fields, status: Schema.Literal(503) },
  { httpApiStatus: 503 },
) {}

/** Every declared problem response exposed by a domain endpoint. */
export const DomainErrors = Schema.Union([
  InvalidRequest,
  InvalidCursor,
  UserNotFound,
  LatestCommitNotFound,
  RateLimited,
  UpstreamFailure,
  ServiceUnavailable,
])
export type DomainErrors = typeof DomainErrors.Type

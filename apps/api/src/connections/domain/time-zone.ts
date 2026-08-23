import { DateTime, Option, Schema } from "effect"

/**
 * An IANA time zone name, validated against the platform's own zone database
 * rather than a pattern, so `Europe/Paris` is accepted and `Europe/Paris/2` is
 * not.
 *
 * This lives on the User because a Day Window is a calendar day in *their*
 * timezone: "yesterday" has to mean what the person asking thinks it means,
 * which UTC and a rolling 24 hours both get wrong.
 */
export const TimeZone = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((name) => Option.isSome(DateTime.zoneMakeNamed(name)), {
    message: () => "Expected an IANA time zone name, such as Europe/Paris"
  }),
  Schema.brand("TimeZone")
)
export type TimeZone = typeof TimeZone.Type

/** What a User gets until they say otherwise. */
export const DEFAULT_TIME_ZONE = TimeZone.make("UTC")

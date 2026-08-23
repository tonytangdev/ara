import { DateTime, Either, Option, Schema } from "effect"
// Imported from where they are defined rather than from the connections
// module's `index.ts`: that file wires the module up, and the wiring reaches
// the shared `AraApi`, which reaches back here. Types are shared between
// modules; layers are not.
import { TimeZone } from "../../connections/domain/time-zone.ts"

/**
 * A calendar date as a person writes it: `2026-08-22`. Not an instant — the
 * same date names a different span of time depending on where you are, which is
 * exactly the distinction a Day Window exists to keep.
 *
 * The filter rejects dates the pattern would let through: `2026-02-30` matches
 * the shape and is not a day.
 */
export const CalendarDay = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.filter(
    (day) => Option.exists(DateTime.make(`${day}T00:00:00.000Z`), (at) => DateTime.formatIsoDate(at) === day),
    {
      message: () => "Expected a real calendar date, such as 2026-08-22"
    }
  ),
  Schema.brand("CalendarDay")
)
export type CalendarDay = typeof CalendarDay.Type

/** Neither a real date nor a zone anybody lives in. Says which, because both are the caller's to fix. */
export class InvalidDayWindow extends Schema.TaggedError<InvalidDayWindow>()("InvalidDayWindow", {
  reason: Schema.String
}) {}

/**
 * The span of time a Digest covers: one calendar day in the User's own
 * timezone.
 *
 * Deliberately *not* a pair of instants and not a rolling 24 hours. It is
 * stored as the day and the zone, and the instants are derived, because those
 * are the two facts the User actually stated. Both derivations are zone-aware:
 * a day in `Pacific/Auckland` starts twelve hours before the UTC day of the
 * same name, and the day a country moves its clocks is 23 or 25 hours long.
 */
export class DayWindow extends Schema.Class<DayWindow>("DayWindow")({
  day: CalendarDay,
  timeZone: TimeZone
}) {
  /** Local midnight opening the day, as an instant. */
  get startsAt(): DateTime.Utc {
    return DateTime.toUtc(this.localStart)
  }

  /** Local midnight opening the *next* day: the exclusive end of the window. */
  get endsAt(): DateTime.Utc {
    return DateTime.toUtc(DateTime.add(this.localStart, { days: 1 }))
  }

  private get localStart(): DateTime.Zoned {
    // The date parts are read as wall-clock time and then moved into the zone,
    // so the instant is whatever local midnight happens to be there that day.
    return DateTime.setZone(
      DateTime.unsafeMake(`${this.day}T00:00:00.000Z`),
      DateTime.zoneUnsafeMakeNamed(this.timeZone),
      { adjustForTimeZone: true }
    )
  }
}

/**
 * The only way to build a Day Window from what a caller sent. Returns the
 * failure rather than throwing, because "2026-02-30" and "Mars/Olympus" are
 * things a client can send and a person can fix.
 */
export const makeDayWindow = (day: string, timeZone: string): Either.Either<DayWindow, InvalidDayWindow> =>
  Either.mapLeft(
    Schema.decodeEither(DayWindow)({ day, timeZone }),
    () => new InvalidDayWindow({ reason: `${day} in ${timeZone} is not a calendar day in a timezone` })
  )

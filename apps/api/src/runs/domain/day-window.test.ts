import { assert, describe, it } from "@effect/vitest"
import { DateTime, Either } from "effect"
import { makeDayWindow } from "./day-window.ts"

/**
 * What these tests drive: what "a day" means. A Day Window is a calendar day in
 * the User's own timezone — not UTC, and not a rolling 24 hours — and the cases
 * below are the ones where those three answers differ.
 *
 * Pure: no clock, no database, no network.
 */

const windowFor = (day: string, timeZone: string) => {
  const made = makeDayWindow(day, timeZone)
  if (Either.isLeft(made)) return assert.fail(`expected a Day Window, got ${made.left.reason}`)
  return made.right
}

const iso = (at: DateTime.Utc) => DateTime.formatIso(at)

const hoursBetween = (from: DateTime.Utc, to: DateTime.Utc) =>
  (DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from)) / 3_600_000

describe("A Day Window is a calendar day where the User is", () => {
  it("is the UTC day only for somebody in UTC", () => {
    const window = windowFor("2026-08-22", "UTC")

    assert.strictEqual(iso(window.startsAt), "2026-08-22T00:00:00.000Z")
    assert.strictEqual(iso(window.endsAt), "2026-08-23T00:00:00.000Z")
  })

  it("starts at local midnight, which is not UTC midnight", () => {
    const auckland = windowFor("2026-08-22", "Pacific/Auckland")
    const losAngeles = windowFor("2026-08-22", "America/Los_Angeles")

    // The 22nd begins in Auckland while it is still the 21st in UTC, and begins
    // in Los Angeles when UTC has already got to the 22nd.
    assert.strictEqual(iso(auckland.startsAt), "2026-08-21T12:00:00.000Z")
    assert.strictEqual(iso(losAngeles.startsAt), "2026-08-22T07:00:00.000Z")
  })

  it("is not a rolling 24 hours from now, but a day with edges", () => {
    const window = windowFor("2026-08-22", "Europe/Paris")

    assert.strictEqual(iso(window.startsAt), "2026-08-21T22:00:00.000Z")
    assert.strictEqual(iso(window.endsAt), "2026-08-22T22:00:00.000Z")
  })

  it("is 23 hours long on the day the clocks go forward", () => {
    const springForward = windowFor("2026-03-29", "Europe/Paris")

    assert.strictEqual(hoursBetween(springForward.startsAt, springForward.endsAt), 23)
  })

  it("is 25 hours long on the day the clocks go back", () => {
    const fallBack = windowFor("2026-10-25", "Europe/Paris")

    assert.strictEqual(hoursBetween(fallBack.startsAt, fallBack.endsAt), 25)
  })

  it("ends where the next day starts, with no gap and no overlap", () => {
    const first = windowFor("2026-10-25", "Europe/Paris")
    const second = windowFor("2026-10-26", "Europe/Paris")

    assert.strictEqual(iso(first.endsAt), iso(second.startsAt))
  })
})

describe("Refusing what is not a day", () => {
  it("refuses a date that looks like one but is not", () => {
    assert.isTrue(Either.isLeft(makeDayWindow("2026-02-30", "UTC")))
    assert.isTrue(Either.isLeft(makeDayWindow("2026-13-01", "UTC")))
    assert.isTrue(Either.isLeft(makeDayWindow("22-08-2026", "UTC")))
  })

  it("accepts a leap day where there is one", () => {
    assert.isTrue(Either.isRight(makeDayWindow("2024-02-29", "UTC")))
    assert.isTrue(Either.isLeft(makeDayWindow("2026-02-29", "UTC")))
  })

  it("refuses a timezone nobody lives in, and says so", () => {
    const refused = makeDayWindow("2026-08-22", "Mars/Olympus")

    if (Either.isRight(refused)) return assert.fail("expected the zone to be refused")
    assert.include(refused.left.reason, "Mars/Olympus")
  })
})

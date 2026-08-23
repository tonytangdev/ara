import { assert, describe, it } from "@effect/vitest"
import { Repository } from "../../connections/domain/repository.ts"
import {
  AreaChurn,
  CommitSummary,
  Digest,
  DigestTotals,
  FileChurn,
  PullRequestSummary
} from "../../digests/domain/digest.ts"
import { CalendarDay } from "../../runs/domain/day-window.ts"
import { FULL_DRAFT_WORDS, QUIET_DRAFT_WORDS } from "./draft.ts"
import { instructionFor } from "./draft-instruction.ts"

const A_DAY = new Digest({
  repo: new Repository({ forge: "github", owner: "octocat", name: "ara" }),
  day: CalendarDay.make("2026-08-22"),
  commitCount: 2,
  commits: [
    new CommitSummary({ subject: "Add the collect stage", files: ["src/digests/collect.ts", "README.md"] }),
    new CommitSummary({ subject: "Test the collect stage", files: ["src/digests/collect.test.ts"] })
  ],
  pullRequests: [new PullRequestSummary({ number: 6, title: "Build a Digest from real Activity", kind: "merged" })],
  totals: new DigestTotals({ filesTouched: 3, additions: 203, deletions: 5 }),
  topAreas: [new AreaChurn({ dir: "src/digests", churn: 204 })],
  topFiles: [new FileChurn({ path: "src/digests/collect.test.ts", additions: 120, deletions: 0 })],
  isQuiet: false
})

/**
 * What these tests hold: the one part of writing a Draft that has editorial
 * judgement in it stays pure, so the instruction can be read and asserted on
 * without a model, a network or a database.
 *
 * They deliberately do not assert the wording of the voice. Prose is not a unit
 * test; what is testable is that the model is told the truth about the day, is
 * told what shape to write in, and is given nothing it was not meant to have.
 */
describe("What the model is told about a day", () => {
  it("puts the day's own facts in front of it", () => {
    const { brief } = instructionFor(A_DAY)

    assert.include(brief, "octocat/ara")
    assert.include(brief, "2026-08-22")
    assert.include(brief, "Add the collect stage")
    assert.include(brief, "Test the collect stage")
    assert.include(brief, "src/digests/collect.ts")
    assert.include(brief, "#6 Build a Digest from real Activity (merged)")
    assert.include(brief, "3 files touched, +203 / -5 lines")
    assert.include(brief, "src/digests (204 lines changed)")
  })

  it("says what shape to write in", () => {
    const { voice } = instructionFor(A_DAY)

    assert.include(voice, `${FULL_DRAFT_WORDS.min} to ${FULL_DRAFT_WORDS.max} words`)
    // The honesty rule the prototype made necessary: a word floor over thin
    // material is what makes a model invent, so it is told not to.
    assert.include(voice, "Never invent")
  })

  it("has nothing to say about a day with nothing in it", () => {
    const { brief } = instructionFor(
      new Digest({
        ...A_DAY,
        commitCount: 0,
        commits: [],
        pullRequests: [],
        totals: new DigestTotals({ filesTouched: 0, additions: 0, deletions: 0 }),
        topAreas: [],
        topFiles: [],
        isQuiet: true
      })
    )

    assert.include(brief, "Commits (0):")
    // An empty section says so rather than trailing off, which is the
    // difference between "nothing happened" and "the record was truncated".
    assert.include(brief, "(none)")
  })

  /**
   * ADR-0004 in a test. There is no source code in a Digest to leak, and the
   * instruction is built from the Digest and from nothing else — no repository
   * handle, no diff, no way to fetch more. If a `patch` field ever appears in a
   * Digest, this is one of the tests that should stop it.
   */
  it("can carry no source code, because it is built from the Digest alone", () => {
    const { brief, voice } = instructionFor(A_DAY)
    const everything = `${voice}\n${brief}`

    for (const fact of everything.split("\n")) {
      assert.notInclude(fact, "@@")
      assert.notInclude(fact, "diff --git")
    }

    // Paths and counts, never contents: every commit line names files and says
    // nothing about what is in them.
    assert.include(brief, "- Add the collect stage [src/digests/collect.ts, README.md]")
  })
})

/**
 * The Quiet Day, at the seam where it changes what the model is asked.
 *
 * The decision itself is not made here — it was made when the Digest was built,
 * deterministically and before anything was called. What these tests hold is
 * that the decision is *acted on*: a light day is asked for a shorter post, told
 * it may say the day was light, and told not to fill the space anyway.
 */
describe("What the model is told about a Quiet Day", () => {
  const A_LIGHT_DAY = new Digest({
    ...A_DAY,
    commitCount: 1,
    commits: [new CommitSummary({ subject: "Fix the day boundary", files: ["src/runs/day-window.ts"] })],
    pullRequests: [],
    totals: new DigestTotals({ filesTouched: 1, additions: 6, deletions: 2 }),
    topAreas: [new AreaChurn({ dir: "src/runs", churn: 8 })],
    topFiles: [new FileChurn({ path: "src/runs/day-window.ts", additions: 6, deletions: 2 })],
    isQuiet: true
  })

  it("asks for a Quiet Draft, and says so in the shape", () => {
    assert.strictEqual(instructionFor(A_LIGHT_DAY).shape, "quiet")
    assert.strictEqual(instructionFor(A_DAY).shape, "full")
  })

  it("asks for far fewer words than a full Draft", () => {
    const { voice } = instructionFor(A_LIGHT_DAY)

    assert.include(voice, `${QUIET_DRAFT_WORDS.min} to ${QUIET_DRAFT_WORDS.max} words`)
    // The floor that makes a model invent on thin material is nowhere near it.
    assert.notInclude(voice, `${FULL_DRAFT_WORDS.min} to ${FULL_DRAFT_WORDS.max} words`)
    assert.isBelow(QUIET_DRAFT_WORDS.max, FULL_DRAFT_WORDS.min)
  })

  it("permits the day to have been light, and forbids padding it", () => {
    const { voice } = instructionFor(A_LIGHT_DAY)

    assert.include(voice, "This was a light day")
    assert.include(voice, "not apologetic")
    assert.include(voice, "Do not pad")
    assert.include(voice, "Stopping early is better than padding")
    // The honesty rules the full voice carries are not traded away for the
    // permission: a shorter post is still not allowed to invent.
    assert.include(voice, "Never invent")
  })

  it("still puts the day's own facts in front of it, and only those", () => {
    const { brief } = instructionFor(A_LIGHT_DAY)

    assert.include(brief, "Commits (1):")
    assert.include(brief, "- Fix the day boundary [src/runs/day-window.ts]")
    assert.include(brief, "1 files touched, +6 / -2 lines")
    assert.notInclude(brief, "Add the collect stage")
  })
})

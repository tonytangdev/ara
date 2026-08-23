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
import { FULL_DRAFT_WORDS } from "./draft.ts"
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

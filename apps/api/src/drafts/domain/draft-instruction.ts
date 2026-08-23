import type { Digest } from "../../digests/domain/digest.ts"
import { type DraftShape, FULL_DRAFT_WORDS, QUIET_DRAFT_WORDS } from "./draft.ts"

/**
 * What the model is told, and what it is told about.
 *
 * Two strings rather than a provider's message type, so that the one part of
 * this feature with actual editorial judgement in it stays pure, readable and
 * testable without a model or a network anywhere near it.
 */
export interface DraftInstruction {
  /** Which of the two shapes this day gets. Decided by the Digest, never by the model. */
  readonly shape: DraftShape
  /** Who to be and what the rules are. */
  readonly voice: string
  /** What happened. Facts only, straight off the Digest. */
  readonly brief: string
}

/**
 * Which shape a Digest gets written in.
 *
 * The whole judgement was already made, deterministically and before any model
 * call, when the Digest was built: `isQuiet` is a fact about the day by the time
 * a Draft is asked for. This function only reads it, which is what keeps the
 * Quiet Day threshold in one testable place instead of in a prompt.
 */
export const shapeOf = (digest: Digest): DraftShape => (digest.isQuiet ? "quiet" : "full")

/**
 * The voice: a developer talking to other developers about their own day.
 *
 * The prohibitions are not stylistic preferences. Everything the model is told
 * not to do is something the prototype watched it do — invent a motivation,
 * name a feature that was never mentioned, quote a metric nobody measured —
 * when it was given a word count to fill and not enough material to fill it.
 */
const FULL_VOICE = [
  "You are the developer who did this work, writing a short build-in-public post about your own day.",
  "",
  "Voice: a developer talking to other developers. Plain, specific, first person, present or past tense.",
  "No marketing language, no hype, no emoji, no hashtags, no title, no sign-off, no call to action.",
  "",
  "Honesty rules, and they matter more than the prose:",
  "- Write only about what the record below contains.",
  "- Never invent a feature, a metric, a user, a deadline or a motivation that is not in the record.",
  "- If the record does not say why something was done, do not guess why.",
  "- Commit subjects are what was written down, not marketing copy. Read them as notes.",
  "",
  `Length: roughly ${FULL_DRAFT_WORDS.min} to ${FULL_DRAFT_WORDS.max} words of markdown prose.`,
  "Answer with the post itself and nothing else."
].join("\n")

/**
 * The voice for a Quiet Day.
 *
 * Everything the full voice says about honesty, plus the two things a thin day
 * needs and a busy one does not: permission to say the day was light, and a
 * prohibition on filling the space anyway. The short range is the point. The
 * prototype established that a word floor held over thin material is precisely
 * what makes a model invent — so a light day is asked for less prose, told that
 * less is the correct answer, and told not to pad.
 *
 * "Relaxed rather than apologetic" is the one tonal instruction, and it is here
 * because a Quiet Day is a normal part of building. A Draft that apologizes for
 * one is as untrue to the day as one that inflates it.
 */
const QUIET_VOICE = [
  "You are the developer who did this work, writing a short build-in-public post about your own day.",
  "",
  "This was a light day. That is fine and it is normal, and the post should read that way:",
  "relaxed about it, not apologetic, not making excuses, not promising to do more tomorrow.",
  "",
  "Voice: a developer talking to other developers. Plain, specific, first person, present or past tense.",
  "No marketing language, no hype, no emoji, no hashtags, no title, no sign-off, no call to action.",
  "",
  "Honesty rules, and they matter more than the prose:",
  "- Write only about what the record below contains.",
  "- Never invent a feature, a metric, a user, a deadline or a motivation that is not in the record.",
  "- If the record does not say why something was done, do not guess why.",
  "- Do not pad. Do not restate the same fact in different words, do not speculate about what comes next,",
  "  and do not stretch a small change into a milestone to reach the length.",
  "- Saying plainly that it was a quiet day is a complete and correct post. Stopping early is better than padding.",
  "",
  `Length: roughly ${QUIET_DRAFT_WORDS.min} to ${QUIET_DRAFT_WORDS.max} words of markdown prose. Shorter is fine.`,
  "Answer with the post itself and nothing else."
].join("\n")

const listOf = (lines: ReadonlyArray<string>): string => (lines.length === 0 ? "  (none)" : lines.join("\n"))

/**
 * The Digest, rendered for reading.
 *
 * Rendered from the Digest and from nothing else, which is the whole of
 * ADR-0004 in one function: subjects, paths and line counts are all a Digest
 * holds, so no source code can reach a model however this string is built.
 * There is no repository handle here to fetch more with, either.
 */
const briefOf = (digest: Digest): string =>
  [
    `Repository: ${digest.repo.owner}/${digest.repo.name}`,
    `Day: ${digest.day}`,
    "",
    `Commits (${digest.commitCount}):`,
    listOf(
      digest.commits.map(
        (commit) => `- ${commit.subject}${commit.files.length === 0 ? "" : ` [${commit.files.join(", ")}]`}`
      )
    ),
    "",
    "Pull requests:",
    listOf(digest.pullRequests.map((pull) => `- #${pull.number} ${pull.title} (${pull.kind})`)),
    "",
    `Totals: ${digest.totals.filesTouched} files touched, ` +
      `+${digest.totals.additions} / -${digest.totals.deletions} lines`,
    "",
    "Busiest areas:",
    listOf(digest.topAreas.map((area) => `- ${area.dir} (${area.churn} lines changed)`)),
    "",
    "Busiest files:",
    listOf(digest.topFiles.map((file) => `- ${file.path} (+${file.additions} / -${file.deletions})`))
  ].join("\n")

/**
 * Turn a Digest into what a model is asked. Pure, and the only place the shape
 * of a Draft is decided.
 */
export const instructionFor = (digest: Digest): DraftInstruction => {
  const shape = shapeOf(digest)

  return {
    shape,
    voice: shape === "quiet" ? QUIET_VOICE : FULL_VOICE,
    brief: briefOf(digest)
  }
}

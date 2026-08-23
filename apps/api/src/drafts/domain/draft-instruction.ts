import type { Digest } from "../../digests/domain/digest.ts"
import { FULL_DRAFT_WORDS } from "./draft.ts"

/**
 * What the model is told, and what it is told about.
 *
 * Two strings rather than a provider's message type, so that the one part of
 * this feature with actual editorial judgement in it stays pure, readable and
 * testable without a model or a network anywhere near it.
 */
export interface DraftInstruction {
  /** Who to be and what the rules are. */
  readonly voice: string
  /** What happened. Facts only, straight off the Digest. */
  readonly brief: string
}

/**
 * The voice: a developer talking to other developers about their own day.
 *
 * The prohibitions are not stylistic preferences. Everything the model is told
 * not to do is something the prototype watched it do — invent a motivation,
 * name a feature that was never mentioned, quote a metric nobody measured —
 * when it was given a word count to fill and not enough material to fill it.
 */
const VOICE = [
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
export const instructionFor = (digest: Digest): DraftInstruction => ({
  voice: VOICE,
  brief: briefOf(digest)
})

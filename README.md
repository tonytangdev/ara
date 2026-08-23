# Prototype: does the Digest/Draft split lose anything?

**Throwaway code. Do not merge into `main`.** This branch exists as the primary source
behind ADR-0002 (the Digest/Draft split) and ADR-0004 (no diffs in the Digest).

## The question

Ara builds a factual **Digest** from a repository's Activity, then writes a **Draft** from
that Digest alone. The structural benefits of that split were never in doubt — the
deterministic half becomes unit-testable, regeneration costs one model call and zero Forge
calls, and it gives a clean idempotency boundary. Only one thing needed testing:

> Is the Digest **lossy**? Does throwing away everything except commit subjects, file paths
> and line counts produce a worse Draft than handing the model the raw material?

## Method

Three arms, same model (`moonshotai/kimi-k3` via OpenRouter), 8 real repo-days:

- **A** — near-raw GitHub payload: full commit messages, PR titles and bodies, file lists
- **B** — the normalized Digest: commit subject, file paths, line counts, bots and lockfiles stripped
- **C** — the Digest plus diff hunks

Days sampled: `tonytangdev-v2` on 2026-06-06, 06-07 (41 commits), 06-08 (2 commits), 06-09,
07-04; `easy-chores` on 2026-07-05, 07-12; `rising-stars` on 2026-07-19.

Outputs were judged **blind**: `build-judge.mjs` produces a single-file harness that shuffles
the three drafts per day with a fixed seed, hides which arm is which, and only reveals the
mapping after best/worst has been picked for every day. Blinding was verified after the fact
— B appeared at positions 0, 1 and 2 across the days, so position was not a tell.

Four outcomes were **pre-registered before any output was seen**:

| Result | Interpretation |
|---|---|
| B ≈ A | the split is free — build as designed |
| B < A | widen the Digest schema (likely PR bodies, full commit bodies) and retest |
| C >> A, B | diff summarization moves into v1 |
| all mediocre | the bottleneck is prompt and voice, not the pipeline |

## The verdict

**B won 7 of 7 judged days.** C was the **worst** output on every day it was judged. A was
never best and never worst.

So the Digest is not lossy — it is an *improvement*. Stripping the material down to what
actually happened stops the model drowning in noise. And diffs actively hurt: they pull the
prose toward line-by-line narration of code instead of an account of the day's work.

That result **reversed a prediction**. Arm C was expected to be the quality ceiling, with the
plan being to move diff summarization into v1 if it dominated. It came last. ADR-0004 records
this and asks anyone proposing diff summarization to re-run the experiment rather than assume.

Two secondary findings:

- Excluding diffs is also **5–10x cheaper** (600–3,600 input tokens versus 17,000–18,500) and
  means private source never leaves our infrastructure.
- `quiet.mjs` tested the Quiet Draft instruction against the 2-commit day. The 150–250 word
  floor is what **causes fabrication**: the standard draft invented an `ARTICLE-IDEAS.md`
  backstory and an emotional arc that appear nowhere in the Digest. The shorter Quiet Draft
  target is therefore a **correctness** measure, not a stylistic one.

One operational finding, now an acceptance criterion on the Draft ticket: the model sometimes
returns a response carrying reasoning but **null message content**. It is not an HTTP error,
and a naive adapter persists an empty Draft.

## What is not on this branch

The inputs and outputs — `data/activity.json`, `data/drafts.json`, `data/drafts.jsonl` and the
built `judge.html` — are **deliberately absent**. All three repositories sampled are private,
`activity.json` carries 627 diff patches, and this repository is public. They are kept locally
outside the repo. Re-run `fetch.mjs` against your own repositories to regenerate them.

`.env` held an OpenRouter API key and was never copied anywhere.

## Running it

Needs `gh` authenticated and `OPENROUTER_API_KEY` in a local `.env`.

```
node scripts/fetch.mjs        # pull repo-days, strip bots, merges, lockfiles
node scripts/generate.mjs     # 3 arms x 8 days, 6 workers, JSONL checkpointed and resumable
node scripts/build-judge.mjs  # emit the blind judging harness
node scripts/quiet.mjs        # the Quiet Day instruction test
```

`gen.log` is the real run's log, kept for the null-content failure it captured.

# Diffs are deliberately excluded from the Digest

A Digest records commit subjects, file paths and line counts. It does **not**
include diff hunks, and no stage of a Run sends source code to a language model.

This looks like a missing feature — diffs carry the "why" that commit messages
often lack, and feeding them to the model is the obvious way to get richer posts.
We tested it and the opposite is true.

## Considered Options

A blind comparison over 8 real repo-days, same model and same instruction,
varying only the input: **A** raw Forge payload (full commit messages, PR titles
and bodies, file lists), **B** the Digest, **C** the Digest plus diff hunks. The
author judged the posts unlabelled and shuffled.

B won 7 of 7 judged days. **C was the worst post on every day it was judged.**
Diffs drown the model in line-level detail and it writes about mechanics instead
of meaning. A was never best and never worst.

## Consequences

Excluding diffs is also 5-10x cheaper (600-3,600 input tokens versus
17,000-18,500) and means private source never leaves our infrastructure, which
removes a disclosure we would otherwise owe every User.

If someone proposes adding diff summarization to improve Draft quality, this is
the evidence against it. Re-run the experiment before reversing; do not assume.
Prototype and data: the `prototype/digest-split` branch.

---
name: review-quality
version: 1
model: jev-1.13.0
state:
  required: [review]
  budget_tokens: 12000
questions:
  thoroughness:
    type: score
    instructions: "How closely did the reviewer read the change, judging by `review.comments` and `review.summary`?"
    criteria:
      - "skimmed: a nod, or a couple of surface remarks"
      - "reasonable: the main paths are covered and the comments name specific lines"
      - "thorough: edge cases, error handling and tests are covered, and the summary says what was read"
    verdict: { act: 0.75, mark: 0.55 }
  constructive:
    type: noul
    instructions: "Is the wording in `review.comments` and `review.summary` helpful to the author?"
    criteria:
      true: "The comments say what to change and why, and they stay about the code."
      false: "The comments are dismissive, personal, or leave the author guessing."
    verdict: { act: 0.85, mark: 0.7 }
  found_a_real_defect:
    type: noul
    instructions: "Does any comment in `review.comments` point at behaviour that would be wrong once shipped?"
    criteria:
      true: "At least one comment names a bug, a missing case, a data problem or a security hole."
      false: "The comments are about style, naming, structure or questions."
    verdict: { act: 0.85, mark: 0.7 }
---
# review-quality

## When to use

On a finished code review, to see how much attention the change got and how the author will read it.

## State

`review`: `{ "pr": "...", "comments": [{ "file": "...", "text": "..." }], "summary": "..." }`. `comments` are the reviewer's comments in the order they were left, and `summary` is the review body the reviewer submitted with them.

## Verdicts

`thoroughness` at level 0 with `act`: ask for a second review before the merge. Level 2 with `act`: let one approval carry the change. `mark`: apply the level and flag the review for the team lead. `fall_back`: use your normal review rules.
`constructive` no with `act`: hold the review and ask the reviewer to rewrite the wording. `found_a_real_defect` yes with `act`: count the review in the numbers you report on defects caught before release.

## Example

The example state holds a review of a webhook retry change with three comments, two of them about behaviour that would be wrong once shipped, and a summary saying what was read. It answers `thoroughness` at level 2, `constructive` yes and `found_a_real_defect` yes.

---
name: review-quality
version: 3
model: jev-1.13.0
state:
  required: [review]
  budget_tokens: 12000
questions:
  thoroughness:
    type: score
    instructions:
      question: "Which of these situations do `review.comments` and `review.summary` read like?"
      inspect: "every entry in `review.comments`, and `review.summary`"
      focus: "Judge how far into the change the comments reach. How many comments there are and how friendly they sound stay out of this."
    criteria:
      - what: "The comments stay on the surface, such as naming, formatting or a nod, and the logic of the change goes unmentioned"
        signals:
          - "LGTM"
          - "rename this variable"
          - "missing trailing comma"
      - what: "The comments discuss the logic of the files that changed: a condition, a loop, an error path inside the change"
        signals:
          - "this loop stops one page early"
          - "the error is swallowed in this catch"
          - "this branch is never reached"
      - what: "The comments follow the change beyond the changed lines, into its callers, its tests and the data it writes"
        signals:
          - "the dashboard reads this column and will show the wrong time"
          - "the worker that calls this still passes the old argument"
          - "add a test for the path support sees most"
    thresholds: { act: 0.75, mark: 0.55 }
  constructive:
    type: noul
    instructions:
      question: "Is the wording of `review.comments` and `review.summary` helpful to the author?"
      inspect: "the wording of every entry in `review.comments`, and `review.summary`"
      focus: "Judge the wording toward the author. Whether the reviewer is right about the code stays out of this."
    criteria:
      true:
        what: "The comments say what to change and why, and they talk about the code"
        examples:
          - "the backoff waits 15 minutes where the issue asks for 25, worth matching"
          - "rename d to delay, one letter names are hard to search for"
      false:
        what: "The comments are dismissive or personal, or leave the author guessing what to change"
        examples:
          - "this is a mess"
          - "did you even run it?"
          - "no"
    thresholds: { act: 0.85, mark: 0.7 }
  found_a_real_defect:
    type: noul
    instructions:
      question: "Does a comment in `review.comments` name behaviour that would be wrong once shipped?"
      inspect: "every entry in `review.comments`"
      focus: "Look for a comment that says what the code would do wrong. A remark about naming, formatting or taste names no wrong behaviour."
    criteria:
      true:
        what: "A comment names a bug, a missing case, a data problem or a security hole"
        examples:
          - "an empty batch throws here"
          - "the retried delivery keeps its first timestamp, so the dashboard shows the wrong time"
          - "this loop stops one page early"
      false:
        what: "The comments are about style, naming, structure or questions, or say the change is fine"
        examples:
          - "rename this variable"
          - "LGTM"
          - "why a map here?"
    thresholds: { act: 0.85, mark: 0.7 }
---
# review-quality

## When to use

On a finished code review, to see how much attention the change got and how the author will read it.

## State

`review`: `{ "pr": "...", "comments": [{ "file": "...", "text": "..." }], "summary": "..." }`. `comments` are the reviewer's comments in the order they were left, and `summary` is the review body the reviewer submitted with them.

## Decisions

`thoroughness` at level 0 with `act`: ask for a second review before the merge. Level 2 with `act`: let one approval carry the change. `mark`: apply the level and flag the review for the team lead. `fall_back`: use your normal review rules.
`constructive` no with `act`: hold the review and ask the reviewer to rewrite the wording. `found_a_real_defect` yes with `act`: count the review in the numbers you report on defects caught before release.

## Example

The example state holds a review of a webhook retry change with three comments, two of them about behaviour that would be wrong once shipped, and a summary saying what was read. It answers `thoroughness` at level 2, `constructive` yes and `found_a_real_defect` yes.

---
name: duplicate-issue
version: 1
model: jev-1.13.0
state:
  required: [issue, candidates]
  budget_tokens: 12000
questions:
  same_as:
    type: noul
    repeat: { over: candidates, as: candidate }
    instructions: "Does `candidate` report the same problem as `issue`?"
    criteria:
      true: "Both describe the same behaviour in the same part of the product, even in different words."
      false: "Different behaviour, a different part of the product, or one is a question and the other a bug."
    verdict: { act: 0.85, mark: 0.7 }
  actionable:
    type: noul
    instructions: "Does `issue` say what was done, what happened, and what was expected instead?"
    criteria:
      true: "All three are there, so somebody can reproduce it."
      false: "At least one of the three is missing."
    verdict: { act: 0.8, mark: 0.6 }
---
# duplicate-issue

## When to use

When a new issue lands in your tracker, to link it to an open one and to check that somebody can work on it.

## State

`issue`: `{ "title": "...", "body": "..." }`. `candidates`: an array of open issues in the same shape, filtered in your code first (same labels, last 90 days, at most a few dozen).

## Verdicts

`same_as[i]` yes with `act`: link the new issue to candidate `i` and close it. `mark`: link it and ask the reporter to confirm. `actionable` no with `act`: ask for the steps before anyone picks it up.

## Example

Issue "Export button does nothing on Safari" against candidates ["Export fails in Safari 17", "Dark mode colours wrong on the settings page"] answers `same_as[0]` yes and `same_as[1]` no.

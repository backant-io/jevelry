---
name: duplicate-issue
version: 3
model: jev-1.13.0
state:
  required: [issue, candidates]
  budget_tokens: 12000
questions:
  same_as:
    type: noul
    repeat: { over: candidates, as: candidate }
    instructions:
      question: "Does `candidate` report the same problem as `issue`?"
      inspect: "`issue.title`, `issue.body`, `candidate.title` and `candidate.body`"
      compare: "The behaviour `issue.body` describes against the behaviour `candidate.body` describes"
      focus: "Two reports of one problem stay one problem when the wording, the version number or the browser differ."
    criteria:
      true:
        what: "Both reports describe the same behaviour in the same part of the product, in different words or with different version numbers"
        examples:
          - "one says the export button does nothing, the other says the CSV export finishes with no download"
          - "one names Safari 17 and the other names Safari 17.2"
      false:
        what: "The two reports describe different behaviour, name different parts of the product, or one asks how something works while the other reports a defect"
        examples:
          - "one is about the export button and the other is about dark mode colours"
          - "one reports a crash and the other asks how a setting works"
    thresholds: { act: 0.85, mark: 0.7 }
  actionable:
    type: noul
    instructions:
      question: "Does `issue` say what was done, what happened, and what was expected instead?"
      inspect: "`issue.title` and `issue.body`"
      focus: "Read the three parts one at a time: the steps the reporter took, the result they saw, and the result they wanted."
    criteria:
      true:
        what: "The report names the steps taken, the result that appeared, and the result the reporter wanted"
        examples:
          - "Clicked Export on the reports page, the page stayed still, expected a CSV file"
          - "Ran the sync, got a 500, expected the rows to appear"
      false:
        what: "At least one of the three is missing: the steps taken, the result that appeared, or the result the reporter wanted"
        examples:
          - "Export is broken"
          - "This page has been buggy for a week, please fix"
    thresholds: { act: 0.8, mark: 0.6 }
---
# duplicate-issue

## When to use

When a new issue lands in your tracker, to link it to an open one and to check that somebody can work on it.

## State

`issue`: `{ "title": "...", "body": "..." }`. `candidates`: an array of open issues in the same shape, filtered in your code first (same labels, last 90 days, at most a few dozen).

## Decisions

`same_as[i]` yes with `act`: link the new issue to candidate `i` and close it. `mark`: link it and ask the reporter to confirm. `actionable` no with `act`: ask for the steps before anyone picks it up.

## Example

The Safari export report in `example.json`, against a candidate about a silent CSV export in Safari 17 and a candidate about dark mode colours, answers `same_as[0]` yes, `same_as[1]` no and `actionable` yes.

---
name: issue-readiness
version: 3
model: jev-1.13.0
state:
  required: [issue]
  budget_tokens: 8000
questions:
  readiness:
    type: score
    instructions:
      question: "Which of these situations does `issue` read like?"
      inspect: "`issue.title` and the whole of `issue.body`, headings included"
      focus: "Judge what the issue hands the person who picks it up. How large the work is stays out of this."
    criteria:
      - what: "The issue is an idea in a sentence or two and hands the reader no way to start: the steps, the result and the way to tell it is done are all open"
        signals:
          - "make search faster"
          - "the onboarding needs work"
          - "a title with one line of wish under it"
      - what: "The goal is clear and one named piece is open: the steps, the result, how far the work reaches, or the line that says how anybody tells the work is finished"
        signals:
          - "the behaviour and the steps are written out and no line says when the work is done"
          - "a clear result, and which systems it covers is left open"
          - "a template heading with empty space under it"
      - what: "The issue says what to do, what should happen and how far the work reaches, and it carries a line that says how anybody tells the work is finished"
        signals:
          - "done when a dollar plan shows USD 120.00 in both places"
          - "acceptance criteria listed one by one, with the tests named"
          - "scope is the outbound worker, inbound handling stays as it is, done when both cases are covered"
    thresholds: { act: 0.75, mark: 0.55 }
  missing:
    type: choice
    instructions:
      question: "Which of the four pieces below does `issue` leave out?"
      inspect: "`issue.title` and the whole of `issue.body`, headings included"
      focus: "Read the issue for the four pieces one at a time: the steps, the expected result, how anybody tells the work is finished, and how far the work reaches. A sentence that says what to change counts as the steps, with a numbered list or without one."
    criteria:
      steps:
        what: "The issue leaves out what to do: no sentence in it says what to change, what to build, or for a bug report, how to reach the situation"
        not_for: "An issue where one sentence says what to change and where, which carries its steps even when it lists none of them one by one, or one that says what to do and leaves out what should happen, which belongs to expected_result"
        examples:
          - "Fix the login bug."
          - "The numbers in the report are wrong, please correct them."
      expected_result:
        what: "The issue says what to do and leaves out what should happen once the work is done"
        not_for: "An issue that also leaves out what to do, which belongs to several, or one that names the result and leaves out how anybody tells it is finished, which belongs to acceptance"
        examples:
          - "Add a retry to the webhook worker."
          - "Move the export to a nightly job."
      acceptance:
        what: "The issue says what to do and what should happen, and leaves out how anybody tells the work is finished"
        not_for: "An issue that leaves out what should happen, which belongs to expected_result, or one that leaves out how far the work reaches, which belongs to scope"
        examples:
          - "Retry a failed delivery after 1, 5 and 25 minutes, and the customer sees the event."
          - "a described behaviour with no done when line and no tests named"
      scope:
        what: "The issue says what to do, what should happen and how anybody tells the work is finished, and leaves out how far the work reaches: which systems or which cases it covers"
        not_for: "An issue that leaves out how anybody tells the work is finished, which belongs to acceptance"
        examples:
          - "Retry failed deliveries, done when a retried delivery is recorded as delivered."
          - "a done when line, and nothing saying which services this covers"
      several:
        what: "Two or more of the four pieces are open, and the issue reads as an idea rather than as a piece of work"
        not_for: "An issue where the goal and the steps are there and one piece is open, which belongs to that one piece"
        examples:
          - "Make search faster."
          - "The onboarding needs work."
          - "We should support teams."
      nothing:
        what: "The issue carries all four pieces: what to do, what should happen, how far the work reaches, and how anybody tells the work is finished"
        not_for: "An issue with one of the four pieces open, which belongs to that piece, or one that reads as an idea, which belongs to several"
        examples:
          - "the change, the pages it covers and a done when line, each written out"
          - "Scope is the invoice list and the detail page; done when a dollar plan shows USD 120.00 and tests cover both."
    thresholds: { act: 0.8, mark: 0.6 }
---
# issue-readiness

## When to use

On a new issue or proposal before it reaches a backlog, to tell the ones somebody can start on from the ones that go back to the author.

## State

`issue`: `{ "title": "...", "body": "..." }` as it was filed. Send the body whole, including the headings the template produced, because the missing piece is usually a heading with empty space under it.

## Decisions

`readiness` at level 2 with `act`: move the issue into the ready column. Level 0 with `act`: send it back to the author. `mark`: move it as the level says and flag it for the person who grooms the backlog. `fall_back`: leave the issue in triage.
`missing` with `act`: ask the author for that one piece, in the words the option names. `several` with `act`: send the issue back and ask the author to write the work out. `nothing` with `act`: the issue goes to the backlog as it stands.

## Example

The example state holds an issue about retrying failed webhook deliveries, with the retry schedule, the scope and the acceptance criteria written out. It answers `readiness` at level 2 and `missing` = `nothing`.

---
name: issue-readiness
version: 1
model: jev-1.13.0
state:
  required: [issue]
  budget_tokens: 8000
questions:
  readiness:
    type: score
    instructions: "How ready is `issue` for somebody to start on it?"
    criteria:
      - "vague: a sentence or two of wish, with the work left open"
      - "missing_pieces: the goal is clear, and at least one of steps, expected result, acceptance or scope is open"
      - "ready: somebody can pick it up and tell when they are done"
    verdict: { act: 0.75, mark: 0.55 }
  missing:
    type: choice
    instructions: "Which of the four pieces below does `issue` leave out, if it leaves out any?"
    criteria:
      steps: "What to do is left out, or for a bug report, how to reach the situation. The plan for how to build it belongs to whoever picks the issue up, so an issue that leaves that open still counts as carrying its steps."
      expected_result: "What should happen once the work is done is left out."
      acceptance: "How anybody tells the work is finished is left out."
      scope: "How far the work reaches, which systems or cases it covers, is left out."
      nothing: "`issue` carries all four pieces, so somebody can start on it as it stands."
    verdict: { act: 0.8, mark: 0.6 }
---
# issue-readiness

## When to use

On a new issue or proposal before it reaches a backlog, to tell the ones somebody can start on from the ones that go back to the author.

## State

`issue`: `{ "title": "...", "body": "..." }` as it was filed. Send the body whole, including the headings the template produced, because the missing piece is usually a heading with empty space under it.

## Verdicts

`readiness` at level 2 with `act`: move the issue into the ready column. Level 0 with `act`: send it back to the author. `mark`: move it as the level says and flag it for the person who grooms the backlog. `fall_back`: leave the issue in triage.
`missing` with `act`: ask the author for that one piece, in the words the option names. `nothing` with `act`: the issue goes to the backlog as it stands.

## Example

The example state holds an issue about retrying failed webhook deliveries, with the retry schedule, the scope and the acceptance criteria written out. It answers `readiness` at level 2 and `missing` = `nothing`.

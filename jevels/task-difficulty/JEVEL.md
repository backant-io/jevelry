---
name: task-difficulty
version: 1
model: jev-1.13.0
state:
  required: [task]
  budget_tokens: 8000
questions:
  depth:
    type: score
    instructions: "How much thinking does `task` take to finish?"
    criteria:
      - "routine: a known pattern, and the steps follow from `task.description`"
      - "judgment: trade-offs to weigh, and several designs would work"
      - "hard: the approach itself has to be worked out, and getting it wrong is expensive"
    verdict: { act: 0.7, mark: 0.55 }
  needs_specialist:
    type: noul
    instructions: "Does `task` call for somebody with specific expertise, such as security, databases, infrastructure or a regulated domain?"
    criteria:
      true: "The description or the acceptance names a field where a generalist would be guessing."
      false: "A competent generalist can finish it with what `task` says."
    verdict: { act: 0.85, mark: 0.7 }
  well_specified:
    type: noul
    instructions: "Do `task.description` and `task.acceptance` together say what done looks like?"
    criteria:
      true: "The work and the finish line are both stated, so somebody can start on it today."
      false: "The description or the acceptance leaves the finish line open."
    verdict: { act: 0.8, mark: 0.6 }
---
# task-difficulty

## When to use

Before you route a task, to send the routine ones to a cheap model or a junior hand and keep the deep ones for a strong model or an experienced person.

## State

`task`: `{ "title": "...", "description": "...", "acceptance": "..." }`. Send the task as it stands in your tracker, so the answers are about the task somebody will actually pick up.

## Verdicts

`depth` at level 0 with `act`: route it to the cheap model. Level 2 with `act`: route it to the strong model or to a person. `mark`: route it as the level says and flag it for the person who owns the queue. `fall_back`: route it the way you routed tasks before this jevel.
`needs_specialist` yes with `act`: put it in the specialist queue whatever the depth says. `well_specified` no with `act`: send it back to the author and ask for the missing piece before anybody starts.

## Example

The example state holds a task that adds a `--json` flag to an export command, with acceptance criteria. It answers `depth` at level 0, `needs_specialist` no and `well_specified` yes.

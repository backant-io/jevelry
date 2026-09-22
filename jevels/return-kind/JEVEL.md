---
name: return-kind
version: 1
model: jev-1.13.0
state:
  required: [return]
  budget_tokens: 8000
questions:
  kind:
    type: choice
    instructions: "What does `return.reason` say is wrong with the work?"
    criteria:
      defect_in_work: "The reason names something wrong in the work itself: behaviour, tests, correctness, an unmet acceptance clause."
      procedural: "The reason names only a rule of the process: a commit shape, a missing report field, a branch or gate formality, with nothing wrong in the work itself."
      environment: "The reason names only the machine or the provider: a missing binary, a timeout, a rate limit, a red that the base caused."
      unclear: "The reason does not say what is wrong."
    verdict: { act: 0.8, mark: 0.6 }
  actionable:
    type: noul
    instructions: "Does `return.reason` tell the person who will fix it what to change?"
    criteria:
      true: "It names the file, the test, the clause or the behaviour to change."
      false: "It says only that the work was returned, or repeats a verdict without a location."
    verdict: { act: 0.85, mark: 0.7 }
---
# return-kind

## When to use

On every `task.returned` event, to read the reason as a kind the office can count without reading anybody's mind.

## State

`return`: `{ "task_id": "...", "reason": "<the reason verbatim>", "faults": ["..."] }`. Send the reason and the named faults only; not the diff, not the transcript.

## Verdicts

`kind` with `act`: count the return under that kind. `mark`: count it and flag it for a manager's eye. `fall_back`: count it as `unclear`.
`actionable` no with `act`: the reviewer's return is a bounce, not a finding. `mark` (certainty from 0.7 to 0.85, the runtime default this question keeps): count it and flag it for a manager's eye.

## Example

State `{ "return": { "task_id": "task_1", "reason": "faults: tests\nthe new test never runs: it is behind a cfg flag nobody sets", "faults": ["tests"] } }` answers `kind` = `defect_in_work` and `actionable` yes.

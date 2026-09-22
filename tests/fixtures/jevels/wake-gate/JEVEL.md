---
name: wake-gate
version: 1
model: jev-1.13.0
state:
  required: [employee, events]
  budget_tokens: 12000
verdict:
  act: 0.9
  mark: 0.7
questions:
  worth_a_turn:
    type: noul
    instructions: "Does any event in `events` require an act that `employee`, holding `employee.authority`, must perform now?"
    criteria:
      true: "An event names work, a review, a message or a decision only this employee can act on."
      false: "Every event is informational, already handled, or for somebody else."
  depth:
    type: score
    instructions: "How much reasoning does acting on `events` need?"
    criteria:
      - "routine: a known verb on a known object"
      - "judgment: a choice between reasonable options"
      - "hard: the answer depends on reading and weighing several records"
    verdict: { act: 0.7 }
  same_as:
    type: noul
    repeat: { over: candidates, as: candidate }
    instructions: "Does `candidate` describe the same incident as `filing`?"
    verdict: { act: 0.85 }
---
# wake-gate

## When to use

Before waking an employee on its own mail.

## State

`employee` (title, authority), `events` (kind, actor, subject, summary), optional `candidates` and `filing`.

## Verdicts

`worth_a_turn` no with `act`: skip the turn. Anything else: wake as before.

## Example

State `{ "employee": { "title": "COO", "authority": ["read_readings"] }, "events": [], "candidates": [], "filing": {} }` answers `worth_a_turn` near 0.

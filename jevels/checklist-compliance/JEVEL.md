---
name: checklist-compliance
version: 1
model: jev-1.13.0
state:
  required: [checklist, report]
  budget_tokens: 12000
questions:
  followed:
    type: noul
    instructions: "Does `report` show that every step in `checklist` was carried out?"
    criteria:
      true: "Each step in the checklist has something in the report that covers it."
      false: "At least one step in the checklist is left open by the report."
    verdict: { act: 0.85, mark: 0.7 }
  deviation_kind:
    type: choice
    instructions: "Where `report` departs from `checklist`, what kind of departure is it?"
    criteria:
      justified_improvement: "A step was done another way that reaches the same end, and the report says why."
      shortcut: "A step was done in a lighter form that reaches less than the step asks for."
      omission: "A step was skipped and the report is silent about it."
      none: "The report follows the checklist step for step."
      unclear: "The report says too little to tell which of the four above fits."
    verdict: { act: 0.8, mark: 0.6 }
  deviation_explained:
    type: noul
    instructions: "Does `report` give a reason for each place where it departs from `checklist`?"
    criteria:
      true: "Every departure carries a reason in the report."
      false: "At least one departure stands in the report with the reason left open."
    verdict: { act: 0.8, mark: 0.6 }
---
# checklist-compliance

## When to use

When somebody reports work that claims to follow a checklist, to see which steps the report covers and where it departs.

## State

`checklist`: `{ "name": "...", "steps": ["..."] }`, the steps in the order they are meant to run. `report`: `{ "by": "...", "text": "..." }`, what the person wrote about the work. Send the checklist version the person was given, so the answers are about the same steps.

## Verdicts

`followed` yes with `act`: accept the report and close the run. `mark`: accept it and keep it in the reviewer's list. `fall_back`: read the report by hand.
`deviation_kind` = `omission` or `shortcut` with `act`: send the report back and name the step. `justified_improvement` with `act`: accept it and put the reason in the checklist's own notes for the next revision.
`deviation_explained` no with `act`: ask the author for the reason before you accept the run.

## Example

The example state holds a release checklist of five steps and a report that covers four of them and passes over posting the release notes. It answers `followed` no, `deviation_kind` = `omission` and `deviation_explained` no.

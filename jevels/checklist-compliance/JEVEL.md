---
name: checklist-compliance
version: 2
model: jev-1.13.0
state:
  required: [checklist, report]
  budget_tokens: 12000
questions:
  followed:
    type: noul
    instructions:
      question: "Does `report` show that every step in `checklist.steps` was carried out?"
      inspect: "`checklist.steps` and `report.text`"
      focus: "Take the steps one at a time and look for the part of the report that covers each one."
    criteria:
      true:
        what: "Every step in the checklist has something in the report that carries it out"
        examples:
          - "the report walks the steps in order and says what happened at each one"
          - "each step has a line in the report that answers it"
      false:
        what: "A step in the checklist is left open by the report: the report passes over it, says it was skipped, or carries it out in a lighter form than the step asks for"
        examples:
          - "the report stops after the production deploy and the release notes step has no line"
          - "the report says staging was skipped"
          - "the step asks for the full suite and the report ran one test file"
    verdict: { act: 0.85, mark: 0.7 }
  deviation_kind:
    type: choice
    instructions:
      question: "Where `report` departs from `checklist.steps`, what kind of departure is it?"
      inspect: "`checklist.steps` and `report.text`"
      focus: "Hold each step against the part of the report that covers it. The kind is about the widest departure in the report."
    criteria:
      justified_improvement:
        what: "The report carries out a step another way that reaches what the step asks for, and it says why the other way was taken"
        not_for: "A lighter form that reaches less than the step asks for, which belongs to shortcut"
        examples:
          - "ran the smoke checks through the new harness because the old one was retired, same checks"
          - "tagged the release from the CI job because the laptop had no credentials"
      shortcut:
        what: "The report carries out a step in a lighter form that reaches less than the step asks for"
        not_for: "Another way that reaches what the step asks for, which belongs to justified_improvement, or a step the report says was skipped, which belongs to omission"
        examples:
          - "the step asks for the full suite and the report ran the payments tests only"
          - "checked two of the smoke tests by hand and moved on"
      omission:
        what: "The report says or shows that a step was skipped"
        not_for: "A step the report simply passes over, which belongs to unclear"
        examples:
          - "skipped staging and went straight to production"
          - "no time for the changelog, we will add it later"
      none:
        what: "The report covers every step and departs from none of them"
        not_for: "A report that passes over a step, which belongs to unclear"
        examples:
          - "the report answers every step in order"
          - "each step has its line and each was carried out as written"
      unclear:
        what: "The report passes over a step, so what happened at that step is left open"
        not_for: "A report that covers every step, which belongs to none, or one that says a step was skipped, which belongs to omission"
        examples:
          - "the report ends after the production deploy and says nothing about the release notes"
          - "no line in the report touches the changelog step"
    verdict: { act: 0.8, mark: 0.6 }
  deviation_explained:
    type: noul
    instructions:
      question: "Does `report` give a reason for each place where it departs from `checklist.steps`?"
      inspect: "`checklist.steps` and `report.text`"
      focus: "A reason says why the step was carried out the other way, or why it was skipped. A report that departs nowhere answers this yes."
    criteria:
      true:
        what: "Every place where the report departs from a step carries a reason, or the report departs from nothing and follows every step as written"
        examples:
          - "ran the checks by hand because the CI runner was down"
          - "the report follows every step and departs from none of them"
      false:
        what: "A departure stands in the report with the reason left open"
        examples:
          - "went straight to production, and the report says nothing about why"
          - "ran the payments tests only, with no word on the rest of the suite"
    verdict: { act: 0.8, mark: 0.6 }
---
# checklist-compliance

## When to use

When somebody reports work that claims to follow a checklist, to see which steps the report covers and where it departs.

## State

`checklist`: `{ "name": "...", "steps": ["..."] }`, the steps in the order they are meant to run. `report`: `{ "by": "...", "text": "..." }`, what the person wrote about the work. Send the checklist version the person was given, so the answers are about the same steps.

## Verdicts

`followed` yes with `act`: accept the report and close the run. `mark`: accept it and keep it in the reviewer's list. `fall_back`: read the report by hand.
`deviation_kind` = `omission` or `shortcut` with `act`: send the report back and name the step. `justified_improvement` with `act`: accept it and put the reason in the checklist's own notes for the next revision. `unclear` with `act`: ask the author what happened at the step the report passes over.
`deviation_explained` no with `act`: ask the author for the reason before you accept the run.

## Example

The example state holds a release checklist of five steps and a report that covers four of them and passes over posting the release notes. It answers `followed` no, `deviation_kind` = `unclear` and `deviation_explained` no.

---
name: meeting-notes
version: 1
model: jev-1.13.0
state:
  required: [notes]
  budget_tokens: 10000
questions:
  decision_reached:
    type: noul
    instructions: "Do `notes` record a decision the meeting settled?"
    criteria:
      true: "The notes name a choice that was made and what it applies to."
      false: "The notes record discussion and leave the choice open."
    verdict: { act: 0.85, mark: 0.7 }
  owners_assigned:
    type: noul
    instructions: "Do `notes` name a person for each action that came out of the meeting?"
    criteria:
      true: "Every action in the notes carries a name."
      false: "At least one action sits there with the owner open."
    verdict: { act: 0.85, mark: 0.7 }
  follow_up_needed:
    type: noul
    instructions: "Do `notes` leave something that needs another meeting or another round of work?"
    criteria:
      true: "The notes name an open question, a blocked action or a topic held over."
      false: "The meeting finished what it set out to do."
    verdict: { act: 0.8, mark: 0.6 }
  tone:
    type: score
    instructions: "How did the people in `notes` get along?"
    criteria:
      - "aligned: agreement, one direction, short discussion"
      - "mixed: several positions, worked through to a common line"
      - "conflict: positions held against each other, and the disagreement stayed"
    verdict: { act: 0.7, mark: 0.5 }
---
# meeting-notes

## When to use

On the notes after a meeting, to record what was decided, who owns what, and whether the meeting needs a sequel.

## State

`notes`: `{ "title": "...", "attendees": ["..."], "body": "..." }`. `body` is the notes as somebody wrote them, in whatever order they were taken.

## Verdicts

`decision_reached` yes with `act`: write the decision into the decision log. `owners_assigned` no with `act`: ask the chair who owns the actions before the notes go out. `follow_up_needed` yes with `act`: put the next meeting on the calendar. `tone` at level 2 with `act`: tell the chair, because a disagreement that stayed open comes back.
Each of the four with `mark`: do the same and show the chair the answer. `fall_back`: file the notes as they are.

## Example

The example state holds notes from a pricing page sync where two tiers plus an add-on was agreed, three actions carry names, and the refund handling went to the finance review. It answers `decision_reached` yes, `owners_assigned` yes, `follow_up_needed` yes and `tone` at level 1.

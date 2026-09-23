---
name: meeting-notes
version: 3
model: jev-1.13.0
state:
  required: [notes]
  budget_tokens: 10000
questions:
  decision_reached:
    type: noul
    instructions:
      question: "Do `notes` record a decision the meeting settled?"
      inspect: "`notes.body`"
      focus: "A settled decision names the choice that was made and what it applies to. A direction the meeting leaned towards leaves the choice open."
    criteria:
      true:
        what: "The notes name a choice that was made and what it applies to"
        examples:
          - "we agreed on two tiers plus an add-on, so that is settled"
          - "decision: the migration runs on the 14th"
      false:
        what: "The notes record discussion, a leaning or a plan to decide later, and the choice stays open"
        examples:
          - "we are leaning towards the second option and will confirm next week"
          - "both plans are still on the table"
    thresholds: { act: 0.85, mark: 0.7 }
  owners_assigned:
    type: noul
    instructions:
      question: "Do `notes` name a person for every action that came out of the meeting?"
      inspect: "`notes.body` for the actions, and `notes.attendees` for the names"
      focus: "Take each sentence in the notes that hands out work and look for the name of the person who does it. The answer is yes when each of those sentences carries a name, and notes that hand out no work at all answer yes too."
    criteria:
      true:
        what: "Every sentence in the notes that hands out work carries the name of the person who does it"
        examples:
          - "Ana updates the calendar invite, Ben writes the new time into the handbook"
          - "Gus writes the objection down for the steering group on Friday"
          - "the notes record a discussion and hand out no work at all"
      false:
        what: "A sentence in the notes hands out work with the owner left open"
        examples:
          - "somebody needs to tell the customers"
          - "the pricing table still has to be updated, we will see who takes it"
    thresholds: { act: 0.85, mark: 0.7 }
  follow_up_needed:
    type: noul
    instructions:
      question: "Do `notes` leave something that needs another meeting or another round of work?"
      inspect: "`notes.body`"
      focus: "Look for an open question, a blocked action, or a topic the meeting handed on to another meeting."
    criteria:
      true:
        what: "The notes name an open question, an action that is blocked, or a topic held over to another meeting"
        examples:
          - "the refund handling goes to the finance review next week"
          - "we cannot start until legal answers"
          - "parked the naming question for now"
      false:
        what: "The meeting finished what it set out to do and the notes leave every topic closed"
        examples:
          - "all four points are settled and the actions are out"
          - "nothing else came up"
    thresholds: { act: 0.8, mark: 0.6 }
  tone:
    type: score
    instructions:
      question: "Which of these situations do `notes` read like?"
      inspect: "`notes.body`"
      focus: "Judge how the people in the room met each other, by what the notes record of the discussion. Whether the meeting reached a decision stays out of this."
    criteria:
      - what: "The notes record agreement and the next steps that follow from it"
        signals:
          - "everybody was happy with the plan"
          - "agreed in five minutes and moved on"
          - "one direction, and the actions handed out"
      - what: "The notes record open questions and differing views that were left standing"
        signals:
          - "Ben wanted three tiers and Chris wanted two"
          - "we went round this twice and left it open"
          - "two readings of the number, both written down"
      - what: "The notes record people rejecting each other's positions, or the meeting ending on a disagreement"
        signals:
          - "Dan called the plan unworkable"
          - "Priya refused to sign off on the date"
          - "the meeting ended with the two of them apart on this"
    thresholds: { act: 0.7, mark: 0.5 }
---
# meeting-notes

## When to use

On the notes after a meeting, to record what was decided, who owns what, and whether the meeting needs a sequel.

## State

`notes`: `{ "title": "...", "attendees": ["..."], "body": "..." }`. `body` is the notes as somebody wrote them, in whatever order they were taken.

## Decisions

`decision_reached` yes with `act`: write the decision into the decision log. `owners_assigned` no with `act`: ask the chair who owns the actions before the notes go out. `follow_up_needed` yes with `act`: put the next meeting on the calendar. `tone` at level 2 with `act`: tell the chair, because a disagreement that stayed open comes back.
Each of the four with `mark`: do the same and show the chair the answer. `fall_back`: file the notes as they are.

## Example

The example state holds notes from a pricing page sync where two tiers plus an add-on was agreed, three actions carry names, and the refund handling went to the finance review. It answers `decision_reached` yes, `owners_assigned` yes, `follow_up_needed` yes and `tone` at level 0, at `mark`, because the two positions met on a common line while the refund handling stayed open.

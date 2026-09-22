---
name: notification-triage
version: 1
model: jev-1.13.0
state:
  required: [person, notifications]
  budget_tokens: 10000
questions:
  worth_interrupting:
    type: noul
    instructions: "Does anything in `notifications` need `person` to stop what they are doing right now?"
    criteria:
      true: "At least one notification names something broken, a deadline today, or a question that blocks somebody else's work."
      false: "Every notification can wait until the next break."
    verdict: { act: 0.9, mark: 0.7 }
  handle:
    type: choice
    instructions: "How should `person` handle `notifications` as a batch?"
    criteria:
      act_now: "Something in the batch needs an answer or a fix within the hour."
      batch_for_later: "The batch is worth reading at the next break and every item in it can wait that long."
      ignore: "Automated noise, duplicates, or messages that were already handled elsewhere."
      unclear: "The batch holds one notification that needs an answer within the hour and another that can wait, or the notifications say too little to place them."
    verdict: { act: 0.8, mark: 0.6 }
  depth:
    type: score
    instructions: "How much attention does `notifications` need from `person`?"
    criteria:
      - "glance: the subject lines carry the whole message"
      - "read: the bodies matter and a reply may follow"
      - "decide: somebody is waiting for `person` to choose between options"
    verdict: { act: 0.7, mark: 0.5 }
---
# notification-triage

## When to use

On a batch of notifications collected for one person, before you push any of them to a phone, to decide whether the person hears about them now or at the next break.

## State

`person`: `{ "name": "...", "role": "...", "focus": "what they are working on right now" }`. `notifications`: an array of `{ "source": "...", "subject": "...", "body": "..." }` holding the ones that arrived since your last push. Group them in your code and send one batch per person.

## Verdicts

`worth_interrupting` yes with `act`: push the batch to the phone. `mark`: push it and name the notification that caused it. `fall_back`: hold the batch for the next break.
`handle` with `act`: put the batch in that lane. `mark`: put it in that lane and show the person which lane it went to. `fall_back`: leave the batch in the inbox.
`depth` at level 2 with `act`: put the batch in front of the person as a decision with the options spelled out.

## Example

The example state holds a pager alert about checkout latency, a review comment and a newsletter, for an on-call engineer writing a postmortem. It answers `worth_interrupting` yes, `handle` = `act_now`, and `depth` at level 1 or above.

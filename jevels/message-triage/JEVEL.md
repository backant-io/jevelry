---
name: message-triage
version: 1
model: jev-1.13.0
state:
  required: [message]
  budget_tokens: 8000
questions:
  kind:
    type: choice
    instructions: "What does `message` want from you?"
    criteria:
      needs_reply: "It asks a question or requests something you can answer or send back."
      fyi: "It shares information and leaves the reading to you."
      request_for_decision: "It puts options in front of you and waits for you to pick one."
      escalation: "It reports your product or your service going wrong and asks for help or for attention today."
      other: "It fits none of the four above, such as an automated notice or a message with no request in it."
    verdict: { act: 0.8, mark: 0.6 }
  urgency:
    type: score
    instructions: "When does `message` need an answer?"
    criteria:
      - "can_wait: whenever you get to it"
      - "this_week: somebody is waiting and has a few days"
      - "today: work, money or a customer is blocked until you answer"
    verdict: { act: 0.75, mark: 0.55 }
  from_a_customer:
    type: noul
    instructions: "Is the sender of `message` a customer or somebody writing on a customer's behalf?"
    criteria:
      true: "The sender buys or uses the product, or writes for somebody who does."
      false: "The sender is a colleague, a vendor, a service account, or somebody with an account nowhere in your product."
    verdict: { act: 0.85, mark: 0.7 }
---
# message-triage

## When to use

On every inbound message, in mail or chat, to sort what wants an answer from what wants to be read.

## State

`message`: `{ "channel": "email", "from": "...", "subject": "...", "body": "..." }`. Send the message as it arrived, sender address included, because `from_a_customer` reads it there.

## Verdicts

`kind` with `act`: file the message in that lane. `mark`: file it and show the lane to the person who owns the inbox. `fall_back`: leave it in the unsorted list.
`urgency` at level 2 with `act`: put the message at the top of the day's list. `from_a_customer` yes with `act`: apply your customer response time to it.

## Example

The example state holds mail from a customer's operations address asking for a corrected invoice before Friday's payment run. It answers `kind` = `needs_reply`, `urgency` at level 2 and `from_a_customer` yes.

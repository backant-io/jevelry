---
name: ticket-triage
version: 1
model: jev-1.13.0
state:
  required: [ticket]
  budget_tokens: 8000
questions:
  team:
    type: choice
    instructions: "Which team should handle `ticket`?"
    criteria:
      billing: "Payments, invoices, refunds, subscription changes."
      technical: "Bugs, outages, error messages, integrations, data that looks wrong."
      account: "Login, password, permissions, closing or changing an account."
      other: "Anything the three teams above do not cover, or a message with no request in it."
    verdict: { act: 0.8, mark: 0.6 }
  urgent:
    type: noul
    instructions: "Does `ticket.message` say or imply that the customer needs an answer today?"
    criteria:
      true: "The customer names a deadline, says work or money is blocked, or asks for an immediate fix."
      false: "The customer asks a question or reports something that can wait."
    verdict: { act: 0.85, mark: 0.7 }
  frustration:
    type: score
    instructions: "How frustrated is the customer in `ticket.message`?"
    criteria:
      - "calm: neutral or friendly wording"
      - "frustrated: annoyed, repeats the problem, mentions earlier attempts"
      - "very angry: threatens to leave, insults, or writes in capitals"
    verdict: { act: 0.7, mark: 0.5 }
---
# ticket-triage

## When to use

On every new support ticket, before a person reads it, to put it in the right queue and at the right position.

## State

`ticket`: `{ "subject": "...", "message": "...", "customer_since": "2024-03" }`. Send the ticket only; the questions read the subject and the message.

## Verdicts

`team` with `act`: route the ticket. `mark`: route it and flag it for the queue owner. `fall_back`: leave it in the general queue.
`urgent` yes with `act`: move it to the top of its queue. `frustration` at level 2 with `act`: a person answers before any automatic reply goes out.

## Example

`{ "ticket": { "subject": "Charged twice", "message": "I was charged twice for order A-104 and I need this fixed today, my accountant is waiting.", "customer_since": "2024-03" } }` answers `team` = `billing`, `urgent` yes, `frustration` around level 1.

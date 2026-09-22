---
name: ticket-triage
version: 2
model: jev-1.13.0
state:
  required: [ticket]
  budget_tokens: 8000
questions:
  team:
    type: choice
    instructions:
      question: "Which team should handle `ticket`?"
      focus: "Classify the one thing the customer asks for. A message that touches several topics belongs to the team that owns the request."
      inspect: "`ticket.subject` and `ticket.message`"
    criteria:
      billing:
        what: "A charge, an invoice, a refund, a price or a subscription change"
        not_for: "A feature that fails, which belongs to technical, or a password, which belongs to account"
        examples:
          - "I was charged twice for invoice 8841"
          - "Cancel my subscription and refund this month"
          - "The invoice shows the wrong VAT number"
      technical:
        what: "A feature that fails, an error message, an integration that stopped working, or data on a page that looks wrong"
        not_for: "A charge the customer disputes, which belongs to billing, or a password, which belongs to account"
        examples:
          - "The export button returns a 500"
          - "Your webhook stopped firing yesterday"
          - "The dashboard shows last week's numbers"
      account:
        what: "Logging in, a password, a seat, a permission, or opening, renaming or closing an account"
        not_for: "A charge on the account, which belongs to billing, or a page that fails after login, which belongs to technical"
        examples:
          - "I cannot log in and the reset mail keeps missing"
          - "Please remove Anna's admin rights"
          - "Close my account at the end of the month"
      other:
        what: "A message that asks for none of the three above, or that asks for nothing at all"
        not_for: "A message that names a charge, a broken feature or a login, each of which belongs to one of the three above"
        examples:
          - "Thanks, that worked"
          - "Do you sponsor conferences?"
    verdict: { act: 0.8, mark: 0.6 }
  urgent:
    type: noul
    instructions:
      question: "Does `ticket.message` say or imply that the customer needs an answer today?"
      inspect: "`ticket.subject` and `ticket.message`"
      focus: "Look for a deadline the customer names, work or money they say is blocked, or a request for an immediate fix."
    criteria:
      true:
        what: "The customer names today or an hour today, says that work or money is blocked while this is open, or asks for an immediate fix"
        examples:
          - "I need the refund today, my accountant closes the books this afternoon"
          - "We cannot invoice anyone until this is back"
          - "Our shop has been down since this morning"
      false:
        what: "The customer asks a question or reports something that can wait for the normal queue"
        examples:
          - "Have a look whenever you get to it"
          - "Just so you know, the label is misspelled"
          - "How do I add a second seat?"
    verdict: { act: 0.85, mark: 0.7 }
  frustration:
    type: score
    instructions:
      question: "Which of these situations does `ticket.message` read like?"
      focus: "Judge the wording the customer uses about the team and about the wait. The size of the problem itself stays out of this."
    criteria:
      - what: "The customer states the problem in plain or friendly wording, asks politely, and writes in for the first time"
        signals:
          - "hi, quick question"
          - "thanks in advance"
          - "could you have a look"
      - what: "The customer says they have written before, repeats a problem that is still open, or says plainly that they are annoyed"
        signals:
          - "this is the third time I am writing"
          - "still waiting for an answer"
          - "I have tried everything you suggested"
      - what: "The customer threatens to leave or to escalate, insults the team, or writes in capitals"
        signals:
          - "cancel my account today"
          - "your support is a joke"
          - "ABSOLUTELY UNACCEPTABLE"
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

`{ "ticket": { "subject": "Charged twice", "message": "I was charged twice for order A-104 and I need this fixed today, my accountant is waiting.", "customer_since": "2024-03" } }` answers `team` = `billing`, `urgent` yes, `frustration` at level 0: the wording stays polite even with a deadline in it.

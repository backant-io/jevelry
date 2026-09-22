---
name: message-triage
version: 2
model: jev-1.13.0
state:
  required: [message]
  budget_tokens: 8000
questions:
  kind:
    type: choice
    instructions:
      question: "What does `message.body` ask of the person who receives it?"
      inspect: "`message.subject` and `message.body`"
      focus: "Classify the primary request in the message, not every topic it mentions."
    criteria:
      needs_reply:
        what: "Asks the recipient for an answer, an action or a piece of work"
        not_for: "A status report or a verdict that closes a thread, which belongs to fyi"
        examples:
          - "Can you review this by tomorrow?"
          - "The migration is yours: run it after the freeze"
          - "Could you send a corrected invoice?"
      fyi:
        what: "Informs the recipient; nothing is asked of them"
        not_for: "A message that ends with a question or an assignment, which belongs to needs_reply"
        examples:
          - "Review complete, task approved."
          - "For your information: the deploy finished."
          - "Closing this thread, the numbers match now."
      request_for_decision:
        what: "Asks the recipient to choose between options or to approve something"
        not_for: "An assignment with the decision already made, which belongs to needs_reply"
        examples:
          - "Should we keep the economy era next or drop it?"
          - "Approve the budget for Q4?"
      escalation:
        what: "Raises a problem the sender cannot resolve and asks the recipient to step in"
        not_for: "A routine report of metrics with no ask, which belongs to fyi"
        examples:
          - "This is blocked for two days and I need a decision from you"
          - "Production is down and I cannot reach the owner"
      other:
        what: "A message none of the four above describes"
        not_for: "A message that asks for anything or reports anything, each of which belongs to one of the four above"
        examples:
          - "Welcome aboard!"
          - "Thanks, all good."
    verdict: { act: 0.8, mark: 0.6 }
  urgency:
    type: score
    instructions:
      question: "By when does `message.body` need the recipient to act?"
      focus: "Judge the deadline the sender states or implies, not how important the topic is."
    criteria:
      - what: "No deadline; the recipient acts whenever they get to it"
        signals:
          - "for your information"
          - "no rush"
          - "a report with nothing asked"
      - what: "Within the week; a deadline is implied by a plan, a schedule or a day later this week"
        signals:
          - "this sprint"
          - "before Friday"
          - "an assignment with no date"
      - what: "Today; the sender names today, now or immediately, or says work is blocked until it is done"
        signals:
          - "today"
          - "now"
          - "blocked until"
    verdict: { act: 0.75, mark: 0.55 }
  from_a_customer:
    type: noul
    instructions:
      question: "Is `message.from` a customer of the recipient's organisation?"
      inspect: "`message.from` and how `message.body` describes the sender"
      focus: "A colleague, a manager or the owner of the organisation is not a customer."
    criteria:
      true:
        what: "The sender buys or uses the organisation's product and writes from outside it"
        examples:
          - "a customer asking about an invoice"
          - "we have been on your Business plan since 2024"
      false:
        what: "The sender works in the organisation: a colleague, a manager, the owner, or an internal system"
        examples:
          - "the CTO reporting metrics"
          - "the owner giving an instruction"
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

The example state holds mail from a customer's operations address asking for a corrected invoice today, before Friday's payment run. It answers `kind` = `needs_reply`, `urgency` at level 2 and `from_a_customer` yes.

---
name: reply-check
version: 2
model: jev-1.13.0
state:
  required: [question, reply]
  budget_tokens: 8000
questions:
  addresses_it:
    type: noul
    instructions:
      question: "Does `reply.text` answer what `question.text` asked?"
      compare: "each point `question.text` raises against what `reply.text` says about it"
      focus: "Go through the points in the question one by one. A promise to answer later answers nothing yet."
    criteria:
      true:
        what: "The reply answers every point the question raises"
        examples:
          - "the question asks whether the invoice went out and when, and the reply gives the date"
          - "the question asks which port, and the reply names the port"
      false:
        what: "The reply answers part of the question, changes the subject, or promises an answer later"
        examples:
          - "the reply gives the date and says the amount comes tomorrow"
          - "I will look into it"
          - "ok"
    verdict: { act: 0.85, mark: 0.7 }
  next:
    type: choice
    instructions:
      question: "What should happen to the thread after `reply.text`?"
      compare: "`reply.text` against what `question.text` asked or reported"
      focus: "Decide from what the reply leaves open and whether it says the problem or the premise of the question still holds."
    criteria:
      close:
        what: "The reply settles the question and the person who asked has what they need"
        not_for: "A reply that promises more later or leaves a named piece open, which belongs to follow_up"
        examples:
          - "It went out on 3 September as invoice 2026-0912."
          - "Fixed in 4.2.1, and the customer confirmed it works."
      follow_up:
        what: "The reply answers part and leaves a named piece open that somebody has to come back with"
        not_for: "A reply that contradicts the question's premise or reports the problem is back, which belongs to reopen"
        examples:
          - "The date is 3 September; finance sends the amount tomorrow."
          - "I checked staging, production I can look at on Monday."
      reopen:
        what: "The reply contradicts the question's premise, says an earlier answer was wrong, or reports the problem is back"
        not_for: "A reply that answers part and names a piece still open, which belongs to follow_up"
        examples:
          - "The fix went out, but the export fails again this morning with the same 500."
          - "That invoice never went out, the job failed on Friday."
      unclear:
        what: "The reply says too little to tell which of the three above fits"
        not_for: "A reply that gives an answer, names a piece still open, or reports a problem, each of which belongs to one of the three above"
        examples:
          - "ok"
          - "Seen."
    verdict: { act: 0.8, mark: 0.6 }
---
# reply-check

## When to use

After somebody replies to a question, a bug report or a request, to decide whether the thread can close or somebody has to come back to it.

## State

`question`: `{ "from": "...", "text": "..." }`, the message that opened the thread. `reply`: the same shape, the message that answers it. Send the two messages and the parts of the thread they point at.

## Verdicts

`addresses_it` yes with `act`: mark the thread answered. `mark`: mark it answered and keep it in the owner's list for a day. `fall_back`: leave the thread open.
`next` with `act`: close it, schedule the follow-up, or reopen it, as the option says. `mark`: do that and tell the person who asked what you did. `fall_back`: leave the thread for a person to read.

## Example

The example state holds a question about whether an invoice went out and on which date, and a reply that gives the date, the invoice number and a confirmation. It answers `addresses_it` yes and `next` = `close`.

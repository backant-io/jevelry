---
name: reply-check
version: 1
model: jev-1.13.0
state:
  required: [question, reply]
  budget_tokens: 8000
questions:
  addresses_it:
    type: noul
    instructions: "Does `reply` answer what `question` asked?"
    criteria:
      true: "Every point `question` raises is answered in `reply`."
      false: "`reply` answers part of it, changes the subject, or promises an answer later."
    verdict: { act: 0.85, mark: 0.7 }
  next:
    type: choice
    instructions: "What should happen to the thread after `reply`?"
    criteria:
      close: "`reply` settles `question` and the person who asked has what they need."
      follow_up: "`reply` moves it forward and leaves something open that somebody has to come back with."
      reopen: "`reply` shows that the problem is still there or that an earlier answer was wrong."
      unclear: "`reply` says too little to tell which of the three above fits."
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

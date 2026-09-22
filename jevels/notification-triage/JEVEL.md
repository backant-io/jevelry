---
name: notification-triage
version: 2
model: jev-1.13.0
state:
  required: [person, notifications]
  budget_tokens: 10000
questions:
  worth_interrupting:
    type: noul
    instructions:
      question: "Does a notification in `notifications` need `person` to stop what they are doing now?"
      inspect: "`from`, `about` and `text` of every entry in `notifications`, and `person.role`"
      focus: "One notification that needs the person now is enough. Read what each notification says is broken, due or waiting, and hold it against the person's role."
    criteria:
      true:
        what: "A notification names something broken now, a deadline today, or somebody whose work waits on this person"
        examples:
          - "checkout-api p95 latency above 2s for 10 minutes and still above it"
          - "can you approve the hotfix, the deploy is waiting on you"
          - "pick one of the two vendors by 15:00 today"
      false:
        what: "Every notification keeps until the person's next sitting"
        examples:
          - "weekly digest with five links"
          - "CI passed on main"
          - "a review request for later this week"
    verdict: { act: 0.9, mark: 0.7 }
  handle:
    type: choice
    instructions:
      question: "How should `person` handle `notifications` as a batch?"
      inspect: "`from`, `about` and `text` of every entry in `notifications`"
      focus: "The notification that asks the most of the person decides the lane for the whole batch."
    criteria:
      act_now:
        what: "Something waits on the person now: a notification names something broken, a deadline within the hour, or somebody blocked until the person answers"
        not_for: "A batch where every notification keeps until the person's next sitting, which belongs to batch_for_later"
        examples:
          - "production alert still firing"
          - "the deploy is waiting on your approval"
          - "decide by 15:00 today"
      batch_for_later:
        what: "A notification is worth reading or answering, and every notification keeps until the person's next sitting"
        not_for: "A batch where something is broken now or somebody is blocked now, which belongs to act_now"
        examples:
          - "please review my pull request this week"
          - "a question on the design doc, no rush"
      ignore:
        what: "Every notification is automated noise, a duplicate, or something already handled"
        not_for: "A batch with one notification the person should read or answer, which belongs to batch_for_later"
        examples:
          - "CI passed on main"
          - "your calendar invite was accepted"
          - "weekly digest"
      unclear:
        what: "The notifications point in different directions and their text leaves open whether any of them needs the person now"
        not_for: "A batch where one notification clearly needs the person now, which belongs to act_now whatever else rides along"
        examples:
          - "a disk at 71% next to a colleague asking if you have a second"
          - "an alert that fired and a second one saying it may have resolved"
    verdict: { act: 0.8, mark: 0.6 }
  depth:
    type: score
    instructions:
      question: "Which of these situations do `notifications` put `person` in?"
      inspect: "`about` and `text` of every entry in `notifications`"
      focus: "Judge what the most demanding notification asks the person to do. How urgent it is stays out of this."
    criteria:
      - what: "The `about` lines carry the whole message and nothing asks the person to do anything"
        signals:
          - "CI passed"
          - "invite accepted"
          - "weekly digest"
      - what: "A notification needs the person to read its text and then answer, review or look into a problem"
        signals:
          - "please review"
          - "can you check why"
          - "an alert to look into"
      - what: "Somebody is waiting for the person to choose between options the text names"
        signals:
          - "vendor A or vendor B"
          - "ship today or hold until Monday"
          - "which of the two do we go with"
    verdict: { act: 0.7, mark: 0.5 }
---
# notification-triage

## When to use

On a batch of notifications collected for one person, before you push any of them to a phone, to decide whether the person hears about them now or at the next break.

## State

`person`: `{ "name": "...", "role": "...", "focus": "what they are working on right now" }`. `notifications`: an array of `{ "from": "...", "about": "...", "text": "..." }` holding the ones that arrived since your last push. Render each one for a reader in your code: `from` is who or what sent it in plain words, `about` is its subject line, and `text` is the message in a sentence or two. Raw event records with ids and timestamps cost accuracy on every question. Group them in your code and send one batch per person.

## Verdicts

`worth_interrupting` yes with `act`: push the batch to the phone. `mark`: push it and name the notification that caused it. `fall_back`: hold the batch for the next break.
`handle` with `act`: put the batch in that lane. `mark`: put it in that lane and show the person which lane it went to. `fall_back`: leave the batch in the inbox.
`depth` at level 2 with `act`: put the batch in front of the person as a decision with the options spelled out.

## Example

The example state holds a pager alert about checkout latency, a review comment and a newsletter, for an on-call engineer writing a postmortem. It answers `worth_interrupting` yes, `handle` = `act_now`, and `depth` at level 1.

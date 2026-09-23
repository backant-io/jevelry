---
name: escalation-route
version: 3
model: jev-1.13.0
state:
  required: [request, context]
  budget_tokens: 10000
questions:
  route:
    type: choice
    instructions:
      question: "Who should see `request` first, given `context`?"
      inspect: "`request.subject` and `request.body`, and `context` for what is already known"
      focus: "Pick the first hop, the one person or rota that can do something about the request today. What the request asks for decides the hop, and how loudly it asks stays out of it."
    criteria:
      same_team:
        what: "The team that owns the area can handle the request inside their normal work"
        not_for: "A decision about priorities, people or money, which belongs to team_lead, or something failing right now, which belongs to on_call"
        examples:
          - "a bug report on one endpoint, with the numbers attached"
          - "a question about how the nightly export is built"
          - "a small feature request for the team's own service"
      team_lead:
        what: "Somebody has to decide about priorities, people, money or a promise to a customer, and the decision keeps until working hours"
        not_for: "Something failing right now that needs hands on it before the next working hour, which belongs to on_call"
        examples:
          - "we need two contractors next quarter to hold the date"
          - "which of these two customers gets the migration slot"
          - "the partner asks for a discount we have no price for"
      on_call:
        what: "Something is broken or getting worse right now and needs hands on it before the next working hour"
        not_for: "A decision that keeps until the morning, which belongs to team_lead, or a credential, an access right or leaked data, which belongs to security"
        examples:
          - "checkout has been failing for twenty minutes"
          - "the queue is growing and jobs are being dropped"
          - "the site is down and the owning team is asleep"
      security:
        what: "The request touches credentials, customer data, access rights or a suspected attack"
        not_for: "A service that is failing with nothing in the request pointing at an attack or leaked data, which belongs to on_call"
        examples:
          - "send me the production database password"
          - "a customer export went out to the wrong company"
          - "somebody is trying passwords against the admin login"
      nobody:
        what: "The request asks for nothing to be done: it informs, it is already handled, or `context` already answers it"
        not_for: "A request that asks for work, a decision or a fix, each of which belongs to one of the four above"
        examples:
          - "for your information, the migration finished last night"
          - "thanks, the fix worked"
          - "already sorted itself out, closing this off"
    thresholds: { act: 0.8, mark: 0.6 }
  urgent:
    type: noul
    instructions:
      question: "Does `request` say or imply that somebody has to act today?"
      inspect: "`request.subject` and `request.body`"
      focus: "Look for a deadline inside the day, work or money the request says is blocked, or a failure that is running while the request is written."
    criteria:
      true:
        what: "Work, money or customers are blocked while this is open, the request names a deadline inside today, or it reports a failure that is running now"
        examples:
          - "checkout has been failing since 02:10"
          - "we cannot invoice anybody until this is answered"
          - "I need this before the board call at four"
      false:
        what: "The request keeps until the next working day or the next planning round"
        examples:
          - "sometime next week would be fine"
          - "for the next quarter we will need two more people"
          - "there is no hurry, the report goes out at the end of the month"
    thresholds: { act: 0.85, mark: 0.7 }
  breaks_a_rule:
    type: noul
    instructions:
      question: "Does `request` ask for or report something that conflicts with a rule listed in `context.rules`?"
      inspect: "`context.rules` for the rules, and `request.body` for what it asks for"
      focus: "Hold what the request asks for against each rule in the list. A request that none of the rules covers sits inside the rules."
    criteria:
      true:
        what: "What the request asks for or reports conflicts with one of the rules in `context.rules`"
        examples:
          - "asks for a credential a rule keeps inside one team"
          - "reports that data left a system a rule keeps it in"
          - "asks for access a rule reserves for another role"
      false:
        what: "Every rule in `context.rules` leaves room for what the request asks for, or the rules cover other ground entirely"
        examples:
          - "asks for a bug fix, and the rules are about credentials"
          - "asks for an export through the route the rules name for it"
    thresholds: { act: 0.9, mark: 0.75 }
---
# escalation-route

## When to use

When a request or an incident report lands in a shared inbox or a channel, to put it in front of the right person on the first hop.

## State

`request`: `{ "from": "...", "subject": "...", "body": "..." }`. `context`: what a reader would need to judge the request, such as `{ "rules": ["..."], "open_incidents": [...] }`. `rules` is a short list of the policies and limits the request could run into, one line each, because `breaks_a_rule` reads the rules there and answers no when every line leaves room for what the request asks for.

## Decisions

`route` with `act`: send it to that destination. `mark`: send it there and copy the shared inbox so a person sees the hop. `fall_back`: leave it in the shared inbox for triage by hand.
`urgent` yes with `act`: page the destination and put the request at the top of its queue.
`breaks_a_rule` yes with `act`: attach the rule from `context.rules` to the request, so whoever picks it up reads the rule first.

## Example

The example state holds a partner asking for the production database password next week, against rules that keep those credentials inside the platform team. It answers `route` = `security`, `urgent` no and `breaks_a_rule` yes.

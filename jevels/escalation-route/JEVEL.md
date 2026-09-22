---
name: escalation-route
version: 1
model: jev-1.13.0
state:
  required: [request, context]
  budget_tokens: 10000
questions:
  route:
    type: choice
    instructions: "Who should see `request` first, given `context`?"
    criteria:
      same_team: "The team that owns the area can handle it in their normal work."
      team_lead: "It needs a decision about priorities, people or money that the team cannot make alone."
      on_call: "Something is broken or getting worse right now and needs hands on it."
      security: "It touches credentials, customer data, access rights or a suspected attack."
      nobody: "It is informational, already handled, or answered by what `context` says."
    verdict: { act: 0.8, mark: 0.6 }
  urgent:
    type: noul
    instructions: "Does `request` need somebody to act today?"
    criteria:
      true: "Work, money or customers are blocked, or `request` names a deadline within the day."
      false: "It can wait for the next planning round."
    verdict: { act: 0.85, mark: 0.7 }
  breaks_a_rule:
    type: noul
    instructions: "Does `request` ask for or report something that goes against a policy or a limit stated in `context`?"
    criteria:
      true: "What `request` asks for or reports conflicts with a rule `context` states."
      false: "It sits inside the rules `context` states."
    verdict: { act: 0.9, mark: 0.75 }
---
# escalation-route

## When to use

When a request or an incident report lands in a shared inbox or a channel, to put it in front of the right person on the first hop.

## State

`request`: `{ "from": "...", "subject": "...", "body": "..." }`. `context`: what a reader would need to judge it, such as `{ "policy": "...", "open_incidents": [...] }`. Put the rules the request could break into `context`, because `breaks_a_rule` reads them there.

## Verdicts

`route` with `act`: send it to that destination. `mark`: send it there and copy the shared inbox so a person sees the hop. `fall_back`: leave it in the shared inbox for triage by hand.
`urgent` yes with `act`: page the destination and put the request at the top of its queue.
`breaks_a_rule` yes with `act`: attach the policy line from `context` to the request, so whoever picks it up reads the rule first.

## Example

The example state holds a partner asking for the production database password next week, against a policy that keeps those credentials inside the platform team. It answers `route` = `security`, `urgent` no and `breaks_a_rule` yes.

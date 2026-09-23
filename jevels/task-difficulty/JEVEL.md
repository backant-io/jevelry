---
name: task-difficulty
version: 3
model: jev-1.13.0
state:
  required: [task]
  budget_tokens: 8000
questions:
  depth:
    type: score
    instructions:
      question: "Which of these situations does `task` read like?"
      inspect: "`task.description` and `task.acceptance`"
      focus: "Judge how much of the approach the task leaves for the person who picks it up. How long the work takes stays out of this."
    criteria:
      - what: "The steps are spelled out in the description, or the task repeats work done the same way before"
        signals:
          - "add a flag that prints the same rows as JSON"
          - "same as last month's export"
          - "bump the version and rerun the release script"
      - what: "The task needs a decision between options the description names or leaves open, and any of them would work"
        signals:
          - "in memory or Redis, either is fine"
          - "pick a library for the date parsing"
          - "decide where the setting lives"
      - what: "The approach itself is unknown, or whether it is done depends on something outside the description"
        signals:
          - "nobody knows yet where the records go missing"
          - "done when security signs off"
          - "find out why it is slow"
    thresholds: { act: 0.7, mark: 0.55 }
  needs_specialist:
    type: noul
    instructions:
      question: "Does `task` call for somebody with specific expertise, such as security, databases, infrastructure or a regulated domain?"
      inspect: "`task.title`, `task.description` and `task.acceptance`"
      focus: "Look for a field the task names where a generalist would be guessing. Using a database, a cache or a queue the team already runs is generalist work; designing, securing or operating one is specialist work."
    criteria:
      true:
        what: "The description or the acceptance names a field where a generalist would be guessing"
        examples:
          - "rotate the KMS keys that encrypt customer data"
          - "rewrite the replication setup of the primary database"
          - "the change needs sign-off under the payment card rules"
      false:
        what: "A competent generalist can finish it with what `task` says"
        examples:
          - "add a --json flag to the export command"
          - "cache the product list in memory or in the Redis the team already runs"
    thresholds: { act: 0.85, mark: 0.7 }
  well_specified:
    type: noul
    instructions:
      question: "Does `task.acceptance` say how you would know the task is done?"
      inspect: "`task.acceptance`, with `task.description` for what the checks refer to"
      focus: "Look for a check somebody can run or see: an output, a test, a number or a behaviour."
    criteria:
      true:
        what: "The acceptance names a check somebody can run or see to know the task is done"
        examples:
          - "export --json prints a JSON array with one object per row"
          - "p95 of the product list under 200 ms in the load test"
          - "a unit test covers both paths"
      false:
        what: "The acceptance is empty, restates the title, or leaves done to somebody's taste or approval"
        examples:
          - "onboarding feels better"
          - "security is happy with it"
          - "done when done"
    thresholds: { act: 0.8, mark: 0.6 }
---
# task-difficulty

## When to use

Before you route a task, to send the routine ones to a cheap model or a junior hand and keep the deep ones for a strong model or an experienced person.

## State

`task`: `{ "title": "...", "description": "...", "acceptance": "..." }`. Send the task as it stands in your tracker, so the answers are about the task somebody will actually pick up.

## Decisions

`depth` at level 0 with `act`: route it to the cheap model. Level 2 with `act`: route it to the strong model or to a person. `mark`: route it as the level says and flag it for the person who owns the queue. `fall_back`: route it the way you routed tasks before this jevel.
`needs_specialist` yes with `act`: put it in the specialist queue whatever the depth says. `well_specified` no with `act`: send it back to the author and ask for the missing piece before anybody starts.

## Example

The example state holds a task that adds a `--json` flag to an export command, with acceptance criteria. It answers `depth` at level 0, `needs_specialist` no and `well_specified` yes.
